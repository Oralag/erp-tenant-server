'use strict'

const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { pool, initDb } = require('./db')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const https = require('https')

const app = express()
const PORT = process.env.PORT || 8888

// ─── 微信订阅消息 ─────────────────────────────────────────────────────────────
const WX_APPID = process.env.WX_APPID || 'wxdbe895428fd5c21a'
const WX_APPSECRET = process.env.WX_SECRET || process.env.WX_APPSECRET || ''
// 模板ID（在微信公众平台 → 功能 → 订阅消息 里注册后填入环境变量）
const TMPL_ORDER_SUCCESS = process.env.TMPL_ORDER_SUCCESS || ''  // 购买成功通知
const TMPL_SHIP = process.env.TMPL_SHIP || ''                    // 发货提醒
const TMPL_REFUND = process.env.TMPL_REFUND || ''                // 退款结果通知

let _wxToken = '', _wxTokenExp = 0

async function getWxAccessToken() {
  if (_wxToken && Date.now() < _wxTokenExp) return _wxToken
  if (!WX_APPSECRET) { console.log('WX_APPSECRET not set, skip wx token'); return '' }
  return new Promise((resolve) => {
    https.get(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_APPSECRET}`,
      (res) => {
        let data = ''
        res.on('data', d => data += d)
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (j.access_token) {
              _wxToken = j.access_token
              _wxTokenExp = Date.now() + (j.expires_in - 300) * 1000
              resolve(_wxToken)
            } else {
              console.log('wx token error:', j)
              resolve('')
            }
          } catch { resolve('') }
        })
      }
    ).on('error', (e) => { console.log('wx token fetch error:', e.message); resolve('') })
  })
}

async function sendSubscribeMsg(openid, tmplId, page, data) {
  if (!openid || !tmplId) return
  const token = await getWxAccessToken()
  if (!token) return
  const body = JSON.stringify({ touser: openid, template_id: tmplId, page, data })
  return new Promise((resolve) => {
    const req = https.request(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = ''
        res.on('data', c => d += c)
        res.on('end', () => { console.log('wx subscribe send:', d); resolve() })
      }
    )
    req.on('error', (e) => { console.log('wx subscribe error:', e.message); resolve() })
    req.write(body)
    req.end()
  })
}

async function notifyAdminNewOrder(order, items = []) {
  const key = process.env.SERVER_JIANG_KEY
  if (!key || !order) return
  const address = typeof order.address === 'string'
    ? (() => { try { return JSON.parse(order.address || '{}') } catch { return {} } })()
    : (order.address || {})
  const deliveryLabels = ['物流发货', '跑腿送货', '到店自提']
  const delivery = deliveryLabels[parseInt(order.delivery_type || 0)] || '物流发货'
  const goods = items.map(i => `${i.goods_name}×${i.qty || 1}`).join('、') || '商品'
  const receiver = parseInt(order.delivery_type || 0) === 2
    ? (order.store_name || '到店自提')
    : `${address.name || ''} ${address.phone || ''}`.trim()
  const title = '🔔 小程序新订单'
  const desp = [
    `订单号：${order.order_no}`,
    `实付金额：¥${parseFloat(order.total_amount || order.total || 0).toFixed(2)}`,
    `配送方式：${delivery}`,
    `商品：${goods}`,
    `收货人：${receiver || '未填写'}`,
    '',
    '请登录 ERP → 小程序 → 小程序订单及时处理。',
  ].join('\n')
  try {
    const response = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp }),
    })
    if (!response.ok) console.log('admin order notify failed:', response.status)
  } catch (e) {
    console.log('admin order notify error:', e.message)
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'erp_secret_2024'

app.use(cors())
// verify 钩子把 raw body 保存到 req.rawBody，供 V3 微信回调验签使用
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') }
}))
app.use(express.urlencoded({ extended: true }))

// ─── 表列名缓存（启动后加载，写入时自动过滤非法字段）─────────────────────────
const tableColsCache = {}
async function loadTableCols() {
  const r = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`)
  r.rows.forEach(({ table_name, column_name }) => {
    if (!tableColsCache[table_name]) tableColsCache[table_name] = new Set()
    tableColsCache[table_name].add(column_name)
  })
}
function filterBodyCols(table, body) {
  const allowed = tableColsCache[table]
  if (!allowed) return body
  return Object.fromEntries(Object.entries(body).filter(([k]) => allowed.has(k)))
}

function ok(res, data = {}, message = '') {
  return res.json({ code: 1, data, message })
}

// ─── multi-tenant migration ──────────────────────────────────────────────────

async function migrateMultiTenant() {
  // shops 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL DEFAULT '我的公司',
      contact VARCHAR(50) DEFAULT '',
      mobile VARCHAR(20) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`INSERT INTO shops (id, name) VALUES (1, '默认公司') ON CONFLICT (id) DO NOTHING`)
  await pool.query(`SELECT setval('shops_id_seq', GREATEST(1, (SELECT MAX(id) FROM shops)))`).catch(() => {})

  // admins 加 shop_id
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS shop_id INTEGER NOT NULL DEFAULT 1`)

  // 所有业务表加 shop_id（DEFAULT 1 保证现有数据不丢）
  const tables = [
    'goods','goods_cate','goods_unit','goods_brand','goods_spec',
    'sale_customers','sale_contracts','sale_out_order','sale_return_order','sale_offers','sale_samples',
    'purchase_order','procure_inhouse','procure_return','procure_plan',
    'stock_flow','stock_inventory','warehouses','stock_other_in','stock_other_out','stock_allocation','stock_checks',
    'supplier','bom_order','bom_items',
    'finance_receivable','finance_payable','collect_receipt','pay_receipt',
    'finance_invoices','finance_statements','finance_expenses','finance_funds','finance_costs',
    'prepay_record',
    'retail_orders','retail_members','retail_recharge','retail_stores',
    'depts','roles','jobs','operation_logs','sys_params',
    'company_info',
  ]
  for (const t of tables) {
    await pool.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS shop_id INTEGER NOT NULL DEFAULT 1`).catch(() => {})
  }
}

// 健康检查（含DB诊断）
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

function fail(res, message = '操作失败', status = 200) {
  return res.status(status).json({ code: 0, message })
}

function todayCN(offsetDays = 0) {
  return new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10)
}

function genOrderNo(prefix = 'ORD') {
  const now = new Date()
  const ym =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  const rand = String(Math.floor(Math.random() * 9000) + 1000)
  return prefix + ym + rand
}

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page) || 1)
  const list_rows = Math.max(1, parseInt(query.list_rows) || 20)
  const offset = (page - 1) * list_rows
  return { page, list_rows, offset }
}

function buildKeywordWhere(keyword, columns, paramStart = 1) {
  if (!keyword) return { where: '', params: [], nextParam: paramStart }
  const conditions = columns.map((c) => `${c} ILIKE $${paramStart}`)
  return {
    where: ' AND (' + conditions.join(' OR ') + ')',
    params: [`%${keyword}%`],
    nextParam: paramStart + 1,
  }
}

function shopBase(req, base) {
  const sid = parseInt(req.admin?.shop_id) || 1
  if (!base || base === '1=1') return `shop_id=${sid}`
  return `${base} AND shop_id=${sid}`
}

async function listQuery(res, table, { keyword, keywordCols, extra = '', extraParams = [], baseWhere = 'deleted_at IS NULL', orderBy = 'id DESC', page, list_rows, offset }) {
  const kw = buildKeywordWhere(keyword, keywordCols || [], extraParams.length + 1)
  const where = 'WHERE ' + baseWhere + (extra ? ' AND ' + extra : '') + kw.where
  const allParams = [...extraParams, ...kw.params]
  const countSql = `SELECT COUNT(*) FROM ${table} ${where}`
  const rowsSql = `SELECT * FROM ${table} ${where} ORDER BY ${orderBy} LIMIT $${allParams.length + 1} OFFSET $${allParams.length + 2}`
  const [countResult, rowsResult] = await Promise.all([
    pool.query(countSql, allParams),
    pool.query(rowsSql, [...allParams, list_rows, offset]),
  ])
  return ok(res, {
    rows: rowsResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    list_rows,
  })
}

// ─── auth middleware ────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers['token']
  if (!token) return fail(res, '未登录', 401)
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.admin = decoded
    next()
  } catch {
    return fail(res, 'token无效或已过期', 401)
  }
}

app.use('/adminapi', (req, res, next) => {
  if (req.path.startsWith('/login/')) return next()
  return auth(req, res, next)
})

// ─── login / auth ───────────────────────────────────────────────────────────

app.post('/adminapi/login/register', async (req, res) => {
  try {
    const { account, password, company_name } = req.body
    if (!account || !password) return fail(res, '账号和密码不能为空')
    const exist = await pool.query(`SELECT id FROM admins WHERE account=$1 AND deleted_at IS NULL LIMIT 1`, [account])
    if (exist.rows.length > 0) return fail(res, '账号已存在')
    const shopRes = await pool.query(`INSERT INTO shops (name) VALUES ($1) RETURNING id`, [company_name || account + '的公司'])
    const shopId = shopRes.rows[0].id
    const hashed = await bcrypt.hash(password, 10)
    const userRes = await pool.query(
      `INSERT INTO admins (account, name, password, mobile, status, role_name, shop_id) VALUES ($1,$2,$3,$4,1,'超级管理员',$5) RETURNING id, account, name, shop_id`,
      [account, account, hashed, account, shopId]
    )
    const user = userRes.rows[0]
    const token = jwt.sign({ id: user.id, account: user.account, shop_id: shopId }, JWT_SECRET, { expiresIn: '7d' })
    return ok(res, { token, userInfo: { id: user.id, name: user.name, account: user.account, shop_id: shopId, role_name: '超级管理员', permissions: ['*'] } })
  } catch (e) {
    return fail(res, e.message)
  }
})

app.post('/adminapi/login/account', async (req, res) => {
  try {
    const { account, password } = req.body
    if (!account || !password) return fail(res, '账号和密码不能为空')
    const normalizedAccount = String(account).trim()
    const result = await pool.query(
      `SELECT *
       FROM admins
       WHERE (account=$1 OR mobile=$1) AND deleted_at IS NULL
       ORDER BY CASE WHEN account=$1 THEN 0 ELSE 1 END, id ASC
       LIMIT 1`,
      [normalizedAccount],
    )
    const user = result.rows[0]
    if (!user) return fail(res, '账号不存在')
    // support plain-text legacy passwords and bcrypt
    let valid = false
    if (user.password.startsWith('$2')) {
      valid = await bcrypt.compare(password, user.password)
    } else {
      valid = user.password === password
    }
    if (!valid) return fail(res, '密码错误')
    if (user.status !== 1) return fail(res, '账号已被禁用')
    const token = jwt.sign({ id: user.id, account: user.account, shop_id: user.shop_id || 1 }, JWT_SECRET, { expiresIn: '7d' })
    return ok(res, {
      token,
      userInfo: {
        id: user.id,
        name: user.name,
        account: user.account,
        avatar: user.avatar,
        role_name: user.role_name,
        role_id: user.role_id,
        dept_name: user.dept_name,
        mobile: user.mobile,
        shop_id: user.shop_id || 1,
      },
    })
  } catch (e) {
    return fail(res, e.message)
  }
})

app.post('/adminapi/login/logout', (req, res) => ok(res))

app.get('/adminapi/auth/getUserInfo', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admins WHERE id=$1 AND deleted_at IS NULL', [req.admin.id])
    const user = result.rows[0]
    if (!user) return fail(res, '用户不存在')
    return ok(res, {
      id: user.id,
      name: user.name,
      account: user.account,
      avatar: user.avatar,
      role_name: user.role_name,
      role_id: user.role_id,
      dept_name: user.dept_name,
      mobile: user.mobile,
      permissions: ['*'],
    })
  } catch (e) {
    return fail(res, e.message)
  }
})

app.get('/adminapi/login/info', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admins WHERE id=$1 AND deleted_at IS NULL', [req.admin.id])
    const user = result.rows[0]
    if (!user) return fail(res, '用户不存在')
    return ok(res, {
      id: user.id,
      name: user.name,
      account: user.account,
      avatar: user.avatar,
      role_name: user.role_name,
      permissions: ['*'],
    })
  } catch (e) {
    return fail(res, e.message)
  }
})

// ─── generic CRUD factory ───────────────────────────────────────────────────

function makeCRUD(router, path, table, opts = {}) {
  const {
    keywordCols = ['name'],
    orderBy = 'id DESC',
    softDelete = true,
    extraListWhere = 'deleted_at IS NULL',
  } = opts

  router.get(path + '/index', async (req, res) => {
    try {
      const { page, list_rows, offset } = pageParams(req.query)
      const shopId = parseInt(req.admin?.shop_id) || 1
      const baseWhereWithShop = extraListWhere && extraListWhere !== '1=1'
        ? `${extraListWhere} AND shop_id=${shopId}`
        : `shop_id=${shopId}`
      await listQuery(res, table, {
        keyword: req.query.keyword,
        keywordCols,
        baseWhere: baseWhereWithShop,
        orderBy,
        page,
        list_rows,
        offset,
      })
    } catch (e) {
      return fail(res, e.message)
    }
  })

  router.post(path + '/add', async (req, res) => {
    try {
      const body = filterBodyCols(table, { ...req.body })
      body.shop_id = parseInt(req.admin?.shop_id) || 1
      const cols = Object.keys(body).filter((k) => body[k] !== undefined)
      if (cols.length === 0) {
        return fail(res, '无有效字段')
      }
      const vals = cols.map((k) => body[k])
      const placeholders = cols.map((_, i) => `$${i + 1}`)
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`
      const result = await pool.query(sql, vals)
      return ok(res, result.rows[0])
    } catch (e) {
      return fail(res, e.message)
    }
  })

  router.post(path + '/edit', async (req, res) => {
    try {
      const { id, ...rawRest } = req.body
      if (!id) return fail(res, 'id不能为空')
      const rest = filterBodyCols(table, rawRest)
      const cols = Object.keys(rest).filter((k) => rest[k] !== undefined)
      if (cols.length === 0) return fail(res, '无有效字段')
      const sets = cols.map((k, i) => `${k}=$${i + 1}`)
      const vals = cols.map((k) => rest[k])
      const shopId = parseInt(req.admin?.shop_id) || 1
      // update_time if column exists
      let sql = `UPDATE ${table} SET ${sets.join(',')}`
      try {
        const hasUpdate = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='update_time'`, [table])
        if (hasUpdate.rows.length > 0) sql += `, update_time=NOW()`
      } catch {}
      sql += ` WHERE id=$${vals.length + 1} AND shop_id=$${vals.length + 2} RETURNING *`
      const result = await pool.query(sql, [...vals, id, shopId])
      return ok(res, result.rows[0])
    } catch (e) {
      return fail(res, e.message)
    }
  })

  router.post(path + '/del', async (req, res) => {
    try {
      const { id } = req.body
      if (!id) return fail(res, 'id不能为空')
      const shopId = parseInt(req.admin?.shop_id) || 1
      if (softDelete) {
        await pool.query(`UPDATE ${table} SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2`, [id, shopId])
      } else {
        await pool.query(`DELETE FROM ${table} WHERE id=$1 AND shop_id=$2`, [id, shopId])
      }
      return ok(res)
    } catch (e) {
      return fail(res, e.message)
    }
  })
}

// ─── router setup ───────────────────────────────────────────────────────────

const router = express.Router()
app.use('/adminapi', router)

// ═══════════════════════════════════════════════════════════════════════════
//  GOODS
// ═══════════════════════════════════════════════════════════════════════════

// ShopGoods
// 已知字段白名单（防止前端传入非法列名导致 SQL 报错）
const GOODS_ALLOWED_COLS = new Set([
  'goods_name','goods_sn','en_name','goods_memo','goods_type',
  'cate_id','cate_name','unit_id','unit_name','brand_id','brand_name',
  'spec','sell_price','cost_price','barcode',
  'safe_min','safe_max','sort','make_time',
  'can_sale','can_buy','can_make','can_outsource',
  'multi_unit','multi_spec',
  'stock','min_stock','max_stock',
  'remark','status','images',
])
router.get('/goods/ShopGoods/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods', {
      keyword: req.query.keyword,
      keywordCols: ['goods_name', 'goods_sn'],
      baseWhere: shopBase(req, 'deleted_at IS NULL'),
      orderBy: 'id DESC',
      page, list_rows, offset,
    })
  } catch (e) { fail(res, e.message) }
})
router.get('/goods/ShopGoods/detail', auth, async (req, res) => {
  try {
    const id = parseInt(req.query.id)
    if (!id) return fail(res, 'id required')
    const r = await pool.query('SELECT * FROM goods WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2 LIMIT 1', [id, parseInt(req.admin?.shop_id) || 1])
    if (!r.rows[0]) return fail(res, '商品不存在')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoods/add', async (req, res) => {
  try {
    const body = { ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 }
    const allowedWithShop = new Set([...GOODS_ALLOWED_COLS, 'shop_id'])
    const cols = Object.keys(body).filter(k => allowedWithShop.has(k) && body[k] !== undefined && body[k] !== null && body[k] !== '')
    if (!cols.includes('goods_name') && !body.goods_name) return fail(res, '商品名称不能为空')
    const vals = cols.map(k => body[k])
    const sql = `INSERT INTO goods (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`
    const r = await pool.query(sql, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoods/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => GOODS_ALLOWED_COLS.has(k) && rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const sql = `UPDATE goods SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`
    const r = await pool.query(sql, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
// 安全合并 __brand__ 字段 — 在 JS 层做 merge，避免 remark 非 JSON 时 ::jsonb cast 报错
router.post('/goods/ShopGoods/patchBrand', auth, async (req, res) => {
  try {
    const { id, brand_fields } = req.body
    if (!id) return fail(res, 'id不能为空')
    if (!brand_fields || typeof brand_fields !== 'object') return fail(res, 'brand_fields必须是对象')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const existing = await pool.query('SELECT remark FROM goods WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (!existing.rows[0]) return fail(res, '商品不存在')
    let remarkObj = {}
    try { remarkObj = JSON.parse(existing.rows[0].remark || '{}') } catch {}
    remarkObj.__brand__ = { ...(remarkObj.__brand__ || {}), ...brand_fields }
    const r = await pool.query(
      'UPDATE goods SET remark=$1, update_time=NOW() WHERE id=$2 AND shop_id=$3 RETURNING id, remark',
      [JSON.stringify(remarkObj), id, shopId]
    )
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

router.post('/goods/ShopGoods/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE goods SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopGoodsCate
router.get('/goods/ShopGoodsCate/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_cate', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/add', async (req, res) => {
  try {
    const { name, parent_id = 0, sort = 0, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const dup = await pool.query('SELECT * FROM goods_cate WHERE name=$1 AND parent_id=$2 AND shop_id=$3 LIMIT 1', [name, parent_id, shopId])
    if (dup.rows.length) return ok(res, dup.rows[0])
    const r = await pool.query('INSERT INTO goods_cate (name,parent_id,sort,status,shop_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, parent_id, sort, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/edit', async (req, res) => {
  try {
    const { id, name, parent_id, sort, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE goods_cate SET name=COALESCE($1,name), parent_id=COALESCE($2,parent_id), sort=COALESCE($3,sort), status=COALESCE($4,status) WHERE id=$5 AND shop_id=$6 RETURNING *', [name, parent_id, sort, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    // 同时删除所有子分类（限当前公司）
    await pool.query('DELETE FROM goods_cate WHERE (id=$1 OR parent_id=$1) AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopUnit
router.get('/goods/ShopUnit/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_unit', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/add', async (req, res) => {
  try {
    const { name, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO goods_unit (name,status,shop_id) VALUES ($1,$2,$3) RETURNING *', [name, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/edit', async (req, res) => {
  try {
    const { id, name, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE goods_unit SET name=COALESCE($1,name), status=COALESCE($2,status) WHERE id=$3 AND shop_id=$4 RETURNING *', [name, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM goods_unit WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// GoodsUnitConvert — 商品多单位换算
router.get('/goods/GoodsUnitConvert/index', async (req, res) => {
  try {
    const { goods_id } = req.query
    if (!goods_id) return ok(res, { rows: [], total: 0 })
    const r = await pool.query('SELECT * FROM goods_unit_convert WHERE goods_id=$1 ORDER BY id ASC', [goods_id])
    return ok(res, { rows: r.rows, total: r.rows.length })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/GoodsUnitConvert/save', async (req, res) => {
  // 传入 goods_id + units 数组 [{unit_name, ratio}]，整体覆盖保存
  try {
    const { goods_id, units } = req.body
    if (!goods_id) return fail(res, 'goods_id不能为空')
    await pool.query('DELETE FROM goods_unit_convert WHERE goods_id=$1', [goods_id])
    if (Array.isArray(units) && units.length) {
      for (const u of units) {
        if (u.unit_name && u.ratio > 0) {
          await pool.query('INSERT INTO goods_unit_convert (goods_id,unit_name,ratio) VALUES ($1,$2,$3)', [goods_id, u.unit_name, u.ratio])
        }
      }
    }
    const r = await pool.query('SELECT * FROM goods_unit_convert WHERE goods_id=$1 ORDER BY id ASC', [goods_id])
    return ok(res, { rows: r.rows })
  } catch (e) { fail(res, e.message) }
})

// ShopBrand
router.get('/goods/ShopBrand/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_brand', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/add', async (req, res) => {
  try {
    const { name, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO goods_brand (name,status,shop_id) VALUES ($1,$2,$3) RETURNING *', [name, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/edit', async (req, res) => {
  try {
    const { id, name, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE goods_brand SET name=COALESCE($1,name), status=COALESCE($2,status) WHERE id=$3 AND shop_id=$4 RETURNING *', [name, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM goods_brand WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopSpec
router.get('/goods/ShopSpec/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_spec', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/add', async (req, res) => {
  try {
    const { name, values = '', status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO goods_spec (name,values,status,shop_id) VALUES ($1,$2,$3,$4) RETURNING *', [name, values, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/edit', async (req, res) => {
  try {
    const { id, name, values, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE goods_spec SET name=COALESCE($1,name), values=COALESCE($2,values), status=COALESCE($3,status) WHERE id=$4 AND shop_id=$5 RETURNING *', [name, values, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM goods_spec WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  SALE / SHOP
// ═══════════════════════════════════════════════════════════════════════════

// ShopCustomer
router.get('/shop/ShopCustomer/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_customers', { keyword: req.query.keyword, keywordCols: ['name','mobile','code'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.get('/shop/ShopCustomer/detail', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM sale_customers WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2', [id, shopId])
    if (!r.rows[0]) return fail(res, '客户不存在')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/add', async (req, res) => {
  try {
    const b = req.body
    const filtered = filterBodyCols('sale_customers', { ...b, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(filtered).filter(k => filtered[k] !== undefined && filtered[k] !== null && filtered[k] !== '')
    if (!cols.includes('name') && !b.name) return fail(res, '客户名称不能为空')
    const vals = cols.map(k => filtered[k])
    const r = await pool.query(`INSERT INTO sale_customers (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_customers SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE sale_customers SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query(`UPDATE sale_customers SET deleted_at=NOW() WHERE id=ANY($1) AND shop_id=$2`, [idArr, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ContractOrder (销售合同)
router.get('/shop/ContractOrder/index', async (req, res) => {
  await ensureAdminCols('sale_contracts')
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.customer_name) conditions.push(`customer_name ILIKE '%${req.query.customer_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'sale_contracts', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: shopBase(req, conditions.join(' AND ')), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.get('/shop/ContractOrder/detail', async (req, res) => {
  try {
    const id = parseInt(req.query.id || 0)
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('SELECT * FROM sale_contracts WHERE id=$1 AND deleted_at IS NULL LIMIT 1', [id])
    if (!r.rows[0]) return fail(res, '合同不存在')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/add', async (req, res) => {
  try {
    await ensureAdminCols('sale_contracts')
    await loadTableCols()
    let adminName = ''
    try {
      const a = await pool.query('SELECT name FROM admins WHERE id=$1', [req.admin?.id])
      adminName = a.rows[0]?.name || ''
    } catch {}
    const b = filterBodyCols('sale_contracts', {
      order_no: genOrderNo('XS'),
      order_sn: genOrderNo('XS'),
      ...req.body,
      admin_id: parseInt(req.admin?.id) || 0,
      admin_name: adminName,
      shop_id: parseInt(req.admin?.shop_id) || 1,
    })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO sale_contracts (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_contracts SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const delShopId = parseInt(req.admin?.shop_id) || 1
    // 已审核的合同删除时，同步撤销关联收款单并扣余额（同反审核逻辑）
    const cR = await pool.query('SELECT * FROM sale_contracts WHERE id=$1 AND shop_id=$2', [id, delShopId])
    const contract = cR.rows[0]
    if (contract && Number(contract.status) === 1) {
      const orderSn = contract.order_sn || contract.order_no || ''
      // 删审核自动生成的收款单并扣余额
      if (orderSn) {
        const delR = await pool.query(
          `UPDATE collect_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL AND remark LIKE '%审核自动生成%' RETURNING amount, fund_id`,
          [orderSn]
        )
        for (const r of delR.rows) {
          if (r.fund_id) {
            await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [r.amount, r.fund_id])
          }
        }
      }
      // 删 remark 含 #id 的手动收款单并扣余额
      const manualReceipts = await pool.query(
        `SELECT id, fund_id, amount FROM collect_receipt WHERE remark LIKE $1 AND deleted_at IS NULL`,
        [`%#${id}%`]
      )
      for (const mr of manualReceipts.rows) {
        await pool.query('UPDATE collect_receipt SET deleted_at=NOW() WHERE id=$1', [mr.id])
        if (mr.fund_id && Number(mr.amount)) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [Number(mr.amount), mr.fund_id])
        }
      }
    }
    await pool.query('UPDATE sale_contracts SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, delShopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const isAudit = Number(status ?? 1) === 1

    const shopId = parseInt(req.admin?.shop_id) || 1
    const contractR = await pool.query('SELECT * FROM sale_contracts WHERE id=$1 AND shop_id=$2', [id, shopId])
    const contract = contractR.rows[0]
    if (!contract) return fail(res, '合同不存在')

    const totalAmount = parseFloat(contract.after_discount || contract.total_amount || 0)
    const receiveAmount = parseFloat(contract.receive_amount || 0)
    const receiveAccount = (contract.receive_account || '').trim()
    const customerName = contract.customer_name || ''
    const orderSn = contract.order_sn || contract.order_no || ''
    const signDate = contract.sign_date || contract.create_time || new Date()

    // 审核时必须选收款账户
    if (isAudit && receiveAmount > 0 && !receiveAccount) {
      return fail(res, '请先在合同中选择收款账户再审核')
    }

    // 查找资金账户
    let fundId = 0, fundName = receiveAccount
    if (receiveAccount) {
      const fundR = await pool.query(`SELECT id, name FROM finance_funds WHERE name=$1 AND deleted_at IS NULL LIMIT 1`, [receiveAccount])
      if (fundR.rows[0]) { fundId = fundR.rows[0].id; fundName = fundR.rows[0].name }
    }

    if (isAudit) {
      // 审核：生成收款记录，加余额
      if (receiveAmount > 0) {
        const receiptNo = genOrderNo('SK')
        await pool.query(
          `INSERT INTO collect_receipt (receipt_no, order_sn, pay_type, contact_name, amount, receipt_date, fund_id, fund_name, remark, status, category)
           VALUES ($1,$2,'customer',$3,$4,$5,$6,$7,$8,1,'sale')`,
          [receiptNo, orderSn, customerName, receiveAmount, signDate, fundId, fundName, `合同${orderSn}审核自动生成`]
        )
        if (fundId) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [receiveAmount, fundId])
        }
      }
    } else {
      // 反审核：删收款记录，扣余额
      const delR = await pool.query(
        `UPDATE collect_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL AND remark LIKE '%审核自动生成%' RETURNING amount, fund_id`,
        [orderSn]
      )
      for (const r of delR.rows) {
        if (r.fund_id) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [r.amount, r.fund_id])
        }
      }
      // 额外找出 remark 含 #id 的手动收款单，全部撤销并扣减对应资金账户
      const manualReceipts = await pool.query(
        `SELECT id, fund_id, amount FROM collect_receipt WHERE remark LIKE $1 AND deleted_at IS NULL`,
        [`%#${id}%`]
      )
      for (const mr of manualReceipts.rows) {
        await pool.query('UPDATE collect_receipt SET deleted_at=NOW() WHERE id=$1', [mr.id])
        if (mr.fund_id && Number(mr.amount)) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [Number(mr.amount), mr.fund_id])
        }
      }
    }

    await pool.query('UPDATE sale_contracts SET status=$1 WHERE id=$2 AND shop_id=$3', [status ?? 1, id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// offerOrder (报价单)
router.get('/shop/offerOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_offers', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_offers', { order_no: genOrderNo('BJ'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO sale_offers (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_offers SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE sale_offers SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE sale_offers SET status=$1 WHERE id=$2 AND shop_id=$3', [status ?? 1, id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  STOCK
// ═══════════════════════════════════════════════════════════════════════════

// PurchaseOrder
router.get('/stock/PurchaseOrder/index', async (req, res) => {
  await ensureAdminCols('purchase_order')
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.supplier_name) conditions.push(`supplier_name ILIKE '%${req.query.supplier_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'purchase_order', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: shopBase(req, conditions.join(' AND ')), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/add', async (req, res) => {
  try {
    await ensureAdminCols('purchase_order')
    await loadTableCols()
    let adminName = ''
    try {
      const a = await pool.query('SELECT name FROM admins WHERE id=$1', [req.admin?.id])
      adminName = a.rows[0]?.name || ''
    } catch {}
    const b = filterBodyCols('purchase_order', {
      order_no: genOrderNo('CG'),
      order_sn: genOrderNo('CG'),
      ...req.body,
      admin_id: parseInt(req.admin?.id) || 0,
      admin_name: adminName,
      shop_id: parseInt(req.admin?.shop_id) || 1,
    })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO purchase_order (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE purchase_order SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const delPoShopId = parseInt(req.admin?.shop_id) || 1
    // 已审核的单据删除时，同步撤销关联付款单并还余额（同反审核逻辑）
    const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1 AND shop_id=$2', [id, delPoShopId])
    const po = poR.rows[0]
    if (po && Number(po.status) === 1) {
      const orderNo = po.order_no || ''
      const fundId = po.fund_id ? parseInt(po.fund_id) : 0
      const payAmount = parseFloat(po.pay_amount || 0)
      // 还审核自动生成的付款单余额
      if (fundId && payAmount > 0) {
        await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [payAmount, fundId])
      }
      // 软删 order_sn 匹配的付款单
      if (orderNo) {
        await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL', [orderNo])
      }
      // 软删 remark 含 #id 的手动付款单并还余额
      const manualReceipts = await pool.query(
        `SELECT id, fund_id, amount FROM pay_receipt WHERE remark LIKE $1 AND deleted_at IS NULL`,
        [`%#${id}%`]
      )
      for (const mr of manualReceipts.rows) {
        await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1', [mr.id])
        if (mr.fund_id && Number(mr.amount)) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [Number(mr.amount), mr.fund_id])
        }
      }
    }
    await pool.query('UPDATE purchase_order SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, delPoShopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const isAudit = newStatus === 1

    // 查采购单
    const auditShopId2 = parseInt(req.admin?.shop_id) || 1
    const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1 AND shop_id=$2', [id, auditShopId2])
    const po = poR.rows[0]
    if (!po) return fail(res, '采购单不存在')

    const totalAmount = parseFloat(po.total_amount || 0)
    const payAmount = parseFloat(po.pay_amount || 0)
    const supplierName = po.supplier_name || '未知供应商'
    const orderNo = po.order_no || ''
    const orderDate = po.order_date || new Date()

    const fundId = po.fund_id ? parseInt(po.fund_id) : 0
    const fundName = po.fund_name || ''

    // 审核时必须选择资金账户
    if (isAudit && payAmount > 0 && !fundId) {
      return fail(res, '请先在采购单中选择资金账户再审核')
    }

    if (payAmount > 0) {
      if (isAudit) {
        // 审核：扣减账户余额，生成付款单（先检查是否已存在，防止重复）
        const existCheck = await pool.query('SELECT id FROM pay_receipt WHERE order_sn=$1 AND deleted_at IS NULL LIMIT 1', [orderNo])
        if (existCheck.rows.length === 0) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [payAmount, fundId])
          const receiptNo = genOrderNo('FK')
          await pool.query(
            `INSERT INTO pay_receipt (receipt_no, order_sn, contact_type, contact_name, amount, pay_date, fund_id, fund_name, remark, status, category, shop_id)
             VALUES ($1,$2,'supplier',$3,$4,$5,$6,$7,$8,1,'purchase',$9)`,
            [receiptNo, orderNo, supplierName, payAmount, orderDate, fundId, fundName, `采购单${orderNo}审核自动生成`, auditShopId2]
          )
        }
      } else {
        // 反审核：加回余额，删除对应付款单
        if (fundId) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [payAmount, fundId])
        }
        await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL', [orderNo])
      }
    }

    // 反审核时：额外找出 remark 含 #id 的手动付款单，全部撤销并还款到对应资金账户
    if (!isAudit) {
      const manualReceipts = await pool.query(
        `SELECT id, fund_id, amount FROM pay_receipt WHERE remark LIKE $1 AND deleted_at IS NULL`,
        [`%#${id}%`]
      )
      for (const mr of manualReceipts.rows) {
        await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1', [mr.id])
        if (mr.fund_id && Number(mr.amount)) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [Number(mr.amount), mr.fund_id])
        }
      }
    }

    await pool.query('UPDATE purchase_order SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, auditShopId2])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    const batchPoShopId = parseInt(req.admin?.shop_id) || 1
    // 对每条已审核的采购单，撤销关联付款单并还余额
    for (const id of idArr) {
      const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1 AND shop_id=$2', [id, batchPoShopId])
      const po = poR.rows[0]
      if (po && Number(po.status) === 1) {
        const orderNo = po.order_no || ''
        const fundId = po.fund_id ? parseInt(po.fund_id) : 0
        const payAmount = parseFloat(po.pay_amount || 0)
        if (fundId && payAmount > 0) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [payAmount, fundId])
        }
        if (orderNo) {
          await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL', [orderNo])
        }
        const manualReceipts = await pool.query(
          `SELECT id, fund_id, amount FROM pay_receipt WHERE remark LIKE $1 AND deleted_at IS NULL`,
          [`%#${id}%`]
        )
        for (const mr of manualReceipts.rows) {
          await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1', [mr.id])
          if (mr.fund_id && Number(mr.amount)) {
            await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [Number(mr.amount), mr.fund_id])
          }
        }
      }
    }
    await pool.query(`UPDATE purchase_order SET deleted_at=NOW() WHERE id=ANY($1) AND shop_id=$2`, [idArr, batchPoShopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// SaleOutOrder
router.get('/stock/SaleOutOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.customer_name) conditions.push(`customer_name ILIKE '%${req.query.customer_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'sale_out_order', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: shopBase(req, conditions.join(' AND ')), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_out_order', { order_no: genOrderNo('XC'), order_sn: genOrderNo('XC'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO sale_out_order (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_out_order SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE sale_out_order SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const auditSooShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM sale_out_order WHERE id=$1 AND shop_id=$2', [id, auditSooShopId])
    const order = r.rows[0]
    if (!order) return fail(res, '出库单不存在')
    if (order.status === newStatus) return ok(res)

    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}

    const warehouseId = order.warehouse_id || 0
    const warehouseName = order.warehouse_name || ''
    const orderNo = order.order_no || ''
    const isAudit = newStatus === 1
    const delta = isAudit ? -1 : 1  // 审核扣库存，反审核加回

    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = num * delta

      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      let beforeQty = 0
      if (existing.rows.length > 0) {
        beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
          [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        const afterQtyR = await pool.query('SELECT qty FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
        const afterQty2 = afterQtyR.rows[0] ? parseFloat(afterQtyR.rows[0].qty) : 0
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'sale_out' : 'sale_out_reverse', change, beforeQty, afterQty2, orderNo, isAudit ? '销售出库审核' : '销售出库反审核'])
      }
    }

    await pool.query('UPDATE sale_out_order SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, auditSooShopId])
    return ok(res)
  } catch (e) { console.error('[SaleOutOrder audit error]', e.message); fail(res, e.message) }
})

// SaleReturnOrder
router.get('/stock/SaleReturnOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_return_order', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_return_order', { order_no: genOrderNo('TH'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO sale_return_order (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/edit', async (req, res) => {
  try {
    const { id, ...rawRest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const rest = filterBodyCols('sale_return_order', rawRest)
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k, i) => `${k}=$${i + 1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_return_order SET ${sets.join(',')} WHERE id=$${vals.length + 1} AND shop_id=$${vals.length + 2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM sale_return_order WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const sroShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM sale_return_order WHERE id=$1 AND shop_id=$2', [id, sroShopId])
    const order = r.rows[0]
    if (!order) return fail(res, '退货单不存在')
    if (order.status === newStatus) return ok(res)

    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}

    const warehouseId = order.warehouse_id || 0
    const warehouseName = order.warehouse_name || ''
    const orderNo = order.order_no || ''
    const isAudit = newStatus === 1
    const delta = isAudit ? 1 : -1  // 审核加库存（退货入库），反审核扣回

    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = num * delta

      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      let beforeQty = 0
      if (existing.rows.length > 0) {
        beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
          [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'sale_return' : 'sale_return_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '销售退货审核' : '销售退货反审核'])
      } else if (isAudit && warehouseId) {
        await pool.query('INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', warehouseId, warehouseName, num])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, 'sale_return', num, 0, num, orderNo, '销售退货审核'])
      }
    }

    await pool.query('UPDATE sale_return_order SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, sroShopId])
    return ok(res)
  } catch (e) { console.error('[SaleReturnOrder audit error]', e.message); fail(res, e.message) }
})

// SampleOrder (样品管理)
const SAMPLE_ALLOWED_COLS = new Set([
  'sample_no','sample_type','customer_id','customer_name','contact_name','admin_name',
  'sample_date','return_date','warehouse_id','warehouse_name','goods_info','sample_amount',
  'freight_amount','freight_bearer','courier','tracking_no','receivable_amount',
  'paid_amount','company_cost','receipt_fund_id','receipt_fund_name',
  'expense_payment_status','expense_fund_id','expense_fund_name',
  'other_out_id','receivable_id','receipt_id','expense_id',
  'remark','status','shop_id',
])

function parseGoodsInfo(value) {
  if (Array.isArray(value)) return value
  try { return JSON.parse(value || '[]') } catch { return [] }
}

function calcSampleAmounts(row, goodsInfo = parseGoodsInfo(row.goods_info)) {
  const sampleType = row.sample_type || 'free'
  const sampleAmount = sampleType === 'paid' ? Number(row.sample_amount || 0) : 0
  const freightAmount = Number(row.freight_amount || 0)
  const freightBearer = row.freight_bearer || 'seller'
  const customerFreight = freightBearer === 'buyer' ? freightAmount : freightBearer === 'half' ? freightAmount / 2 : 0
  const companyFreight = freightBearer === 'seller' ? freightAmount : freightBearer === 'half' ? freightAmount / 2 : 0
  const itemCost = goodsInfo.reduce((sum, item) => {
    const price = Number(item.cost_price ?? item.out_price ?? item.price ?? 0)
    return sum + Number(item.num || 0) * price
  }, 0)
  const companySampleCost = sampleType === 'paid' ? 0 : itemCost
  const receivableAmount = Math.max(0, sampleAmount + customerFreight)
  const companyCost = Math.max(0, companySampleCost + companyFreight)
  return { receivableAmount, companyCost }
}

function normalizeSampleBody(body = {}) {
  const normalized = { ...body }
  const intFields = [
    'id',
    'customer_id',
    'warehouse_id',
    'receipt_fund_id',
    'expense_fund_id',
    'other_out_id',
    'receivable_id',
    'receipt_id',
    'expense_id',
    'status',
  ]
  for (const field of intFields) {
    const value = normalized[field]
    if (value === '' || value === null || value === undefined) {
      normalized[field] = field === 'id' ? value : 0
      continue
    }
    const num = Number(value)
    if (!Number.isNaN(num)) normalized[field] = num
  }
  return normalized
}

let sampleTableReady = false
async function ensureSaleSamplesTable() {
  if (sampleTableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_samples (
      id SERIAL PRIMARY KEY,
      sample_no VARCHAR(100) DEFAULT '',
      sample_type VARCHAR(20) DEFAULT 'free',
      customer_id INT DEFAULT 0,
      customer_name VARCHAR(200) DEFAULT '',
      contact_name VARCHAR(100) DEFAULT '',
      admin_name VARCHAR(100) DEFAULT '',
      sample_date DATE,
      return_date DATE,
      warehouse_id INT DEFAULT 0,
      warehouse_name VARCHAR(100) DEFAULT '',
      goods_info JSONB DEFAULT '[]',
      sample_amount DECIMAL(10,2) DEFAULT 0,
      freight_amount DECIMAL(10,2) DEFAULT 0,
      freight_bearer VARCHAR(20) DEFAULT 'seller',
      courier VARCHAR(100) DEFAULT '',
      tracking_no VARCHAR(100) DEFAULT '',
      receivable_amount DECIMAL(10,2) DEFAULT 0,
      paid_amount DECIMAL(10,2) DEFAULT 0,
      company_cost DECIMAL(10,2) DEFAULT 0,
      receipt_fund_id INT DEFAULT 0,
      receipt_fund_name VARCHAR(100) DEFAULT '',
      expense_payment_status VARCHAR(20) DEFAULT 'pending',
      expense_fund_id INT DEFAULT 0,
      expense_fund_name VARCHAR(100) DEFAULT '',
      other_out_id INT DEFAULT 0,
      receivable_id INT DEFAULT 0,
      receipt_id INT DEFAULT 0,
      expense_id INT DEFAULT 0,
      remark TEXT DEFAULT '',
      status INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      deleted_at TIMESTAMP
    );
  `)
  sampleTableReady = true
}

async function applySampleStock(client, order, goodsInfo, direction) {
  const warehouseId = Number(order.warehouse_id || 0)
  const warehouseName = order.warehouse_name || ''
  const orderNo = order.sample_no || ''
  const isAudit = direction === 'audit'
  const delta = isAudit ? -1 : 1
  for (const item of goodsInfo) {
    const goodsId = Number(item.goods_id || 0)
    const num = Number(item.num || 0)
    if (!goodsId || num <= 0) continue
    const change = num * delta
    const existing = await client.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
    if (!existing.rows.length) {
      if (isAudit) {
        await client.query(
          'INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', warehouseId, warehouseName, -num],
        )
        await client.query(
          'INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, 'sample_out', -num, 0, -num, orderNo, '样品出库审核'],
        )
      }
      continue
    }
    const beforeQty = Number(existing.rows[0].qty || 0)
    const afterQty = beforeQty + change
    await client.query(
      'UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
      [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId],
    )
    await client.query(
      'INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'sample_out' : 'sample_out_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '样品出库审核' : '样品出库反审核'],
    )
  }
}

router.get('/shop/SampleOrder/index', async (req, res) => {
  try {
    await ensureSaleSamplesTable()
    const { page, list_rows, offset } = pageParams(req.query)
    const shopId = parseInt(req.admin?.shop_id) || 1
    const conditions = ['deleted_at IS NULL', `shop_id=${shopId}`]
    const params = []
    if (req.query.status !== undefined && req.query.status !== '') {
      params.push(Number(req.query.status))
      conditions.push(`status=$${params.length}`)
    }
    if (req.query.sample_type) {
      params.push(String(req.query.sample_type))
      conditions.push(`sample_type=$${params.length}`)
    }
    if (req.query.customer_name) {
      params.push(`%${String(req.query.customer_name)}%`)
      conditions.push(`customer_name ILIKE $${params.length}`)
    }
    if (req.query.keyword) {
      params.push(`%${String(req.query.keyword)}%`)
      conditions.push(`(sample_no ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR tracking_no ILIKE $${params.length})`)
    }
    const where = `WHERE ${conditions.join(' AND ')}`
    const [countR, rowsR] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM sale_samples ${where}`, params),
      pool.query(`SELECT * FROM sale_samples ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, list_rows, offset]),
    ])
    return ok(res, { rows: rowsR.rows, total: parseInt(countR.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

router.post('/shop/SampleOrder/add', async (req, res) => {
  try {
    await ensureSaleSamplesTable()
    const normalizedBody = normalizeSampleBody(req.body)
    const goodsInfo = parseGoodsInfo(normalizedBody.goods_info)
    const amounts = calcSampleAmounts(normalizedBody, goodsInfo)
    const body = {
      sample_no: genOrderNo('YP'),
      sample_date: new Date().toISOString().slice(0, 10),
      ...normalizedBody,
      goods_info: JSON.stringify(goodsInfo),
      receivable_amount: normalizedBody.receivable_amount ?? amounts.receivableAmount,
      company_cost: normalizedBody.company_cost ?? amounts.companyCost,
      shop_id: parseInt(req.admin?.shop_id) || 1,
    }
    const cols = Object.keys(body).filter(k => SAMPLE_ALLOWED_COLS.has(k) && body[k] !== undefined)
    const vals = cols.map(k => body[k])
    const r = await pool.query(`INSERT INTO sale_samples (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

router.post('/shop/SampleOrder/edit', async (req, res) => {
  try {
    await ensureSaleSamplesTable()
    const { id, ...rest } = normalizeSampleBody(req.body)
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const old = await pool.query('SELECT status FROM sale_samples WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2', [id, shopId])
    if (!old.rows.length) return fail(res, '样品单不存在')
    if (Number(old.rows[0].status) === 1) return fail(res, '已审核样品单不能编辑，请先反审核')
    const goodsInfo = rest.goods_info !== undefined ? parseGoodsInfo(rest.goods_info) : undefined
    const amounts = calcSampleAmounts({ ...rest, goods_info: goodsInfo || [] }, goodsInfo || [])
    const body = {
      ...rest,
      ...(goodsInfo ? { goods_info: JSON.stringify(goodsInfo) } : {}),
      ...(rest.receivable_amount === undefined ? { receivable_amount: amounts.receivableAmount } : {}),
      ...(rest.company_cost === undefined ? { company_cost: amounts.companyCost } : {}),
    }
    const cols = Object.keys(body).filter(k => SAMPLE_ALLOWED_COLS.has(k) && body[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const vals = cols.map(k => body[k])
    const sets = cols.map((k, i) => `${k}=$${i + 1}`).join(',')
    const r = await pool.query(`UPDATE sale_samples SET ${sets}, updated_at=NOW() WHERE id=$${vals.length + 1} AND shop_id=$${vals.length + 2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

router.post('/shop/SampleOrder/del', async (req, res) => {
  try {
    await ensureSaleSamplesTable()
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT status FROM sale_samples WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2', [id, shopId])
    if (Number(r.rows[0]?.status) === 1) return fail(res, '请先反审核再删除')
    await pool.query('UPDATE sale_samples SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

router.post('/shop/SampleOrder/audit', async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureSaleSamplesTable()
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    await client.query('BEGIN')
    const auditShopId = parseInt(req.admin?.shop_id) || 1
    const r = await client.query('SELECT * FROM sale_samples WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2 FOR UPDATE', [id, auditShopId])
    const sample = r.rows[0]
    if (!sample) throw new Error('样品单不存在')
    if (Number(sample.status) === Number(newStatus)) {
      await client.query('COMMIT')
      return ok(res, sample)
    }
    if (Number(newStatus) === 1) {
      const goodsInfo = parseGoodsInfo(sample.goods_info)
      const amounts = calcSampleAmounts(sample, goodsInfo)
      const otherOut = await client.query(
        `INSERT INTO stock_other_out (order_no, warehouse_id, warehouse_name, goods_info, remark, status, shop_id)
         VALUES ($1,$2,$3,$4,$5,1,$6) RETURNING *`,
        [sample.sample_no, sample.warehouse_id || 0, sample.warehouse_name || '', JSON.stringify(goodsInfo), `样品出库：${sample.customer_name || sample.contact_name || ''}`, auditShopId],
      )
      await applySampleStock(client, sample, goodsInfo, 'audit')

      let receivableId = 0
      let receiptId = 0
      const receivableAmount = Number(sample.receivable_amount || amounts.receivableAmount || 0)
      const paidAmount = Math.min(Number(sample.paid_amount || 0), receivableAmount)
      const unpaidAmount = Math.max(0, receivableAmount - paidAmount)
      if (paidAmount > 0 && !Number(sample.receipt_fund_id || 0)) {
        throw new Error('已收金额大于0时必须选择收款账户')
      }
      if (receivableAmount > 0) {
        const rec = await client.query(
          `INSERT INTO finance_receivable (customer_id, customer_name, order_sn, total_amount, paid_amount, un_pay_amount, due_date, status, shop_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [sample.customer_id || 0, sample.customer_name || '', sample.sample_no || '', receivableAmount, paidAmount, unpaidAmount, sample.sample_date || null, unpaidAmount > 0 ? 0 : 1, auditShopId],
        )
        receivableId = rec.rows[0].id
      }
      if (paidAmount > 0) {
        const receipt = await client.query(
          `INSERT INTO collect_receipt (receipt_no, order_sn, customer_id, customer_name, amount, receipt_date, pay_type, fund_id, fund_name, remark, status, shop_id)
           VALUES ($1,$2,$3,$4,$5,$6,'customer',$7,$8,$9,1,$10) RETURNING *`,
          [
            genOrderNo('SK'),
            sample.sample_no || '',
            sample.customer_id || 0,
            sample.customer_name || '',
            paidAmount,
            sample.sample_date || null,
            Number(sample.receipt_fund_id || 0),
            sample.receipt_fund_name || '',
            '样品单收款自动生成',
            auditShopId,
          ],
        )
        receiptId = receipt.rows[0].id
        await client.query(
          'UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2',
          [paidAmount, Number(sample.receipt_fund_id || 0)],
        )
      }

      let expenseId = 0
      const companyCost = Number(sample.company_cost || amounts.companyCost || 0)
      if (companyCost > 0) {
        const expensePaid = (sample.expense_payment_status || 'pending') === 'paid'
        if (expensePaid && !Number(sample.expense_fund_id || 0)) {
          throw new Error('公司费用选择已付款时必须选择付款账户')
        }
        const expenseRemark = `${expensePaid ? '【已付款】' : '【待付款】'} 样品单 ${sample.sample_no} 自动生成`
        const exp = await client.query(
          `INSERT INTO finance_expenses (expense_no, name, amount, expense_date, fund_id, fund_name, remark, status, shop_id)
           VALUES ($1,'样品费用',$2,$3,$4,$5,$6,1,$7) RETURNING *`,
          [
            genOrderNo('FY'),
            companyCost,
            sample.sample_date || null,
            expensePaid ? Number(sample.expense_fund_id || 0) : 0,
            expensePaid ? (sample.expense_fund_name || '') : '',
            expenseRemark,
            auditShopId,
          ],
        )
        expenseId = exp.rows[0].id
        if (expensePaid) {
          await client.query(
            'UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2',
            [companyCost, Number(sample.expense_fund_id || 0)],
          )
        }
      }
      const updated = await client.query(
        `UPDATE sale_samples
         SET status=1, other_out_id=$1, receivable_id=$2, receipt_id=$3, expense_id=$4,
             receivable_amount=$5, company_cost=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [otherOut.rows[0].id, receivableId, receiptId, expenseId, receivableAmount, companyCost, id],
      )
      await client.query('COMMIT')
      return ok(res, updated.rows[0])
    }

    if (Number(newStatus) === 0 && Number(sample.status) === 1) {
      const goodsInfo = parseGoodsInfo(sample.goods_info)
      await applySampleStock(client, sample, goodsInfo, 'reverse')
      if (sample.other_out_id) await client.query('UPDATE stock_other_out SET status=0 WHERE id=$1', [sample.other_out_id])
      if (sample.receivable_id) await client.query('DELETE FROM finance_receivable WHERE id=$1', [sample.receivable_id])
      if (sample.receipt_id) {
        const receipt = await client.query('SELECT amount, fund_id FROM collect_receipt WHERE id=$1', [sample.receipt_id])
        await client.query('UPDATE collect_receipt SET deleted_at=NOW() WHERE id=$1', [sample.receipt_id])
        if (receipt.rows[0]?.fund_id && Number(receipt.rows[0]?.amount)) {
          await client.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(receipt.rows[0].amount), receipt.rows[0].fund_id])
        }
      }
      if (sample.expense_id) {
        const expense = await client.query('SELECT amount, fund_id FROM finance_expenses WHERE id=$1', [sample.expense_id])
        await client.query('DELETE FROM finance_expenses WHERE id=$1', [sample.expense_id])
        if (expense.rows[0]?.fund_id && Number(expense.rows[0]?.amount)) {
          await client.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(expense.rows[0].amount), expense.rows[0].fund_id])
        }
      }
      const updated = await client.query(
        `UPDATE sale_samples
         SET status=0, other_out_id=0, receivable_id=0, receipt_id=0, expense_id=0, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [id],
      )
      await client.query('COMMIT')
      return ok(res, updated.rows[0])
    }

    const updated = await client.query('UPDATE sale_samples SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [newStatus, id])
    await client.query('COMMIT')
    return ok(res, updated.rows[0])
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[SampleOrder audit error]', e.message)
    fail(res, e.message)
  } finally {
    client.release()
  }
})

// StockAll (库存汇总)
router.get('/stock/StockAll/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const keyword = req.query.keyword
    const shopId = parseInt(req.admin?.shop_id) || 1
    let where = `WHERE shop_id=${shopId}`
    const params = []
    if (keyword) {
      params.push(`%${keyword}%`)
      where += ` AND (goods_name ILIKE $1 OR goods_code ILIKE $1)`
    }
    const countR = await pool.query(`SELECT COUNT(*) FROM stock_inventory ${where}`, params)
    const rowsR = await pool.query(`SELECT * FROM stock_inventory ${where} ORDER BY id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, list_rows, offset])
    return ok(res, { rows: rowsR.rows, total: parseInt(countR.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

// InOutFlow (出入库流水)
router.get('/stock/InOutFlow/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_flow', { keyword: req.query.keyword, keywordCols: ['goods_name','order_no'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// StockWarning (库存预警)
router.get('/stock/StockWarning/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const keyword = req.query.keyword
    let where = `WHERE g.deleted_at IS NULL AND si.qty <= g.min_stock`
    const params = []
    if (keyword) {
      params.push(`%${keyword}%`)
      where += ` AND (g.name ILIKE $1 OR g.code ILIKE $1)`
    }
    const sql = `SELECT g.id, g.name, g.code, g.min_stock, g.max_stock, COALESCE(si.qty,0) AS qty, si.warehouse_name FROM goods g LEFT JOIN stock_inventory si ON g.id=si.goods_id ${where} ORDER BY g.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`
    const countSql = `SELECT COUNT(*) FROM goods g LEFT JOIN stock_inventory si ON g.id=si.goods_id ${where}`
    const [countR, rowsR] = await Promise.all([pool.query(countSql, params), pool.query(sql, [...params, list_rows, offset])])
    return ok(res, { rows: rowsR.rows, total: parseInt(countR.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

// WarehouseName
router.get('/stock/WarehouseName/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'warehouses', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/add', async (req, res) => {
  try {
    const { name, address = '', remark = '', status = 1 } = req.body
    if (!name) return fail(res, '仓库名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO warehouses (name,address,remark,status,shop_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, address, remark, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/edit', async (req, res) => {
  try {
    const { id, name, address, remark, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE warehouses SET name=COALESCE($1,name), address=COALESCE($2,address), remark=COALESCE($3,remark), status=COALESCE($4,status) WHERE id=$5 AND shop_id=$6 RETURNING *', [name, address, remark, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM warehouses WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// OtherIn (其他入库)
router.get('/stock/OtherIn/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_other_in', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherIn/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_other_in', { order_no: genOrderNo('RK'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO stock_other_in (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherIn/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM stock_other_in WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherIn/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const oiAuditShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM stock_other_in WHERE id=$1 AND shop_id=$2', [id, oiAuditShopId])
    const order = r.rows[0]
    if (!order) return fail(res, '入库单不存在')
    if (order.status === newStatus) return ok(res)
    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}
    const warehouseId = order.warehouse_id || 0
    const warehouseName = order.warehouse_name || ''
    const orderNo = order.order_no || ''
    const isAudit = newStatus === 1
    const delta = isAudit ? 1 : -1
    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = num * delta
      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      let beforeQty = 0
      if (existing.rows.length > 0) {
        beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
          [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'other_in' : 'other_in_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '其他入库审核' : '其他入库反审核'])
      } else if (isAudit) {
        await pool.query('INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', warehouseId, warehouseName, num])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, 'other_in', num, 0, num, orderNo, '其他入库审核'])
      }
    }
    const oiShopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE stock_other_in SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, oiShopId])
    return ok(res)
  } catch (e) { console.error('[OtherIn audit error]', e.message); fail(res, e.message) }
})

// OtherOut (其他出库)
router.get('/stock/OtherOut/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_other_out', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_other_out', { order_no: genOrderNo('CK'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO stock_other_out (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
// 撤销出库单：直接恢复库存 + 删除所有相关流水 + 删除单据，不产生任何新流水记录
router.post('/stock/OtherOut/annul', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const annulShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM stock_other_out WHERE id=$1 AND shop_id=$2', [id, annulShopId])
    const order = r.rows[0]
    if (!order) return ok(res) // 已不存在，幂等
    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}
    const warehouseId = order.warehouse_id || 0
    const orderNo = order.order_no || ''
    // 若已审核，直接加回库存（不走 audit 接口，避免产生反向流水）
    if (Number(order.status) === 1) {
      for (const item of goodsInfo) {
        const goodsId = item.goods_id || 0
        const num = parseFloat(item.num) || 0
        if (!goodsId || num <= 0) continue
        await pool.query(
          'UPDATE stock_inventory SET qty=qty+$1, update_time=NOW() WHERE goods_id=$2 AND warehouse_id=$3',
          [num, goodsId, warehouseId]
        )
      }
    }
    // 删除所有关联流水（order_no 匹配）
    if (orderNo) await pool.query('DELETE FROM stock_flow WHERE order_no=$1', [orderNo])
    // 删除单据
    await pool.query('DELETE FROM stock_other_out WHERE id=$1 AND shop_id=$2', [id, annulShopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM stock_other_out WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const ooAuditShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM stock_other_out WHERE id=$1 AND shop_id=$2', [id, ooAuditShopId])
    const order = r.rows[0]
    if (!order) return fail(res, '出库单不存在')
    if (order.status === newStatus) return ok(res)
    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}
    const warehouseId = order.warehouse_id || 0
    const warehouseName = order.warehouse_name || ''
    const orderNo = order.order_no || ''
    const isAudit = newStatus === 1
    const delta = isAudit ? -1 : 1  // 出库审核扣库存，反审核加回
    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = num * delta
      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      let beforeQty = 0
      if (existing.rows.length > 0) {
        beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
          [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'other_out' : 'other_out_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '其他出库审核' : '其他出库反审核'])
      }
    }
    const ooShopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE stock_other_out SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, ooShopId])
    return ok(res)
  } catch (e) { console.error('[OtherOut audit error]', e.message); fail(res, e.message) }
})

// Allocation (调拨管理)
router.get('/stock/Allocation/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_allocation', { keyword: req.query.keyword, keywordCols: ['transfer_no','from_warehouse','to_warehouse'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_allocation', { transfer_no: genOrderNo('DB'), status: 0, ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    if (b.goods_info && typeof b.goods_info !== 'string') b.goods_info = JSON.stringify(b.goods_info)
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO stock_allocation (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const b = filterBodyCols('stock_allocation', rest)
    if (b.goods_info && typeof b.goods_info !== 'string') b.goods_info = JSON.stringify(b.goods_info)
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    await pool.query(`UPDATE stock_allocation SET ${cols.map((c,i)=>`${c}=$${i+1}`)} WHERE id=$${cols.length+1} AND shop_id=$${cols.length+2}`, [...vals, id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const allocAuditShopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM stock_allocation WHERE id=$1 AND shop_id=$2', [id, allocAuditShopId])
    const order = r.rows[0]
    if (!order) return fail(res, '调拨单不存在')
    if (order.status === newStatus) return ok(res)

    let goodsInfo = []
    try { goodsInfo = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info) : (order.goods_info || []) } catch {}

    const fromId = order.from_warehouse_id || 0
    const fromName = order.from_warehouse || ''
    const toId = order.to_warehouse_id || 0
    const toName = order.to_warehouse || ''
    const transferNo = order.transfer_no || ''
    const isAudit = newStatus === 1

    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue

      // 调出仓库：审核减库存，反审核加回
      if (fromId) {
        const ex = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, fromId])
        let beforeQty = 0
        if (ex.rows.length > 0) {
          beforeQty = parseFloat(ex.rows[0].qty) || 0
          const afterQty = isAudit ? Math.max(0, beforeQty - num) : beforeQty + num
          await pool.query('UPDATE stock_inventory SET qty=$1, update_time=NOW() WHERE goods_id=$2 AND warehouse_id=$3', [afterQty, goodsId, fromId])
          await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [goodsId, item.goods_name || '', fromId, fromName, isAudit ? 'allot_out' : 'allot_out_reverse', isAudit ? -num : num, beforeQty, afterQty, transferNo, isAudit ? '调拨调出' : '调拨调出反审核'])
        }
      }

      // 调入仓库：审核加库存，反审核减回
      if (toId) {
        const ex2 = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, toId])
        let beforeQty2 = 0
        if (ex2.rows.length > 0) {
          beforeQty2 = parseFloat(ex2.rows[0].qty) || 0
          const afterQty2 = isAudit ? beforeQty2 + num : Math.max(0, beforeQty2 - num)
          await pool.query('UPDATE stock_inventory SET qty=$1, update_time=NOW() WHERE goods_id=$2 AND warehouse_id=$3', [afterQty2, goodsId, toId])
          await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [goodsId, item.goods_name || '', toId, toName, isAudit ? 'allot_in' : 'allot_in_reverse', isAudit ? num : -num, beforeQty2, isAudit ? beforeQty2 + num : Math.max(0, beforeQty2 - num), transferNo, isAudit ? '调拨调入' : '调拨调入反审核'])
        } else if (isAudit) {
          await pool.query('INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', toId, toName, num])
          await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [goodsId, item.goods_name || '', toId, toName, 'allot_in', num, 0, num, transferNo, '调拨调入'])
        }
      }
    }

    const allocShopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE stock_allocation SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, allocShopId])
    return ok(res)
  } catch (e) { console.error('[Allocation audit error]', e.message); fail(res, e.message) }
})
router.post('/stock/Allocation/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM stock_allocation WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query(`DELETE FROM stock_allocation WHERE id=ANY($1) AND shop_id=$2`, [ids, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// StockCheck (盘点)
router.get('/stock/StockCheck/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_checks', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/StockCheck/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_checks', { order_no: genOrderNo('PD'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO stock_checks (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/StockCheck/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM stock_checks WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  PROCURE
// ═══════════════════════════════════════════════════════════════════════════

// supplier
router.get('/procure/supplier/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'supplier', { keyword: req.query.keyword, keywordCols: ['name','mobile'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/supplier/add', async (req, res) => {
  try {
    const b = filterBodyCols('supplier', { ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined && b[k] !== null)
    if (!b.name) return fail(res, '供应商名称不能为空')
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO supplier (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/supplier/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const r = await pool.query(`UPDATE supplier SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/supplier/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE supplier SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ProcurePlan
router.get('/procure/ProcurePlan/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'procure_plan', { keyword: req.query.keyword, keywordCols: ['order_no','admin_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcurePlan/add', async (req, res) => {
  try {
    const b = filterBodyCols('procure_plan', { order_no: genOrderNo('JH'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO procure_plan (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcurePlan/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE procure_plan SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcurePlan/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const ppShopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE procure_plan SET status=$1 WHERE id=$2 AND shop_id=$3', [status ?? 1, id, ppShopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ProcureInhouse (采购入库)
router.get('/procure/ProcureInhouse/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    // 支持按 purchase_order_id 或 order_id 过滤
    const orderId = req.query.purchase_order_id || req.query.order_id
    const extraWhere = orderId ? ` AND purchase_order_id=$1` : ''
    const extraParams = orderId ? [parseInt(orderId)] : []
    await listQuery(res, 'procure_inhouse', { keyword: req.query.keyword, keywordCols: ['order_no','supplier_name'], baseWhere: shopBase(req, `deleted_at IS NULL${extraWhere}`), extraParams, orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/add', async (req, res) => {
  try {
    // 前端传 order_id，表字段是 purchase_order_id，做映射
    const body = { ...req.body }
    if (body.order_id && !body.purchase_order_id) { body.purchase_order_id = body.order_id; delete body.order_id }
    const b = filterBodyCols('procure_inhouse', { order_no: genOrderNo('CGRK'), ...body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO procure_inhouse (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/edit', async (req, res) => {
  try {
    const { id, ...rawRest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const rest = filterBodyCols('procure_inhouse', rawRest)
    const cols = Object.keys(rest).filter((k) => rest[k] !== undefined)
    if (cols.length === 0) return fail(res, '无有效字段')
    const sets = cols.map((k, i) => `${k}=$${i + 1}`)
    const vals = cols.map((k) => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const sql = `UPDATE procure_inhouse SET ${sets.join(',')} WHERE id=$${vals.length + 1} AND shop_id=$${vals.length + 2} RETURNING *`
    const result = await pool.query(sql, [...vals, id, shopId])
    return ok(res, result.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE procure_inhouse SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const piShopId = parseInt(req.admin?.shop_id) || 1

    // 查入库单
    const inhouseR = await pool.query('SELECT * FROM procure_inhouse WHERE id=$1 AND shop_id=$2', [id, piShopId])
    const inhouse = inhouseR.rows[0]
    if (!inhouse) return fail(res, '入库单不存在')

    const prevStatus = inhouse.status
    // 状态无变化，直接返回
    if (prevStatus === newStatus) { await pool.query('UPDATE procure_inhouse SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, piShopId]); return ok(res) }

    let goodsInfo = []
    try { goodsInfo = typeof inhouse.goods_info === 'string' ? JSON.parse(inhouse.goods_info) : (inhouse.goods_info || []) } catch {}

    const warehouseId = inhouse.warehouse_id || 0
    const warehouseName = inhouse.warehouse_name || ''
    const orderNo = inhouse.order_no || ''

    // 审核通过(1)：库存增加；反审核(0)：库存减少
    const isAudit = newStatus === 1
    const delta = isAudit ? 1 : -1

    for (const item of goodsInfo) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = Math.round(parseFloat(item.num) || 0)
      if (num <= 0) continue
      const change = num * delta

      // upsert stock_inventory
      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      let beforeQty = 0
      if (existing.rows.length > 0) {
        beforeQty = Math.round(parseFloat(existing.rows[0].qty) || 0)
        const afterQty = Math.round(beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5',
          [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
      } else if (isAudit) {
        await pool.query('INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', warehouseId, warehouseName, change])
      }

      // 写 stock_flow 流水
      const afterQty2R = await pool.query('SELECT qty FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      const afterQty2 = afterQty2R.rows[0] ? parseFloat(afterQty2R.rows[0].qty) : 0
      await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'procure_in' : 'procure_in_reverse', change, beforeQty, afterQty2, orderNo, isAudit ? '采购入库审核' : '采购入库反审核'])
    }

    await pool.query('UPDATE procure_inhouse SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, piShopId])
    return ok(res)
  } catch (e) { console.error('[ProcureInhouse audit error]', e.message); fail(res, e.message) }
})

// ProcureReturn (采购退货)
router.get('/procure/ProcureReturn/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'procure_return', { keyword: req.query.keyword, keywordCols: ['order_no','supplier_name'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureReturn/add', async (req, res) => {
  try {
    const b = filterBodyCols('procure_return', { order_no: genOrderNo('CGTH'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO procure_return (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureReturn/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    // 已审核的退货单删除时，撤销库存和资金变动
    const retR = await pool.query('SELECT * FROM procure_return WHERE id=$1 AND shop_id=$2', [id, shopId])
    const ret = retR.rows[0]
    if (ret && Number(ret.status) === 1) {
      let goodsInfo = []
      try { goodsInfo = typeof ret.goods_info === 'string' ? JSON.parse(ret.goods_info) : (ret.goods_info || []) } catch {}
      const meta = goodsInfo.find(i => i._meta) || {}
      const items = goodsInfo.filter(i => !i._meta)
      const fundId = meta.fund_id || ret.fund_id || 0
      const totalAmount = parseFloat(meta.total_amount || ret.total_amount || 0)
      const orderTotalAmount = parseFloat(meta.order_total_amount || 0)
      const orderPayAmount = parseFloat(meta.order_pay_amount || 0)
      // 加回库存
      for (const item of items) {
        if (!item.goods_id || !item.num) continue
        await pool.query('UPDATE stock_inventory SET qty=qty+$1, update_time=NOW() WHERE goods_id=$2', [parseFloat(item.num), item.goods_id])
      }
      // 扣回已退款到账户的金额
      if (fundId && totalAmount > 0) {
        const unpaid = Math.max(0, orderTotalAmount - orderPayAmount)
        const refund = Math.max(0, totalAmount - unpaid)
        if (refund > 0) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [refund, fundId])
        }
      }
    }
    await pool.query('DELETE FROM procure_return WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureReturn/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')

    const retR = await pool.query('SELECT * FROM procure_return WHERE id=$1 AND shop_id=$2', [id, prShopId])
    const ret = retR.rows[0]
    if (!ret) return fail(res, '退货单不存在')

    let goodsInfo = []
    try { goodsInfo = typeof ret.goods_info === 'string' ? JSON.parse(ret.goods_info) : (ret.goods_info || []) } catch {}
    const meta = goodsInfo.find(i => i._meta) || {}
    const items = goodsInfo.filter(i => !i._meta)
    const fundId = meta.fund_id || ret.fund_id || 0
    const totalAmount = parseFloat(meta.total_amount || ret.total_amount || 0)
    const orderTotalAmount = parseFloat(meta.order_total_amount || 0)
    const orderPayAmount = parseFloat(meta.order_pay_amount || 0)

    console.log('[ProcureReturn audit]', { id, status, fundId, totalAmount, itemsCount: items.length, meta })

    if (status === 1) {
      // 扣减库存：不限仓库，直接按 goods_id 更新所有匹配行
      for (const item of items) {
        if (!item.goods_id || !item.num) continue
        const num = parseFloat(item.num)
        const beforeR = await pool.query('SELECT qty, warehouse_id, warehouse_name FROM stock_inventory WHERE goods_id=$1 LIMIT 1', [item.goods_id])
        const beforeQty = beforeR.rows[0] ? parseFloat(beforeR.rows[0].qty) : 0
        const wId = beforeR.rows[0]?.warehouse_id || 0
        const wName = beforeR.rows[0]?.warehouse_name || ''
        await pool.query('UPDATE stock_inventory SET qty=GREATEST(0, qty-$1), update_time=NOW() WHERE goods_id=$2', [num, item.goods_id])
        const afterQty = Math.max(0, beforeQty - num)
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [item.goods_id, item.goods_name || '', wId, wName, 'procure_return', -num, beforeQty, afterQty, ret.order_no || '', '采购退货审核'])
        console.log('[stock deduct]', item.goods_id, item.num)
      }
      // 退款到资金账户
      if (fundId && totalAmount > 0) {
        const unpaid = Math.max(0, orderTotalAmount - orderPayAmount)
        const refund = Math.max(0, totalAmount - unpaid)
        console.log('[fund refund]', { fundId, totalAmount, unpaid, refund })
        if (refund > 0) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [refund, fundId])
        }
      }
    }

    if (status === 0) {
      // 加回库存
      for (const item of items) {
        if (!item.goods_id || !item.num) continue
        const num = parseFloat(item.num)
        const beforeR = await pool.query('SELECT qty, warehouse_id, warehouse_name FROM stock_inventory WHERE goods_id=$1 LIMIT 1', [item.goods_id])
        const beforeQty = beforeR.rows[0] ? parseFloat(beforeR.rows[0].qty) : 0
        const wId = beforeR.rows[0]?.warehouse_id || 0
        const wName = beforeR.rows[0]?.warehouse_name || ''
        await pool.query('UPDATE stock_inventory SET qty=qty+$1, update_time=NOW() WHERE goods_id=$2', [num, item.goods_id])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [item.goods_id, item.goods_name || '', wId, wName, 'procure_return_reverse', num, beforeQty, beforeQty + num, ret.order_no || '', '采购退货反审核'])
      }
      // 从资金账户扣回退款
      if (fundId && totalAmount > 0) {
        const unpaid = Math.max(0, orderTotalAmount - orderPayAmount)
        const refund = Math.max(0, totalAmount - unpaid)
        if (refund > 0) {
          await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [refund, fundId])
        }
      }
    }

    const prShopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE procure_return SET status=$1 WHERE id=$2 AND shop_id=$3', [status ?? 1, id, prShopId])
    return ok(res)
  } catch (e) { console.error('[ProcureReturn audit error]', e.message); fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  FINANCE
// ═══════════════════════════════════════════════════════════════════════════

// CollectAccounts (应收账款)
router.get('/finance/CollectAccounts/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_receivable', { keyword: req.query.keyword, keywordCols: ['customer_name','order_sn'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// PayAccounts (应付账款)
router.get('/finance/PayAccounts/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_payable', { keyword: req.query.keyword, keywordCols: ['supplier_name','order_sn'], baseWhere: shopBase(req), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// CollectReceipt (收款单)
router.post('/finance/CollectReceipt/edit', async (req, res) => {
  try {
    const { id, ...fields } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const cols = Object.keys(fields)
    if (!cols.length) return fail(res, '无更新字段')
    const sets = cols.map((k, i) => `${k}=$${i + 2}`).join(',')
    const vals = [id, ...cols.map(k => fields[k]), shopId]
    const r = await pool.query(`UPDATE collect_receipt SET ${sets} WHERE id=$1 AND shop_id=$${vals.length} RETURNING *`, vals)
    ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.get('/finance/CollectReceipt/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'collect_receipt', { keyword: req.query.keyword, keywordCols: ['receipt_no','customer_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/CollectReceipt/add', async (req, res) => {
  try {
    const shopId = parseInt(req.admin?.shop_id) || 1
    const b = filterBodyCols('collect_receipt', { receipt_no: genOrderNo('SK'), ...req.body, shop_id: shopId })
    // 防重复：同一客户+同一金额+同一销售单已存在则拒绝
    const custName = b.customer_name || b.contact_name || ''
    const receiptDate = b.receipt_date ? String(b.receipt_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
    const amount = Number(b.amount || 0)
    const orderSn = b.order_sn || ''
    if (custName && amount > 0 && orderSn) {
      const dupCheck = await pool.query(
        `SELECT id, receipt_no FROM collect_receipt WHERE contact_name=$1 AND amount=$2 AND order_sn=$3 AND deleted_at IS NULL AND shop_id=$4 LIMIT 1`,
        [custName, amount, orderSn, shopId]
      )
      if (dupCheck.rows.length > 0) {
        return fail(res, `重复收款：该客户"${custName}"的销售单${orderSn}已有一笔相同金额¥${amount}的收款单（单号${dupCheck.rows[0].receipt_no}），请勿重复提交`)
      }
    }
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO collect_receipt (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    // 同步资金账户余额
    if (b.fund_id && Number(b.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(b.amount), b.fund_id])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/CollectReceipt/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT fund_id, amount FROM collect_receipt WHERE id=$1 AND shop_id=$2', [id, shopId])
    await pool.query('UPDATE collect_receipt SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// PayReceipt (付款单)
router.get('/finance/PayReceipt/index', async (req, res) => {
  await ensureAdminCols('pay_receipt')
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'pay_receipt', { keyword: req.query.keyword, keywordCols: ['receipt_no','contact_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/PayReceipt/add', async (req, res) => {
  try {
    await ensureAdminCols('pay_receipt')
    await loadTableCols()
    const shopId = parseInt(req.admin?.shop_id) || 1
    let adminName = ''
    try {
      const a = await pool.query('SELECT name FROM admins WHERE id=$1', [req.admin?.id])
      adminName = a.rows[0]?.name || ''
    } catch {}
    const b = filterBodyCols('pay_receipt', {
      receipt_no: genOrderNo('FK'),
      ...req.body,
      admin_id: parseInt(req.admin?.id) || 0,
      admin_name: adminName,
      shop_id: shopId,
    })
    // 防重复：同一供应商+同一金额+同一天+同一采购单已存在则拒绝
    const supName = b.supplier_name || b.contact_name || ''
    const payDate = b.pay_date ? String(b.pay_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
    const amount = Number(b.amount || 0)
    const orderSn = b.order_sn || ''
    if (supName && amount > 0 && orderSn) {
      const dupCheck = await pool.query(
        `SELECT id, receipt_no FROM pay_receipt WHERE contact_name=$1 AND amount=$2 AND order_sn=$3 AND deleted_at IS NULL AND shop_id=$4 LIMIT 1`,
        [supName, amount, orderSn, shopId]
      )
      if (dupCheck.rows.length > 0) {
        return fail(res, `重复付款：该供应商"${supName}"的采购单${orderSn}已有一笔相同金额¥${amount}的付款单（单号${dupCheck.rows[0].receipt_no}），请勿重复提交`)
      }
    }
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO pay_receipt (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    // 同步资金账户余额
    if (b.fund_id && Number(b.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(b.amount), b.fund_id])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/PayReceipt/edit', async (req, res) => {
  try {
    const { id, ...fields } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const allowed = ['contact_type', 'contact_name', 'remark', 'pay_date', 'fund_id', 'fund_name', 'category']
    const updates = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined)
    if (updates.length === 0) return fail(res, '没有可更新的字段')
    const sets = updates.map((k, i) => `${k}=$${i + 1}`)
    const vals = [...updates.map(k => fields[k]), id, shopId]
    await pool.query(`UPDATE pay_receipt SET ${sets.join(',')} WHERE id=$${vals.length - 1} AND shop_id=$${vals.length}`, vals)
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/PayReceipt/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT fund_id, amount FROM pay_receipt WHERE id=$1 AND shop_id=$2', [id, shopId])
    await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Invoice (发票)
router.get('/finance/Invoice/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_invoices', { keyword: req.query.keyword, keywordCols: ['invoice_no','customer_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Invoice/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_invoices', { invoice_no: genOrderNo('FP'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_invoices (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Invoice/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE finance_invoices SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Statement (对账单)
router.get('/finance/Statement/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_statements', { keyword: req.query.keyword, keywordCols: ['statement_no','customer_name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Statement/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_statements', { statement_no: genOrderNo('DZ'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_statements (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Statement/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE finance_statements SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Expense (费用)
router.get('/finance/Expense/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_expenses', { keyword: req.query.keyword, keywordCols: ['expense_no','name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Expense/add', async (req, res) => {
  try {
    const shopId = parseInt(req.admin?.shop_id) || 1
    const ALLOWED = new Set(['expense_no','name','amount','expense_date','fund_id','fund_name','remark','status','contact_name','pay_date','shop_id'])
    const b = { expense_no: genOrderNo('FY'), ...req.body, shop_id: shopId }
    const cols = Object.keys(b).filter(k => ALLOWED.has(k) && b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_expenses (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    // 同步扣减资金账户余额
    if (b.fund_id && Number(b.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(b.amount), b.fund_id])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Expense/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    // 还余额
    const r = await pool.query('SELECT fund_id, amount FROM finance_expenses WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    await pool.query('DELETE FROM finance_expenses WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Fund (资金账户)
router.get('/finance/Fund/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_funds', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
const FUND_ALLOWED_COLS = new Set(['name','fund_type','balance','bank_name','bank_account','remark','status'])
function normalizeFundBody(b) {
  // 前端传 type，数据库字段是 fund_type
  if (b.type !== undefined && b.fund_type === undefined) b.fund_type = b.type
  delete b.type
  return b
}
router.post('/finance/Fund/add', async (req, res) => {
  try {
    const shopId = parseInt(req.admin?.shop_id) || 1
    const b = normalizeFundBody({ ...req.body, shop_id: shopId })
    if (!b.name) return fail(res, '账户名称不能为空')
    const FUND_ALLOWED_WITH_SHOP = new Set([...FUND_ALLOWED_COLS, 'shop_id'])
    const cols = Object.keys(b).filter(k => FUND_ALLOWED_WITH_SHOP.has(k) && b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_funds (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Fund/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const b = normalizeFundBody({ ...rest })
    const cols = Object.keys(b).filter(k => FUND_ALLOWED_COLS.has(k) && b[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`UPDATE finance_funds SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Fund/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE finance_funds SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// FundFlow (资金流水)
router.get('/finance/FundFlow/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    // synthesize from collect and pay receipts
    const keyword = req.query.keyword
    let where = 'WHERE 1=1'
    const params = []
    if (keyword) {
      params.push(`%${keyword}%`)
      where += ` AND (contact_name ILIKE $1 OR receipt_no ILIKE $1)`
    }
    const shopId = parseInt(req.admin?.shop_id) || 1
    const unionSql = `
      SELECT id, receipt_no AS flow_no, 'collect' AS flow_type, contact_name, amount, receipt_date AS flow_date, fund_name, remark, created_at
      FROM (
        SELECT id, receipt_no, customer_name AS contact_name, amount, receipt_date, fund_name, remark, created_at
        FROM collect_receipt WHERE deleted_at IS NULL AND shop_id=${shopId}
        UNION ALL
        SELECT id, receipt_no, contact_name, amount, pay_date AS receipt_date, fund_name, remark, created_at
        FROM pay_receipt WHERE deleted_at IS NULL AND shop_id=${shopId}
      ) t
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `
    const countSql = `SELECT COUNT(*) FROM (
      SELECT id FROM collect_receipt WHERE deleted_at IS NULL AND shop_id=${shopId}
      UNION ALL
      SELECT id FROM pay_receipt WHERE deleted_at IS NULL AND shop_id=${shopId}
    ) t`
    const [countR, rowsR] = await Promise.all([pool.query(countSql), pool.query(unionSql, [...params, list_rows, offset])])
    return ok(res, { rows: rowsR.rows, total: parseInt(countR.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

// Cost (成本)
router.get('/finance/Cost/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_costs', { keyword: req.query.keyword, keywordCols: ['cost_no','name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Cost/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_costs', { cost_no: genOrderNo('CB'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_costs (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Cost/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM finance_costs WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Prepay (预付款)
router.get('/finance/Prepay/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'prepay_record', { keyword: req.query.keyword, keywordCols: ['order_sn','customer_name','supplier_name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Prepay/create', async (req, res) => {
  try {
    const b = filterBodyCols('prepay_record', { order_sn: genOrderNo('YF'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO prepay_record (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    // 同步扣减资金账户余额
    if (b.fund_id && Number(b.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(b.amount), b.fund_id])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Prepay/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    // 还余额
    const r = await pool.query('SELECT fund_id, amount FROM prepay_record WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    await pool.query('DELETE FROM prepay_record WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  RETAIL
// ═══════════════════════════════════════════════════════════════════════════

// retail/order
// 一次性迁移：加 admin_id/admin_name 列 + 回填历史单归属该店超级管理员
const adminColsMigrated = new Set()
async function ensureAdminCols(table) {
  if (adminColsMigrated.has(table)) return
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS admin_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100) DEFAULT ''`)
    await pool.query(`
      UPDATE ${table} t
      SET admin_id = a.id, admin_name = a.name
      FROM admins a
      WHERE t.shop_id = a.shop_id
        AND a.role_id = 0
        AND a.deleted_at IS NULL
        AND (t.admin_id IS NULL OR t.admin_id = 0)
    `)
    adminColsMigrated.add(table)
  } catch (e) { console.error(`[${table} admin migrate]`, e.message) }
}
const ensureRetailAdminCols = () => ensureAdminCols('retail_orders')

router.get('/retail/order/index', async (req, res) => {
  try { await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS fee_items JSONB DEFAULT '[]'`) } catch {}
  await ensureRetailAdminCols()
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_orders', { keyword: req.query.keyword, keywordCols: ['order_sn','member_name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/add', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS store_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS store_name VARCHAR(100) DEFAULT ''`)
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS fee_items JSONB DEFAULT '[]'`)
    await ensureRetailAdminCols()
    await loadTableCols()
    // 服务端强制注入创建人（不信客户端传的 admin_id/admin_name）
    let adminName = ''
    try {
      const a = await pool.query('SELECT name FROM admins WHERE id=$1', [req.admin?.id])
      adminName = a.rows[0]?.name || ''
    } catch {}
    const b = filterBodyCols('retail_orders', {
      order_sn: genOrderNo('LS'),
      ...req.body,
      admin_id: parseInt(req.admin?.id) || 0,
      admin_name: adminName,
      shop_id: parseInt(req.admin?.shop_id) || 1,
    })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO retail_orders (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/edit', async (req, res) => {
  try {
    const { id, goods_info, order_date, member_id, member_name, store_id, store_name, pay_type, remark, total_amount, discount_amount, pay_amount, fee_items } = req.body
    if (!id) return fail(res, '缺少零售单 ID')
    if (!goods_info) return fail(res, '缺少 goods_info')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const row = await pool.query('SELECT status FROM retail_orders WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (!row.rows.length) return fail(res, '订单不存在')
    if (Number(row.rows[0].status) === 1) return fail(res, '已审核订单不可编辑，请先反审核')
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS fee_items JSONB DEFAULT '[]'`)
    const goodsStr = typeof goods_info === 'string' ? goods_info : JSON.stringify(goods_info)
    const feeStr = fee_items === undefined ? null : (typeof fee_items === 'string' ? fee_items : JSON.stringify(fee_items))
    await pool.query(
      `UPDATE retail_orders SET goods_info=$1, total_amount=$2, discount_amount=$3, pay_amount=$4,
       order_date=$5, member_id=$6, member_name=$7, store_id=$8, store_name=$9, pay_type=$10, remark=$11,
       fee_items = COALESCE($12::jsonb, fee_items)
       WHERE id=$13 AND shop_id=$14`,
      [goodsStr, total_amount??0, discount_amount??0, pay_amount??0,
       order_date||null, member_id||0, member_name||'', store_id||0, store_name||'', pay_type||'cash', remark||'', feeStr, id, shopId]
    )
    const r = await pool.query('SELECT * FROM retail_orders WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
// 单独保存附加费用：已审核订单也可以改，不触发库存/资金
router.post('/retail/order/saveFees', async (req, res) => {
  try {
    const { id, fee_items } = req.body
    if (!id) return fail(res, '缺少零售单 ID')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const row = await pool.query('SELECT id FROM retail_orders WHERE id=$1 AND shop_id=$2', [id, shopId])
    if (!row.rows.length) return fail(res, '订单不存在')
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS fee_items JSONB DEFAULT '[]'`)
    const feeStr = typeof fee_items === 'string' ? fee_items : JSON.stringify(fee_items || [])
    await pool.query('UPDATE retail_orders SET fee_items=$1 WHERE id=$2 AND shop_id=$3', [feeStr, id, shopId])
    const r = await pool.query('SELECT * FROM retail_orders WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const s = parseInt(status)
    if (s !== 0 && s !== 1) return fail(res, 'status必须是0或1')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE retail_orders SET status=$1 WHERE id=$2 AND shop_id=$3', [s, id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM retail_orders WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    await pool.query(`DELETE FROM retail_orders WHERE id=ANY($1) AND shop_id=$2`, [idArr, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// retail/member
router.get('/retail/member/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_members', { keyword: req.query.keyword, keywordCols: ['name','mobile'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/member/add', async (req, res) => {
  try {
    const b = filterBodyCols('retail_members', { ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    if (!b.name && !b.mobile) return fail(res, '姓名或手机号不能为空')
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO retail_members (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/member/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const r = await pool.query(`UPDATE retail_members SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/member/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM retail_members WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// retail/recharge
router.get('/retail/recharge/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_recharge', { keyword: req.query.keyword, keywordCols: ['recharge_no','member_name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/recharge/add', async (req, res) => {
  try {
    const b = filterBodyCols('retail_recharge', { recharge_no: genOrderNo('CZ'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO retail_recharge (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/recharge/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM retail_recharge WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// retail/store
router.get('/retail/store/index', async (req, res) => {
  try {
    // store table may not exist in db.js — use sys_params as fallback or return empty
    try {
      const { page, list_rows, offset } = pageParams(req.query)
      const r = await pool.query('SELECT COUNT(*) FROM information_schema.tables WHERE table_name=$1', ['retail_stores'])
      if (parseInt(r.rows[0].count) === 0) {
        return ok(res, { rows: [], total: 0, page: 1, list_rows: 20 })
      }
      await listQuery(res, 'retail_stores', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id ASC', page, list_rows, offset })
    } catch {
      return ok(res, { rows: [], total: 0, page: 1, list_rows: 20 })
    }
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/add', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS retail_stores (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, address TEXT DEFAULT '', tel VARCHAR(20) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, shop_id INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT NOW())`)
    await pool.query(`ALTER TABLE retail_stores ADD COLUMN IF NOT EXISTS shop_id INTEGER NOT NULL DEFAULT 1`).catch(() => {})
    const shopId = parseInt(req.admin?.shop_id) || 1
    const b = req.body
    if (!b.name) return fail(res, '门店名称不能为空')
    const r = await pool.query('INSERT INTO retail_stores (name,address,tel,remark,status,shop_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.name, b.address||'', b.tel||'', b.remark||'', b.status||1, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/edit', async (req, res) => {
  try {
    const { id, name, address, tel, remark, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE retail_stores SET name=COALESCE($1,name), address=COALESCE($2,address), tel=COALESCE($3,tel), remark=COALESCE($4,remark), status=COALESCE($5,status) WHERE id=$6 AND shop_id=$7 RETURNING *', [name, address, tel, remark, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM retail_stores WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  SETTING
// ═══════════════════════════════════════════════════════════════════════════

// setting/admin
router.get('/setting/admin/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'admins', { keyword: req.query.keyword, keywordCols: ['name','account','mobile'], baseWhere: shopBase(req, 'deleted_at IS NULL'), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/admin/add', async (req, res) => {
  try {
    const b = req.body
    if (!b.account) return fail(res, '账号不能为空')
    if (!b.password) return fail(res, '密码不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const hashedPwd = await bcrypt.hash(b.password, 10)
    const data = { ...b, password: hashedPwd, shop_id: shopId }
    const cols = Object.keys(data).filter(k => data[k] !== undefined)
    const vals = cols.map(k => data[k])
    const r = await pool.query(`INSERT INTO admins (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING id, name, account, role_name, dept_name, mobile, status`, vals)
    return ok(res, r.rows[0])
  } catch (e) {
    if (e.code === '23505') return fail(res, '账号已存在')
    fail(res, e.message)
  }
})
router.post('/setting/admin/edit', async (req, res) => {
  try {
    const { id, password, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const data = { ...rest }
    if (password) data.password = await bcrypt.hash(password, 10)
    const cols = Object.keys(data).filter(k => data[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => data[k])
    const r = await pool.query(`UPDATE admins SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING id, name, account, role_name, status`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/admin/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE admins SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/dept
router.get('/setting/dept/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'depts', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req, '1=1'), orderBy: 'sort ASC, id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/add', async (req, res) => {
  try {
    const { name, parent_id = 0, sort = 0, status = 1 } = req.body
    if (!name) return fail(res, '部门名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO depts (name,parent_id,sort,status,shop_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, parent_id, sort, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/edit', async (req, res) => {
  try {
    const { id, name, parent_id, sort, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE depts SET name=COALESCE($1,name), parent_id=COALESCE($2,parent_id), sort=COALESCE($3,sort), status=COALESCE($4,status) WHERE id=$5 AND shop_id=$6 RETURNING *', [name, parent_id, sort, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM depts WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/role
router.get('/setting/role/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'roles', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/add', async (req, res) => {
  try {
    const { name, permissions = '', status = 1 } = req.body
    if (!name) return fail(res, '角色名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO roles (name,permissions,status,shop_id) VALUES ($1,$2,$3,$4) RETURNING *', [name, permissions, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/edit', async (req, res) => {
  try {
    const { id, name, permissions, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE roles SET name=COALESCE($1,name), permissions=COALESCE($2,permissions), status=COALESCE($3,status) WHERE id=$4 AND shop_id=$5 RETURNING *', [name, permissions, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM roles WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/jobs
router.get('/setting/jobs/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'jobs', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: shopBase(req, '1=1'), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/add', async (req, res) => {
  try {
    const { name, dept_id = 0, status = 1 } = req.body
    if (!name) return fail(res, '职位名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('INSERT INTO jobs (name,dept_id,status,shop_id) VALUES ($1,$2,$3,$4) RETURNING *', [name, dept_id, status, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/edit', async (req, res) => {
  try {
    const { id, name, dept_id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('UPDATE jobs SET name=COALESCE($1,name), dept_id=COALESCE($2,dept_id), status=COALESCE($3,status) WHERE id=$4 AND shop_id=$5 RETURNING *', [name, dept_id, status, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('DELETE FROM jobs WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/company
router.get('/setting/company/detail', async (req, res) => {
  try {
    const sid = getShopId(req)
    const r = await pool.query('SELECT * FROM company_info WHERE shop_id=$1 LIMIT 1', [sid])
    if (!r.rows[0]) {
      await pool.query("INSERT INTO company_info (name, shop_id) VALUES ('我的公司', $1)", [sid])
      const r2 = await pool.query('SELECT * FROM company_info WHERE shop_id=$1 LIMIT 1', [sid])
      return ok(res, r2.rows[0])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/company/edit', async (req, res) => {
  try {
    const sid = getShopId(req)
    const { id, shop_id: _s, ...rest } = req.body
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const existing = await pool.query('SELECT id FROM company_info WHERE shop_id=$1 LIMIT 1', [sid])
    if (existing.rows[0]) {
      await pool.query(`UPDATE company_info SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2}`, [...vals, existing.rows[0].id, sid])
    } else {
      await pool.query(`INSERT INTO company_info (${cols.join(',')}, shop_id) VALUES (${cols.map((_,i)=>`$${i+1}`)}, $${cols.length+1})`, [...vals, sid])
    }
    const r = await pool.query('SELECT * FROM company_info WHERE shop_id=$1 LIMIT 1', [sid])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

// setting/operationLog
router.get('/setting/operationLog/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'operation_logs', { keyword: req.query.keyword, keywordCols: ['admin_name','action'], baseWhere: shopBase(req, '1=1'), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// setting/params
router.get('/setting/params/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sys_params', { keyword: req.query.keyword, keywordCols: ['key','value'], baseWhere: shopBase(req, '1=1'), orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/params/edit', async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key) return fail(res, 'key不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    // Try to update existing record for this shop first; insert if not found
    const existingParam = await pool.query('SELECT id FROM sys_params WHERE key=$1 AND shop_id=$2 LIMIT 1', [key, shopId])
    if (existingParam.rows.length > 0) {
      await pool.query('UPDATE sys_params SET value=$1 WHERE key=$2 AND shop_id=$3', [value, key, shopId])
    } else {
      await pool.query('INSERT INTO sys_params (key,value,shop_id) VALUES ($1,$2,$3)', [key, value, shopId])
    }
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ─── video/render ───────────────────────────────────────────────────────────

router.post('/video/render', async (req, res) => {
  const {
    root_code,
    component_code,
    composition_id = 'MyVideo',
    width = 1080,
    height = 1920,
    fps = 30,
    duration_frames = 900,
  } = req.body
  if (!root_code || !component_code) return fail(res, '缺少 root_code 或 component_code')

  const id = crypto.randomUUID()
  const tmpDir = path.join(os.tmpdir(), `remotion-${id}`)
  const srcDir = path.join(tmpDir, 'src')
  const outFile = path.join(tmpDir, 'out', 'video.mp4')

  try {
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true })

    // package.json — ESM project, pin remotion version same as backend
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'remotion-render',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        remotion: '^4.0.441',
        '@remotion/cli': '^4.0.441',
        '@remotion/transitions': '^4.0.441',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
    }, null, 2))

    // tsconfig
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: false,
      },
    }, null, 2))

    // src/index.ts — entry point
    fs.writeFileSync(path.join(srcDir, 'index.ts'),
      `import { registerRoot } from 'remotion';\nimport { RemotionRoot } from './Root';\nregisterRoot(RemotionRoot);\n`
    )

    // src/Root.tsx
    fs.writeFileSync(path.join(srcDir, 'Root.tsx'), root_code)

    // src/Video.tsx — main component
    fs.writeFileSync(path.join(srcDir, 'Video.tsx'), component_code)

    // npm install (downloads remotion + chrome headless shell, cached after first run)
    execSync('npm install --prefer-offline 2>&1', { cwd: tmpDir, timeout: 180000, stdio: 'pipe' })

    // render
    execSync(
      `npx remotion render src/index.ts ${composition_id} out/video.mp4 --width=${width} --height=${height} --fps=${fps}`,
      { cwd: tmpDir, timeout: 600000, stdio: 'pipe' }
    )

    const videoBuffer = fs.readFileSync(outFile)
    const base64 = videoBuffer.toString('base64')
    return ok(res, { base64, mimeType: 'video/mp4', size: videoBuffer.length })
  } catch (e) {
    return fail(res, `渲染失败：${e.message || String(e)}`)
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
})

// ─── image/render ───────────────────────────────────────────────────────────

router.post('/image/render', async (req, res) => {
  const {
    root_code,
    component_code,
    composition_id = 'Poster',
    width = 1080,
    height = 1080,
  } = req.body
  if (!root_code || !component_code) return fail(res, '缺少 root_code 或 component_code')

  const id = crypto.randomUUID()
  const tmpDir = path.join(os.tmpdir(), `remotion-img-${id}`)
  const srcDir = path.join(tmpDir, 'src')
  const outFile = path.join(tmpDir, 'out', 'image.png')

  try {
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true })

    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'remotion-render',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        remotion: '^4.0.441',
        '@remotion/cli': '^4.0.441',
        '@remotion/transitions': '^4.0.441',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
    }, null, 2))

    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: false,
      },
    }, null, 2))

    fs.writeFileSync(path.join(srcDir, 'index.ts'),
      `import { registerRoot } from 'remotion';\nimport { RemotionRoot } from './Root';\nregisterRoot(RemotionRoot);\n`
    )
    fs.writeFileSync(path.join(srcDir, 'Root.tsx'), root_code)
    fs.writeFileSync(path.join(srcDir, 'Poster.tsx'), component_code)

    execSync('npm install --prefer-offline 2>&1', { cwd: tmpDir, timeout: 180000, stdio: 'pipe' })

    execSync(
      `npx remotion still src/index.ts ${composition_id} out/image.png --width=${width} --height=${height}`,
      { cwd: tmpDir, timeout: 300000, stdio: 'pipe' }
    )

    const imgBuffer = fs.readFileSync(outFile)
    const base64 = imgBuffer.toString('base64')
    return ok(res, { base64, mimeType: 'image/png', size: imgBuffer.length })
  } catch (e) {
    return fail(res, `图片渲染失败：${e.message || String(e)}`)
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
})

// ── 页面截图接口（供会议室设计专员使用）──
app.post('/screenshot', async (req, res) => {
  const { url, selector, token } = req.body
  if (!url) return res.status(400).json({ code: 0, message: '缺少 url' })

  let puppeteer, browser
  try {
    puppeteer = require('puppeteer-core')
  } catch {
    return res.status(500).json({ code: 0, message: '截图服务未安装，请联系管理员' })
  }

  try {
    const chromiumPath = process.env.CHROMIUM_PATH
      || process.env.REMOTION_CHROME_PATH
      || '/usr/bin/chromium-browser'
      || '/usr/bin/chromium'

    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })

    // 如果有 token，设置 localStorage（ERP 登录态）
    if (token) {
      await page.evaluateOnNewDocument((t) => {
        localStorage.setItem('erp_token', t)
      }, token)
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 2000))

    let imageBase64
    if (selector) {
      const el = await page.$(selector)
      if (el) {
        imageBase64 = (await el.screenshot({ type: 'jpeg', quality: 85 })).toString('base64')
      } else {
        imageBase64 = (await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false })).toString('base64')
      }
    } else {
      imageBase64 = (await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false })).toString('base64')
    }

    await browser.close()
    return res.json({ code: 1, data: { image: `data:image/jpeg;base64,${imageBase64}` } })
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    return res.status(500).json({ code: 0, message: e.message })
  }
})

// ─── 浏览器操作路由（给亚当用，使用 Browserless REST API）──────────────────

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_API_KEY || ''
const BROWSER_AUTH = process.env.BROWSER_AUTH_TOKEN || 'adam-browser-secret'

app.post('/browser', async (req, res) => {
  const token = req.headers['x-auth-token']
  if (token !== BROWSER_AUTH) return res.status(401).json({ ok: false, error: 'Unauthorized' })

  const { action, params, cookies } = req.body
  if (!action) return res.status(400).json({ ok: false, error: 'action required' })

  try {
    // 构建注入 Cookie 的脚本
    const cookieScript = Array.isArray(cookies) && cookies.length > 0
      ? cookies.map(c => `document.cookie = ${JSON.stringify(`${c.name}=${c.value}; domain=${c.domain}; path=${c.path || '/'}`)}; `).join('')
      : ''

    if (action === 'get_content') {
      const script = `
        export default async function ({ page }) {
          ${cookieScript ? `await page.goto('${params.url}'); ${cookieScript}` : ''}
          await page.goto('${params.url}', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          const text = await page.evaluate(() => document.body.innerText);
          const title = await page.title();
          const url = page.url();
          return { url, title, content: text.slice(0, 5000) };
        }
      `
      const resp = await fetch(`https://production-sfo.browserless.io/function?token=${BROWSERLESS_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/javascript' },
        body: script,
      })
      if (!resp.ok) {
        const errText = await resp.text()
        return res.status(500).json({ ok: false, error: `Browserless error: ${errText.slice(0, 200)}` })
      }
      const result = await resp.json()
      return res.json({ ok: true, result })
    }

    if (action === 'screenshot') {
      // Browserless screenshot API
      const body = { url: params.url, options: { type: 'jpeg', quality: 70 } }
      const resp = await fetch(`https://production-sfo.browserless.io/screenshot?token=${BROWSERLESS_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const errText = await resp.text()
        return res.status(500).json({ ok: false, error: `Browserless error: ${errText.slice(0, 200)}` })
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      return res.json({ ok: true, result: { url: params.url, screenshot_base64: buf.toString('base64') } })
    }

    return res.status(400).json({ ok: false, error: `未知 action: ${action}` })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ─── start ──────────────────────────────────────────────────────────────────

// SaleExchangeOrder
router.get('/stock/SaleExchangeOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.customer_name) conditions.push(`customer_name ILIKE '%${req.query.customer_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'sale_exchange_order', { keyword: req.query.keyword, keywordCols: ['order_no', 'customer_name'], baseWhere: shopBase(req, conditions.join(' AND ')), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleExchangeOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_exchange_order', { order_no: genOrderNo('HH'), ...req.body, shop_id: parseInt(req.admin?.shop_id) || 1 })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO sale_exchange_order (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleExchangeOrder/edit', async (req, res) => {
  try {
    const { id, ...rawRest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const rest = filterBodyCols('sale_exchange_order', rawRest)
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k, i) => `${k}=$${i+1}`)
    const vals = cols.map(k => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query(`UPDATE sale_exchange_order SET ${sets.join(',')} WHERE id=$${vals.length+1} AND shop_id=$${vals.length+2} RETURNING *`, [...vals, id, shopId])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleExchangeOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE sale_exchange_order SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleExchangeOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const shopId = parseInt(req.admin?.shop_id) || 1
    const r = await pool.query('SELECT * FROM sale_exchange_order WHERE id=$1 AND shop_id=$2', [id, shopId])
    const order = r.rows[0]
    if (!order) return fail(res, '换货单不存在')
    if (order.status === newStatus) return ok(res)

    let returnGoods = []
    let exchangeGoods = []
    try { returnGoods = typeof order.return_goods_info === 'string' ? JSON.parse(order.return_goods_info) : (order.return_goods_info || []) } catch {}
    try { exchangeGoods = typeof order.exchange_goods_info === 'string' ? JSON.parse(order.exchange_goods_info) : (order.exchange_goods_info || []) } catch {}

    const warehouseId = order.warehouse_id || 0
    const warehouseName = order.warehouse_name || ''
    const orderNo = order.order_no || ''
    const isAudit = newStatus === 1

    // 退货商品：审核时入库(+1)，反审核时出库(-1)
    for (const item of returnGoods) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = isAudit ? num : -num
      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      if (existing.rows.length > 0) {
        const beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5', [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'exchange_return_in' : 'exchange_return_in_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '换货退入审核' : '换货退入反审核'])
      } else if (isAudit && warehouseId) {
        await pool.query('INSERT INTO stock_inventory (goods_id, goods_name, goods_code, unit_name, warehouse_id, warehouse_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)', [goodsId, item.goods_name || '', item.goods_sn || '', item.unit_name || '', warehouseId, warehouseName, num])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, 'exchange_return_in', num, 0, num, orderNo, '换货退入审核'])
      }
    }

    // 换出商品：审核时出库(-1)，反审核时入库(+1)
    for (const item of exchangeGoods) {
      const goodsId = item.goods_id || 0
      if (!goodsId) continue
      const num = parseFloat(item.num) || 0
      if (num <= 0) continue
      const change = isAudit ? -num : num
      const existing = await pool.query('SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2', [goodsId, warehouseId])
      if (existing.rows.length > 0) {
        const beforeQty = parseFloat(existing.rows[0].qty) || 0
        const afterQty = Math.max(0, beforeQty + change)
        await pool.query('UPDATE stock_inventory SET qty=$1, goods_name=$2, unit_name=$3, update_time=NOW() WHERE goods_id=$4 AND warehouse_id=$5', [afterQty, item.goods_name || '', item.unit_name || '', goodsId, warehouseId])
        await pool.query('INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [goodsId, item.goods_name || '', warehouseId, warehouseName, isAudit ? 'exchange_out' : 'exchange_out_reverse', change, beforeQty, afterQty, orderNo, isAudit ? '换货发出审核' : '换货发出反审核'])
      }
    }

    // 应收账款处理
    const diffAmount = parseFloat(order.diff_amount) || 0
    const freightAmount = parseFloat(order.freight_amount) || 0
    const freightBearer = order.freight_bearer || 'seller'
    const buyerFreight = freightBearer === 'buyer' ? freightAmount : freightBearer === 'half' ? freightAmount / 2 : 0
    // fee_items 中 bearer='seller' 表示对方承担，计入应收
    const feeItems = Array.isArray(order.fee_items) ? order.fee_items : []
    const sellerFees = feeItems.filter(f => f.bearer === 'seller').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0)
    const receivableAmount = diffAmount + buyerFreight + sellerFees
    if (isAudit) {
      if (receivableAmount > 0) {
        const rec = await pool.query(
          `INSERT INTO finance_receivable (customer_id, customer_name, order_sn, total_amount, paid_amount, un_pay_amount, due_date, status, shop_id)
           VALUES ($1,$2,$3,$4,0,$4,null,0,$5) RETURNING id`,
          [order.customer_id || 0, order.customer_name || '', orderNo, receivableAmount, shopId]
        )
        await pool.query('UPDATE sale_exchange_order SET receivable_id=$1 WHERE id=$2', [rec.rows[0].id, id])
      } else if (receivableAmount < 0) {
        // 应退客户：生成带"换货退款"标注的应收记录
        const rec = await pool.query(
          `INSERT INTO finance_receivable (customer_id, customer_name, order_sn, total_amount, paid_amount, un_pay_amount, due_date, status, remark, shop_id)
           VALUES ($1,$2,$3,$4,0,$4,null,0,'换货退款',$5) RETURNING id`,
          [order.customer_id || 0, order.customer_name || '', orderNo, Math.abs(receivableAmount), shopId]
        )
        await pool.query('UPDATE sale_exchange_order SET receivable_id=$1 WHERE id=$2', [rec.rows[0].id, id])
      }
    } else {
      // 反审核：删除审核时创建的应收记录
      if (order.receivable_id) {
        await pool.query('DELETE FROM finance_receivable WHERE id=$1 AND shop_id=$2', [order.receivable_id, shopId])
        await pool.query('UPDATE sale_exchange_order SET receivable_id=0 WHERE id=$1', [id])
      }
    }

    await pool.query('UPDATE sale_exchange_order SET status=$1 WHERE id=$2 AND shop_id=$3', [newStatus, id, shopId])
    return ok(res)
  } catch (e) { console.error('[SaleExchangeOrder audit error]', e.message); fail(res, e.message) }
})

async function migrateSaleExchangeOrder() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_exchange_order (
      id SERIAL PRIMARY KEY,
      order_no VARCHAR(100) DEFAULT '',
      shop_id INTEGER NOT NULL DEFAULT 1,
      customer_id INTEGER DEFAULT 0,
      customer_name VARCHAR(200) DEFAULT '',
      contact_name VARCHAR(100) DEFAULT '',
      admin_name VARCHAR(100) DEFAULT '',
      warehouse_id INTEGER DEFAULT 0,
      warehouse_name VARCHAR(100) DEFAULT '',
      exchange_date VARCHAR(20) DEFAULT '',
      return_goods_info JSONB DEFAULT '[]',
      exchange_goods_info JSONB DEFAULT '[]',
      return_amount NUMERIC(12,2) DEFAULT 0,
      exchange_amount NUMERIC(12,2) DEFAULT 0,
      diff_amount NUMERIC(12,2) DEFAULT 0,
      freight_amount NUMERIC(12,2) DEFAULT 0,
      freight_bearer VARCHAR(20) DEFAULT 'seller',
      expense_amount NUMERIC(12,2) DEFAULT 0,
      receivable_id INTEGER DEFAULT 0,
      reason TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      status INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      deleted_at TIMESTAMP
    )
  `)
  // 已有表补列
  await pool.query(`ALTER TABLE sale_exchange_order
    ADD COLUMN IF NOT EXISTS freight_amount NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS freight_bearer VARCHAR(20) DEFAULT 'seller',
    ADD COLUMN IF NOT EXISTS expense_amount NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS receivable_id INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fee_items JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS source_order_id INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_order_no VARCHAR(100) DEFAULT '',
    ADD COLUMN IF NOT EXISTS exchange_source_order_id INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS exchange_source_order_no VARCHAR(100) DEFAULT ''
  `).catch(() => {})
}

async function migrateSaleReturnOrder() {
  await pool.query(`ALTER TABLE sale_return_order
    ADD COLUMN IF NOT EXISTS return_amount NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100) DEFAULT '',
    ADD COLUMN IF NOT EXISTS warehouse_id INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS warehouse_name VARCHAR(100) DEFAULT '',
    ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS order_sn VARCHAR(100) DEFAULT '',
    ADD COLUMN IF NOT EXISTS sale_out_order_id INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS level_id INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fund_id INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fund_name VARCHAR(100) DEFAULT ''`)
}

// 自动确认收货：发货满7天未手动确认的订单自动完成并结算佣金
async function autoConfirmOrders() {
  try {
    const rows = (await pool.query(
      `SELECT o.*, u.openid FROM mini_orders o
       JOIN mini_users u ON u.id=o.user_id
       WHERE o.status=2 AND o.shipped_at IS NOT NULL
         AND o.shipped_at < NOW() - INTERVAL '7 days'`
    )).rows
    for (const order of rows) {
      // 仅自动确认收货，不结算佣金（佣金由 settleEligibleCommissions 7天冷静期后处理）
      await pool.query(`UPDATE mini_orders SET status=3, confirmed_at=NOW() WHERE id=$1`, [order.id])
      console.log(`auto-confirmed order ${order.order_no}`)
    }
    if (rows.length) console.log(`Auto-confirmed ${rows.length} orders`)
  } catch (e) {
    console.error('autoConfirmOrders error:', e.message)
  }
}

// 佣金结算：扫描已确认收货满 7 天且未结算的订单，逐个转账
// 失败自动累计 commission_retry_count，超过上限不再重试（需人工处理）
const COMMISSION_COOLING_DAYS = 7
const COMMISSION_MAX_RETRY = 10
async function settleEligibleCommissions() {
  try {
    // 一次性补字段（幂等）
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS commission_retry_count INT DEFAULT 0`).catch(() => {})
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS commission_last_error TEXT DEFAULT ''`).catch(() => {})

    const rows = (await pool.query(
      `SELECT o.id, o.order_no, o.commission, o.distributor_code, COALESCE(o.commission_retry_count, 0) AS retry
       FROM mini_orders o
       WHERE o.status=3
         AND o.commission_settled=false
         AND o.commission > 0
         AND o.distributor_code != ''
         AND o.confirmed_at IS NOT NULL
         AND o.confirmed_at < NOW() - INTERVAL '${COMMISSION_COOLING_DAYS} days'
         AND COALESCE(o.commission_retry_count, 0) < ${COMMISSION_MAX_RETRY}
         AND NOT EXISTS (SELECT 1 FROM mini_refunds WHERE order_id=o.id AND status IN (0,1))`
    )).rows
    for (const order of rows) {
      try {
        const dist = (await pool.query(
          `SELECT d.*, u.openid as dist_openid FROM distributors d
           JOIN mini_users u ON u.id=d.user_id
           WHERE d.code=$1 AND d.status=1 LIMIT 1`,
          [order.distributor_code]
        )).rows[0]
        if (!dist?.dist_openid) {
          await pool.query(`UPDATE mini_orders SET commission_retry_count=commission_retry_count+1, commission_last_error=$1 WHERE id=$2`, ['distributor not active or missing openid', order.id])
          continue
        }
        const result = await transferCommission(order.id, order.order_no, dist.dist_openid, parseFloat(order.commission))
        if (!result.skipped && !result.code) {
          await pool.query(`UPDATE mini_orders SET commission_settled=true, commission_last_error='' WHERE id=$1`, [order.id])
          console.log(`commission settled for order ${order.order_no}: ¥${order.commission}`)
        } else if (result.code && result.code !== 'SUCCESS') {
          await pool.query(`UPDATE mini_orders SET commission_retry_count=commission_retry_count+1, commission_last_error=$1 WHERE id=$2`, [result.message || result.code, order.id])
          console.error(`commission transfer rejected for order ${order.order_no}:`, result.message || result.code)
        }
      } catch (e) {
        await pool.query(`UPDATE mini_orders SET commission_retry_count=commission_retry_count+1, commission_last_error=$1 WHERE id=$2`, [e.message, order.id]).catch(() => {})
        console.error(`settle commission failed for order ${order.order_no}:`, e.message)
      }
    }
    if (rows.length) console.log(`Settled ${rows.length} commissions`)
  } catch (e) {
    console.error('settleEligibleCommissions error:', e.message)
  }
}

async function start() {
  // Listen first so Render health check passes immediately (Neon cold start can take 30+ sec)
  app.listen(PORT, () => {
    console.log(`ERP server running on port ${PORT}`)
  })
  try {
    await initDb()
    await migrateSaleReturnOrder()
    await migrateSaleExchangeOrder()
    await loadTableCols()
    await migrateMultiTenant()
    // 补填历史退货单 fund 信息（一次性，幂等）
    await pool.query(`UPDATE sale_return_order SET fund_id=58, fund_name='公司收入账号' WHERE id=51 AND fund_id=0`).catch(() => {})
    console.log('Database ready')
    // 每天凌晨2点自动收货；3点结算冷静期满7天的佣金
    const cron = require('node-cron')
    cron.schedule('0 2 * * *', autoConfirmOrders, { timezone: 'Asia/Shanghai' })
    cron.schedule('0 3 * * *', settleEligibleCommissions, { timezone: 'Asia/Shanghai' })
  } catch (e) {
    console.error('DB init failed (server still running):', e)
  }
}

// ─── BOM 物料清单 ───────────────────────────────────────────────────────────
router.get('/goods/BomGoods/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const keyword = req.query.keyword || ''
    const shopId = parseInt(req.admin?.shop_id) || 1
    const where = keyword
      ? `deleted_at IS NULL AND shop_id=${shopId} AND (goods_name ILIKE $1 OR goods_sn ILIKE $1 OR bom_code ILIKE $1)`
      : `deleted_at IS NULL AND shop_id=${shopId}`
    const params = keyword ? [`%${keyword}%`] : []
    const count = await pool.query(`SELECT COUNT(*) FROM bom_order WHERE ${where}`, params)
    const rows = await pool.query(
      `SELECT * FROM bom_order WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, list_rows, offset]
    )
    return ok(res, { list: rows.rows, total: parseInt(count.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

router.get('/goods/BomGoods/detail', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const bom = await pool.query('SELECT * FROM bom_order WHERE id=$1 AND deleted_at IS NULL AND shop_id=$2', [id, shopId])
    if (!bom.rows.length) return fail(res, 'BOM不存在')
    const items = await pool.query('SELECT * FROM bom_items WHERE bom_id=$1 ORDER BY id ASC', [id])
    return ok(res, { ...bom.rows[0], items: items.rows })
  } catch (e) { fail(res, e.message) }
})

router.post('/goods/BomGoods/add', async (req, res) => {
  try {
    const { goods_name, goods_sn, spec, unit_name, remark, items = [] } = req.body
    if (!goods_name) return fail(res, '商品名称不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    const countR = await pool.query('SELECT COUNT(*) FROM bom_order WHERE deleted_at IS NULL AND shop_id=$1', [shopId])
    const sn = parseInt(countR.rows[0].count) + 1
    const bomCode = 'BOM' + String(sn).padStart(6, '0')
    const r = await pool.query(
      `INSERT INTO bom_order (bom_code, goods_name, goods_sn, spec, unit_name, remark, shop_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [bomCode, goods_name, goods_sn || '', spec || '', unit_name || '', remark || '', shopId]
    )
    const bomId = r.rows[0].id
    for (const item of items) {
      await pool.query(
        `INSERT INTO bom_items (bom_id, goods_name, goods_sn, num, unit_name, price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [bomId, item.goods_name || '', item.goods_sn || '', item.num || 1, item.unit_name || '', item.price || 0]
      )
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

router.post('/goods/BomGoods/edit', async (req, res) => {
  try {
    const { id, goods_name, goods_sn, spec, unit_name, remark, items } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query(
      `UPDATE bom_order SET goods_name=$1, goods_sn=$2, spec=$3, unit_name=$4, remark=$5, update_time=NOW() WHERE id=$6 AND shop_id=$7`,
      [goods_name || '', goods_sn || '', spec || '', unit_name || '', remark || '', id, shopId]
    )
    if (Array.isArray(items)) {
      await pool.query('DELETE FROM bom_items WHERE bom_id=$1', [id])
      for (const item of items) {
        await pool.query(
          `INSERT INTO bom_items (bom_id, goods_name, goods_sn, num, unit_name, price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, item.goods_name || '', item.goods_sn || '', item.num || 1, item.unit_name || '', item.price || 0]
        )
      }
    }
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

router.post('/goods/BomGoods/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const shopId = parseInt(req.admin?.shop_id) || 1
    await pool.query('UPDATE bom_order SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [id, shopId])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ─── 小程序 miniapi ───────────────────────────────────────────────────────────

const MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'mini_secret_2024'
const WX_SECRET = process.env.WX_SECRET || ''
const WX_MCH_ID = process.env.WX_MCH_ID || ''
const WX_MCH_KEY = process.env.WX_MCH_KEY || ''
const WX_MCH_CERT_SERIAL = process.env.WX_MCH_CERT_SERIAL || ''
const WX_API_V3_KEY = process.env.WX_API_V3_KEY || ''
const WX_MCH_PUBLIC_KEY_ID = process.env.WX_MCH_PUBLIC_KEY_ID || ''
// 私钥：env var 里 \n 是字面量，需替换为真实换行
const WX_MCH_PRIVATE_KEY = (process.env.WX_MCH_PRIVATE_KEY || '').replace(/\\n/g, '\n')

// WeChat Pay V3 签名与请求
function wxV3Auth(method, urlPath, body) {
  const crypto = require('crypto')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex').toUpperCase()
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(message)
  const signature = sign.sign(WX_MCH_PRIVATE_KEY, 'base64')
  return `WECHATPAY2-SHA256-RSA2048 mchid="${WX_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${WX_MCH_CERT_SERIAL}",signature="${signature}"`
}

async function wxV3Post(urlPath, payload) {
  const body = JSON.stringify(payload)
  const auth = wxV3Auth('POST', urlPath, body)
  const resp = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': auth,
      'Wechatpay-Serial': WX_MCH_PUBLIC_KEY_ID,
    },
    body,
  })
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

async function wxV3Get(urlPath) {
  const auth = wxV3Auth('GET', urlPath, '')
  const resp = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN',
      'User-Agent': 'NomadERP/1.0',
      'Authorization': auth,
      'Wechatpay-Serial': WX_MCH_PUBLIC_KEY_ID,
    },
  })
  const text = await resp.text()
  return { status: resp.status, body: (() => { try { return JSON.parse(text) } catch { return text } })() }
}

async function transferCommission(orderId, orderNo, openid, amountYuan) {
  if (!WX_MCH_PRIVATE_KEY || !WX_MCH_CERT_SERIAL) return { skipped: true, reason: 'not configured' }
  const amountFen = Math.round(amountYuan * 100)
  if (amountFen < 1) return { skipped: true, reason: 'amount < 1 fen' }
  const outBatchNo = `COMM${orderId}T${Date.now()}`
  const outDetailNo = `D${orderId}T${Date.now()}`
  return wxV3Post('/v3/transfer/batches', {
    appid: WX_APPID,
    out_batch_no: outBatchNo,
    batch_name: '分销佣金',
    batch_remark: `订单${orderNo}佣金结算`,
    total_amount: amountFen,
    total_num: 1,
    transfer_detail_list: [{
      out_detail_no: outDetailNo,
      transfer_amount: amountFen,
      transfer_remark: `订单${orderNo}佣金`,
      openid,
    }],
  })
}

// V3 订单查询：查微信实际支付状态（用于取消订单前的安全校验）
async function wxV3QueryOrder(outTradeNo) {
  if (!WX_MCH_PRIVATE_KEY || !WX_MCH_CERT_SERIAL) return { skipped: true }
  const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${WX_MCH_ID}`
  const result = await wxV3Get(urlPath)
  return result
}

// 微信退款（V3）
async function wxV3Refund(orderNo, transactionId, refundNo, amountYuan, reason) {
  if (!WX_MCH_PRIVATE_KEY || !WX_MCH_CERT_SERIAL) return { skipped: true, reason: 'not configured' }
  const amountFen = Math.round(amountYuan * 100)
  if (amountFen < 1) return { skipped: true, reason: 'amount < 1 fen' }
  const payload = {
    out_refund_no: refundNo,
    reason: reason || '用户申请退款',
    amount: { refund: amountFen, total: amountFen, currency: 'CNY' },
  }
  if (transactionId) payload.transaction_id = transactionId
  else payload.out_trade_no = orderNo
  const result = await wxV3Post('/v3/refund/domestic/refunds', payload)
  console.log('[wxV3Refund]', JSON.stringify(result))
  return result
}

// 微信支付V2签名（保留用于历史兼容；新流程走 V3）
function wxPaySign(params) {
  const crypto = require('crypto')
  const str = Object.keys(params).filter(k => params[k] !== '' && params[k] !== undefined).sort()
    .map(k => `${k}=${params[k]}`).join('&') + `&key=${WX_MCH_KEY}`
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase()
}

// V3 平台公钥（用 PEM 格式），用于验回调签名。需在 env 配置 WX_PLATFORM_PUBLIC_KEY
const WX_PLATFORM_PUBLIC_KEY = (process.env.WX_PLATFORM_PUBLIC_KEY || '').replace(/\\n/g, '\n')

// V3 回调验签：根据微信请求头 + body 校验
function wxV3VerifyCallback(headers, body) {
  if (!WX_PLATFORM_PUBLIC_KEY) return { ok: false, reason: 'platform public key not configured' }
  const crypto = require('crypto')
  const timestamp = headers['wechatpay-timestamp']
  const nonce = headers['wechatpay-nonce']
  const signature = headers['wechatpay-signature']
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing wechatpay headers' }
  const message = `${timestamp}\n${nonce}\n${body}\n`
  const verify = crypto.createVerify('RSA-SHA256')
  verify.update(message)
  const ok = verify.verify(WX_PLATFORM_PUBLIC_KEY, signature, 'base64')
  return { ok, reason: ok ? '' : 'signature mismatch' }
}

// V3 回调解密 resource（AES-256-GCM）
function wxV3DecryptResource(resource) {
  if (!WX_API_V3_KEY) throw new Error('WX_API_V3_KEY not configured')
  const crypto = require('crypto')
  const { ciphertext, nonce, associated_data } = resource
  const buf = Buffer.from(ciphertext, 'base64')
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(0, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', WX_API_V3_KEY, nonce)
  decipher.setAuthTag(tag)
  if (associated_data) decipher.setAAD(Buffer.from(associated_data))
  const plain = Buffer.concat([decipher.update(data), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

// 对象转XML
function toXml(obj) {
  return '<xml>' + Object.keys(obj).map(k => `<${k}><![CDATA[${obj[k]}]]></${k}>`).join('') + '</xml>'
}

// XML转对象
function fromXml(xml) {
  const result = {}
  xml.replace(/<(\w+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g, (_, k, v) => { result[k] = v })
  return result
}

function miniAuth(req, res, next) {
  const token = req.headers['mini-token']
  if (!token) return fail(res, '请先登录', 401)
  try {
    const decoded = jwt.verify(token, MINI_JWT_SECRET)
    req.miniUser = decoded
    next()
  } catch {
    return fail(res, 'token无效或已过期', 401)
  }
}

// 公开内容接口可匿名访问；携带有效 token 时补充点赞状态。
function optionalMiniAuth(req, _res, next) {
  const token = req.headers['mini-token']
  if (token) {
    try { req.miniUser = jwt.verify(token, MINI_JWT_SECRET) } catch {}
  }
  next()
}

// 微信code换openid
app.post('/miniapi/auth/wxLogin', async (req, res) => {
  try {
    const { code } = req.body
    if (!code) return fail(res, 'code不能为空')
    const https = require('https')
    const wxRes = await new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
      https.get(url, (r) => {
        let data = ''
        r.on('data', d => data += d)
        r.on('end', () => resolve(JSON.parse(data)))
      }).on('error', reject)
    })
    if (wxRes.errcode) return fail(res, wxRes.errmsg || '微信登录失败')
    const { openid } = wxRes
    const found = await pool.query(`SELECT * FROM mini_users WHERE openid=$1 AND deleted_at IS NULL LIMIT 1`, [openid])
    if (found.rows.length > 0) {
      const user = found.rows[0]
      const token = jwt.sign({ id: user.id, openid, phone: user.phone }, MINI_JWT_SECRET, { expiresIn: '30d' })
      return ok(res, { token, user: { id: user.id, name: user.name, phone: user.phone } })
    }
    return ok(res, { openid })
  } catch (e) { fail(res, e.message) }
})

// 微信授权手机号登录（getPhoneNumber code方式）
app.post('/miniapi/auth/phoneLogin', async (req, res) => {
  try {
    const { phoneCode, openid } = req.body
    if (!phoneCode || !openid) return fail(res, '参数缺失')

    // 获取 access_token
    const tokenRes = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`)
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) return fail(res, '获取access_token失败')

    // 用 code 换手机号
    const phoneRes = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${tokenData.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: phoneCode })
    })
    const phoneData = await phoneRes.json()
    if (phoneData.errcode !== 0) return fail(res, phoneData.errmsg || '获取手机号失败')

    const phone = phoneData.phone_info.phoneNumber

    let user = (await pool.query(`SELECT * FROM mini_users WHERE openid=$1 AND deleted_at IS NULL LIMIT 1`, [openid])).rows[0]
    if (!user) {
      const ins = await pool.query(
        `INSERT INTO mini_users (openid, phone, name, created_at) VALUES ($1,$2,$3,NOW()) RETURNING *`,
        [openid, phone, phone]
      )
      user = ins.rows[0]
      await pool.query(
        `INSERT INTO shop_customer (name, mobile, source, created_at) VALUES ($1,$2,'小程序',NOW()) ON CONFLICT DO NOTHING`,
        [phone, phone]
      ).catch(() => {})
      // 新客自动发两张满减券（按手机号防重，避免换 openid 重复领）
      try {
        const phoneAlreadyHasNewCoupon = parseInt((await pool.query(
          `SELECT COUNT(*) FROM mini_user_coupons uc
           JOIN mini_users u ON u.id=uc.user_id
           JOIN mini_coupons c ON c.id=uc.coupon_id
           WHERE u.phone=$1 AND c.type='new_user'`, [phone]
        )).rows[0].count)
        if (phoneAlreadyHasNewCoupon === 0) {
          const newUserCoupons = (await pool.query(`SELECT id, validity_days FROM mini_coupons WHERE type='new_user' AND status=1`)).rows
          for (const c of newUserCoupons) {
            const expireAt = new Date(Date.now() + c.validity_days * 86400000)
            await pool.query(`INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,'new_user',0,$3)`, [user.id, c.id, expireAt])
            await pool.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [c.id])
          }
        }
      } catch {}
    } else if (!user.phone) {
      await pool.query(`UPDATE mini_users SET phone=$1, name=$2 WHERE id=$3`, [phone, phone, user.id])
      user.phone = phone; user.name = phone
    }

    const token = jwt.sign({ id: user.id, openid, phone: user.phone }, MINI_JWT_SECRET, { expiresIn: '30d' })
    return ok(res, { token, user: { id: user.id, name: user.name, phone: user.phone } })
  } catch (e) { fail(res, e.message) }
})

// 绑定手机号（旧接口保留）
app.post('/miniapi/auth/bindPhone', async (req, res) => {
  try {
    const { phone, code, openid } = req.body
    if (!phone || !openid) return fail(res, '参数缺失')
    let user = (await pool.query(`SELECT * FROM mini_users WHERE phone=$1 AND deleted_at IS NULL LIMIT 1`, [phone])).rows[0]
    const isNewUser = !user
    if (!user) {
      const ins = await pool.query(
        `INSERT INTO mini_users (openid, phone, name, created_at) VALUES ($1,$2,$3,NOW()) RETURNING *`,
        [openid, phone, phone]
      )
      user = ins.rows[0]
      await pool.query(
        `INSERT INTO shop_customer (name, mobile, source, created_at) VALUES ($1,$2,'小程序',NOW()) ON CONFLICT DO NOTHING`,
        [phone, phone]
      ).catch(() => {})
      // 新客自动发两张满减券（按手机号防重，避免换 openid 重复领）
      try {
        const phoneAlreadyHasNewCoupon = parseInt((await pool.query(
          `SELECT COUNT(*) FROM mini_user_coupons uc
           JOIN mini_users u ON u.id=uc.user_id
           JOIN mini_coupons c ON c.id=uc.coupon_id
           WHERE u.phone=$1 AND c.type='new_user'`, [phone]
        )).rows[0].count)
        if (phoneAlreadyHasNewCoupon === 0) {
          const newUserCoupons = (await pool.query(`SELECT id, validity_days FROM mini_coupons WHERE type='new_user' AND status=1`)).rows
          for (const c of newUserCoupons) {
            const expireAt = new Date(Date.now() + c.validity_days * 86400000)
            await pool.query(`INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,'new_user',0,$3)`, [user.id, c.id, expireAt])
            await pool.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [c.id])
          }
        }
      } catch {}
    }
    const token = jwt.sign({ id: user.id, openid, phone: user.phone }, MINI_JWT_SECRET, { expiresIn: '30d' })
    return ok(res, { token, user: { id: user.id, name: user.name, phone: user.phone } })
  } catch (e) { fail(res, e.message) }
})

// 商品分类
app.get('/miniapi/goods/categories', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name FROM goods_cate WHERE status=1 ORDER BY sort ASC, id ASC LIMIT 20`)
    return ok(res, r.rows)
  } catch (e) { fail(res, e.message) }
})

const BRAND_BASE = 'https://nomaderp.pages.dev'

// 相对路径补全为绝对 URL（品牌主页图片都托管在 nomaderp.pages.dev）
function toAbsUrl(url) {
  if (!url) return ''
  if (url.startsWith('http')) return url
  return BRAND_BASE + (url.startsWith('/') ? '' : '/') + url
}

// 解析品牌主页字段（与 shopStore.ts 保持一致）
function parseBrandGoods(row) {
  let brand = {}
  try { brand = JSON.parse(row.remark || '{}')['__brand__'] || {} } catch {}
  const rawImg = brand.image || (row.images ? row.images.split(',')[0] : '') || ''
  return {
    id: row.id,
    name: row.goods_name || '',
    image_url: toAbsUrl(rawImg),
    header_images: (brand.headerImages || []).map(toAbsUrl),
    detail_images: (brand.detailImages && brand.detailImages.length
      ? brand.detailImages
      : (brand.detailImage ? [brand.detailImage] : [])
    ).map(toAbsUrl),
    sale_price: parseFloat(row.sell_price) || 0,
    unit: row.unit_name || '件',
    spec: row.spec || '',
    barcode: row.barcode || '',
    description: brand.description || row.goods_memo || '',
    tags: brand.tags || [],
    category: brand.category || '',
    skuVariants: brand.skuVariants
      ? brand.skuVariants.map(v => ({ ...v, image: v.image ? toAbsUrl(v.image) : '' }))
      : null,
    rating: brand.rating || 5.0,
    wholesalePrice: brand.wholesalePrice || 0,
    minOrderQuantity: brand.minOrderQuantity || 1,
    sort: row.sort || 0,
    baseSales: brand.baseSales || 0,
  }
}

async function getOptionalMiniUser(req) {
  const token = req.headers['mini-token']
  if (!token) return null
  try {
    const decoded = jwt.verify(token, MINI_JWT_SECRET)
    const user = (await pool.query(
      `SELECT id, distributor_code FROM mini_users WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [decoded.id]
    )).rows[0]
    return user || null
  } catch {
    return null
  }
}

async function getDistributorScope(req) {
  await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS distributor_code VARCHAR(20) DEFAULT ''`).catch(() => {})
  const user = await getOptionalMiniUser(req)
  const boundCode = String(user?.distributor_code || '').trim()
  const requestCode = String(req.query.distributor_code || req.body?.distributor_code || '').trim()
  const code = boundCode || requestCode
  if (!code) return { code: '', distributor: null, restricted: false, allowedIds: [], hiddenIds: [] }
  const distributor = (await pool.query(
    `SELECT id, code FROM distributors WHERE code=$1 AND status=1 LIMIT 1`,
    [code]
  )).rows[0]
  if (!distributor) return { code: '', distributor: null, restricted: false, allowedIds: [], hiddenIds: [] }
  const goodsRows = (await pool.query(
    `SELECT goods_id FROM distributor_goods
     WHERE distributor_id=$1 AND status=1`,
    [distributor.id]
  )).rows
  const hiddenRows = (await pool.query(
    `SELECT goods_id FROM distributor_hidden_goods WHERE distributor_id=$1`,
    [distributor.id]
  )).rows
  const hiddenIds = hiddenRows.map(r => parseInt(r.goods_id)).filter(Boolean)
  const hiddenSet = new Set(hiddenIds)
  return {
    code: distributor.code,
    distributor,
    restricted: goodsRows.length > 0,
    allowedIds: goodsRows.map(r => parseInt(r.goods_id)).filter(id => id && !hiddenSet.has(id)),
    hiddenIds,
  }
}

// 商品列表 — 只返回品牌主页标记 show:true 的商品（与 shopStore.ts 逻辑一致）
app.get('/miniapi/goods/list', async (req, res) => {
  try {
    const { page = 1, list_rows = 10, category_id, keyword } = req.query
    const pageNum = parseInt(page), pageSize = parseInt(list_rows)
    const params = []
    let where = `WHERE deleted_at IS NULL AND status=1 AND can_sale=1`
    const distScope = await getDistributorScope(req)
    if (distScope.restricted) {
      params.push(distScope.allowedIds)
      where += ` AND id=ANY($${params.length})`
    }
    if (category_id) { params.push(category_id); where += ` AND cate_id=$${params.length}` }
    if (keyword) { params.push(`%${keyword}%`); where += ` AND goods_name ILIKE $${params.length}` }
    // 拉全量（≤500），在 Node 里过滤 show:true，与品牌主页 .filter(p=>p.show===true) 一致
    const rows = (await pool.query(
      `SELECT id, goods_name, images, remark, sell_price, unit_name, spec, barcode, goods_memo, sort,
              owner_type, owner_distributor_id, platform_fee_rate
       FROM goods ${where} ORDER BY sort ASC, id DESC LIMIT 500`,
      params
    )).rows
    // 配置了分销商品池时，以商品池为准；未配置时仍只展示品牌主页已上架商品。
    const hiddenSet = new Set(distScope.hiddenIds || [])
    const brandRows = (distScope.restricted ? rows : rows.filter(g => {
      try { return JSON.parse(g.remark || '{}')['__brand__']?.show === true } catch { return false }
    })).filter(g => !hiddenSet.has(Number(g.id))).filter(g =>
      (g.owner_type || 'official') === 'official' ||
      Number(g.owner_distributor_id || 0) === Number(distScope.distributor?.id || 0)
    )
    // 按基础销量降序排列
    brandRows.sort((a, b) => {
      const getBase = g => { try { return JSON.parse(g.remark || '{}')['__brand__']?.baseSales || 0 } catch { return 0 } }
      return getBase(b) - getBase(a)
    })
    const total = brandRows.length
    const pageSlice = brandRows.slice((pageNum - 1) * pageSize, pageNum * pageSize)
    // 批量查销量
    const goodsIds = pageSlice.map(g => g.id)
    let salesMap = {}
    let reviewMap = {}
    let stockMap = {}
    if (goodsIds.length) {
      const salesRows = (await pool.query(
        `SELECT i.goods_id, COALESCE(SUM(i.qty),0) as total FROM mini_order_items i JOIN mini_orders o ON o.id=i.order_id WHERE i.goods_id=ANY($1) AND o.status>=1 GROUP BY i.goods_id`,
        [goodsIds]
      )).rows
      salesRows.forEach(r => { salesMap[r.goods_id] = parseInt(r.total) })
      const revRows = (await pool.query(
        `SELECT goods_id, AVG(rating)::numeric(3,1) as avg, COUNT(*) as cnt FROM mini_reviews WHERE goods_id=ANY($1) GROUP BY goods_id`,
        [goodsIds]
      )).rows
      revRows.forEach(r => { reviewMap[r.goods_id] = { avg: parseFloat(r.avg), cnt: parseInt(r.cnt) } })
      const stockRows = (await pool.query(
        `SELECT goods_id, COALESCE(SUM(qty),0) as total FROM stock_inventory WHERE goods_id=ANY($1) GROUP BY goods_id`,
        [goodsIds]
      )).rows
      stockRows.forEach(r => { stockMap[r.goods_id] = parseInt(r.total) })
    }
    const pageData = pageSlice.map(g => {
      const item = parseBrandGoods(g)
      item.sales_count = (salesMap[g.id] || 0) + item.baseSales
      item.avg_rating = reviewMap[g.id]?.avg || 0
      item.review_count = reviewMap[g.id]?.cnt || 0
      item.stock = stockMap[g.id] || 0
      return item
    })
    return ok(res, { rows: pageData, total, page: pageNum, list_rows: pageSize })
  } catch (e) { fail(res, e.message) }
})

// 商品详情
app.get('/miniapi/goods/detail/:id', async (req, res) => {
  try {
    const distScope = await getDistributorScope(req)
    if (distScope.restricted && !distScope.allowedIds.includes(parseInt(req.params.id))) {
      return fail(res, '该商品不在当前分销商可售范围')
    }
    const r = await pool.query(`SELECT * FROM goods WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [req.params.id])
    if (!r.rows[0]) return fail(res, '商品不存在')
    const goods = parseBrandGoods(r.rows[0])
    const stock = await pool.query(`SELECT COALESCE(SUM(qty),0) as total FROM stock_inventory WHERE goods_id=$1`, [r.rows[0].id])
    goods.stock = parseInt(stock.rows[0].total)
    // 销量统计
    const salesRow = (await pool.query(
      `SELECT COALESCE(SUM(i.qty),0) as total FROM mini_order_items i JOIN mini_orders o ON o.id=i.order_id WHERE i.goods_id=$1 AND o.status>=1`,
      [r.rows[0].id]
    )).rows[0]
    goods.sales_count = parseInt(salesRow.total) + (goods.baseSales || 0)
    // 评价摘要
    const revRow = (await pool.query(
      `SELECT AVG(rating)::numeric(3,1) as avg, COUNT(*) as cnt FROM mini_reviews WHERE goods_id=$1`,
      [r.rows[0].id]
    )).rows[0]
    goods.avg_rating = parseFloat(revRow.avg) || 0
    goods.review_count = parseInt(revRow.cnt)
    const reviewRows = (await pool.query(
      `SELECT r.id, r.rating, r.content, r.created_at, r.images,
              COALESCE(u.name, u.phone, '匿名用户') as user_name
       FROM mini_reviews r LEFT JOIN mini_users u ON u.id=r.user_id
       WHERE r.goods_id=$1 ORDER BY r.id DESC LIMIT 10`,
      [r.rows[0].id]
    )).rows
    goods.reviews = reviewRows
    return ok(res, goods)
  } catch (e) { fail(res, e.message) }
})

// 创建订单
app.post('/miniapi/order/create', miniAuth, async (req, res) => {
  try {
    const { items, address, remark, distributor_code, delivery_type, store_id } = req.body
    const deliveryType = parseInt(delivery_type ?? 0)
    if (!items || items.length === 0) return fail(res, '订单不能为空')
    // 物流/跑腿需要地址；自提不需要
    if (deliveryType !== 2) {
      if (!address || !address.name || !address.phone || !address.detail) return fail(res, '请填写收货地址')
    }

    // 服务端重新计算总价，不信任客户端传值
    const goodsIds = items.map(i => i.goods_id).filter(Boolean)
    if (goodsIds.length === 0) return fail(res, '商品信息有误')
    const goodsRows = (await pool.query(
      `SELECT id, goods_name as name, sell_price as price, owner_type, owner_distributor_id, platform_fee_rate
       FROM goods WHERE id = ANY($1) AND status=1 AND can_sale=1`,
      [goodsIds]
    )).rows
    const goodsMap = Object.fromEntries(goodsRows.map(g => [g.id, g]))

    let originalTotal = 0
    const validItems = []
    for (const item of items) {
      const g = goodsMap[item.goods_id]
      if (!g) return fail(res, `商品不存在: ${item.goods_id}`)
      const qty = Math.max(1, parseInt(item.qty) || 1)
      const price = parseFloat(g.price)
      originalTotal += price * qty
      validItems.push({ goods_id: g.id, goods_name: g.name, spec: item.spec || '', price, qty,
        owner_type: g.owner_type || 'official', owner_distributor_id: Number(g.owner_distributor_id || 0),
        platform_fee_rate: g.platform_fee_rate })
    }
    originalTotal = Math.round(originalTotal * 100) / 100

    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS distributor_code VARCHAR(20) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS platform_fee_rate NUMERIC(5,2) DEFAULT 10`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS settlement_cycle_days INT DEFAULT 7`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS agreement_type VARCHAR(20) DEFAULT 'offline'`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS agreement_no VARCHAR(80) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS agreement_url TEXT DEFAULT ''`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS agreement_start DATE`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS agreement_end DATE`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS sub_mchid VARCHAR(40) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS merchant_onboarding_status VARCHAR(30) DEFAULT 'not_started'`)
    await pool.query(`ALTER TABLE distributors ADD COLUMN IF NOT EXISTS settlement_mode VARCHAR(30) DEFAULT 'manual'`)

    // 会员折扣
    const userRow = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [req.miniUser.id])).rows[0]
    const userLevel = calcLevel(userRow || {})
    const levelInfo = MEMBER_LEVELS[userLevel]
    const discount = levelInfo.discount

    // 积分抵扣
    const requestedPoints = Math.max(0, parseInt(req.body.use_points || 0) || 0)
    const usePoints = Math.min(requestedPoints, userRow?.points || 0)
    const pointsDeduct = Math.floor(usePoints / POINTS_REDEEM_RATE * 100) / 100

    // 优惠券抵扣
    const userCouponId = parseInt(req.body.user_coupon_id || 0)
    let couponDeduct = 0, usedCoupon = null
    if (userCouponId) {
      const uc = (await pool.query(
        `SELECT uc.*, c.discount_value, c.min_order, c.name FROM mini_user_coupons uc JOIN mini_coupons c ON c.id=uc.coupon_id WHERE uc.id=$1 AND uc.user_id=$2 AND uc.status=0`,
        [userCouponId, req.miniUser.id]
      )).rows[0]
      if (uc && new Date(uc.expire_at) > new Date() && originalTotal * discount >= parseFloat(uc.min_order)) {
        couponDeduct = parseFloat(uc.discount_value)
        usedCoupon = uc
      }
    }
    if (userCouponId && !usedCoupon) return fail(res, '优惠券不可用或未满足使用门槛')

    let serverTotal = Math.max(0, Math.round((originalTotal * discount - pointsDeduct - couponDeduct) * 100) / 100)

    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS coupon_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS coupon_deduct NUMERIC(8,2) DEFAULT 0`)
    const orderNo = genOrderNo('MP')
    const client = await pool.connect()
    let order
    try {
      await client.query('BEGIN')

      const lockedMiniUser = (await client.query(
        `SELECT points, distributor_code FROM mini_users WHERE id=$1 FOR UPDATE`,
        [req.miniUser.id]
      )).rows[0]
      if (!lockedMiniUser) {
        const err = new Error('用户不存在')
        err.userMessage = err.message
        throw err
      }

      if (usePoints > 0) {
        if ((lockedMiniUser.points || 0) < usePoints) {
          const err = new Error('积分余额不足')
          err.userMessage = err.message
          throw err
        }
      }

      if (usedCoupon) {
        const lockedCoupon = (await client.query(
          `SELECT id FROM mini_user_coupons
           WHERE id=$1 AND user_id=$2 AND status=0 AND expire_at>NOW()
           FOR UPDATE`,
          [userCouponId, req.miniUser.id]
        )).rows[0]
        if (!lockedCoupon) {
          const err = new Error('优惠券已使用或已过期')
          err.userMessage = err.message
          throw err
        }
      }

      // 分销商佣金
      let distCode = '', distCommission = 0, activeDistributorId = 0, activePromotionRate = 0
      const requestedDistCode = String(distributor_code || '').trim()
      const boundDistCode = String(lockedMiniUser.distributor_code || '').trim()
      const effectiveDistCode = boundDistCode || requestedDistCode
      if (effectiveDistCode) {
        const distRow = (await client.query(
          `SELECT d.id, d.code, d.commission_rate as own_rate, cl.commission_rate as level_rate
           FROM distributors d
           LEFT JOIN sale_customers c ON c.mobile=d.phone AND c.deleted_at IS NULL
           LEFT JOIN customer_levels cl ON cl.name=c.level_name
           WHERE d.code=$1 AND d.status=1 LIMIT 1`, [effectiveDistCode]
        )).rows[0]
        if (distRow) {
          distCode = distRow.code
          activeDistributorId = Number(distRow.id)
          if (!boundDistCode && requestedDistCode) {
            await client.query(`UPDATE mini_users SET distributor_code=$1 WHERE id=$2`, [distCode, req.miniUser.id])
          }
          // 分销商自己设了佣金率就用自己的，否则用等级统一设置
          const rate = parseFloat(distRow.own_rate ?? distRow.level_rate ?? 0)
          activePromotionRate = rate
          distCommission = Math.round(serverTotal * rate / 100 * 100) / 100
          const configuredGoods = (await client.query(
            `SELECT goods_id FROM distributor_goods WHERE distributor_id=$1 AND status=1`,
            [distRow.id]
          )).rows.map(r => parseInt(r.goods_id))
          if (configuredGoods.length) {
            const allowed = new Set(configuredGoods)
            const blocked = validItems.filter(i =>
              i.owner_type !== 'distributor' && !allowed.has(parseInt(i.goods_id))
            ).map(i => i.goods_name)
            if (blocked.length) {
              const err = new Error(`商品「${blocked[0]}」不在该分销商可售范围`)
              err.userMessage = err.message
              throw err
            }
          }
        }
      }
      const invalidSelfItem = validItems.find(i => i.owner_type === 'distributor' && i.owner_distributor_id !== activeDistributorId)
      if (invalidSelfItem) {
        const err = new Error(`商品「${invalidSelfItem.goods_name}」仅限所属分销商店铺销售`)
        err.userMessage = err.message
        throw err
      }

      // 自提时查门店信息
      let storeRow = null
      if (deliveryType === 2 && store_id) {
        storeRow = (await client.query(`SELECT id, name, address FROM retail_stores WHERE id=$1 AND status=1`, [parseInt(store_id)])).rows[0]
      }

      // 锁库存 + 校验 + 扣减（防超卖）
      const stockSnapshot = []
      for (const item of validItems) {
        const inv = (await client.query(
          `SELECT qty, warehouse_id, warehouse_name FROM stock_inventory
           WHERE goods_id=$1 ORDER BY warehouse_id ASC LIMIT 1 FOR UPDATE`,
          [item.goods_id]
        )).rows[0]
        if (!inv) {
          const err = new Error(`商品「${item.goods_name}」库存未维护，请联系商家`)
          err.userMessage = err.message
          throw err
        }
        const before = parseFloat(inv.qty)
        if (before < item.qty) {
          const err = new Error(`商品「${item.goods_name}」库存不足，剩余 ${before}`)
          err.userMessage = err.message
          throw err
        }
        stockSnapshot.push({ ...item, warehouse_id: inv.warehouse_id, warehouse_name: inv.warehouse_name, before })
      }

      const r = await client.query(
        `INSERT INTO mini_orders (order_no, user_id, total_amount, original_amount, discount, points_used, coupon_id, coupon_deduct, address, remark, distributor_code, commission, delivery_type, store_id, store_name, store_address, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,NOW()) RETURNING *`,
        [orderNo, req.miniUser.id, serverTotal, originalTotal, discount, usePoints, userCouponId || 0, couponDeduct, JSON.stringify(address || {}), remark || '', distCode, distCommission, deliveryType, storeRow?.id || 0, storeRow?.name || '', storeRow?.address || '']
      )
      order = r.rows[0]

      for (const item of validItems) {
        const lineAmount = Math.round(item.price * item.qty * 100) / 100
        const platformRate = item.owner_type === 'distributor' ? Number(item.platform_fee_rate || 0) : 0
        const platformFee = Math.round(lineAmount * platformRate) / 100
        await client.query(
          `INSERT INTO mini_order_items
           (order_id,goods_id,goods_name,spec,price,qty,seller_type,seller_distributor_id,
            promotion_rate_snapshot,platform_fee_rate_snapshot,platform_fee_amount,seller_receivable_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [order.id,item.goods_id,item.goods_name,item.spec,item.price,item.qty,item.owner_type,
           item.owner_distributor_id,item.owner_type==='official'?activePromotionRate:0,platformRate,
           platformFee,item.owner_type==='distributor'?lineAmount-platformFee:0]
        )
      }

      // 真正扣库存 + 写流水
      for (const s of stockSnapshot) {
        const after = s.before - parseFloat(s.qty)
        await client.query(
          `UPDATE stock_inventory SET qty=$1, update_time=NOW() WHERE goods_id=$2 AND warehouse_id=$3`,
          [after, s.goods_id, s.warehouse_id]
        )
        await client.query(
          `INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark)
           VALUES ($1,$2,$3,$4,'mini_order',$5,$6,$7,$8,'小程序下单扣减')`,
          [s.goods_id, s.goods_name, s.warehouse_id, s.warehouse_name || '', -parseFloat(s.qty), s.before, after, orderNo]
        )
      }

      if (usePoints > 0) {
        await client.query(`UPDATE mini_users SET points=COALESCE(points,0)-$1 WHERE id=$2`, [usePoints, req.miniUser.id])
        await client.query(
          `INSERT INTO mini_points_log (user_id,points,type,remark,order_id,created_at)
           VALUES ($1,$2,'use','订单积分抵扣预扣',$3,NOW())`,
          [req.miniUser.id, -usePoints, order.id]
        )
      }

      if (usedCoupon) {
        await client.query(`UPDATE mini_user_coupons SET status=3, order_id=$1 WHERE id=$2`, [order.id, userCouponId])
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      if (e.userMessage) return fail(res, e.userMessage)
      throw e
    } finally {
      client.release()
    }

    return ok(res, { id: order.id, order_no: order.order_no, total_amount: serverTotal, original_amount: originalTotal, discount, points_used: usePoints, coupon_deduct: couponDeduct })
  } catch (e) { fail(res, e.message) }
})

// 订单列表
app.get('/miniapi/order/list', miniAuth, async (req, res) => {
  try {
    const { page = 1, list_rows = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(list_rows)
    const total = (await pool.query(`SELECT COUNT(*) FROM mini_orders WHERE user_id=$1 AND deleted_at IS NULL`, [req.miniUser.id])).rows[0].count
    const rows = (await pool.query(
      `SELECT * FROM mini_orders WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [req.miniUser.id, parseInt(list_rows), offset]
    )).rows
    for (const o of rows) {
      o.items = (await pool.query(`SELECT * FROM mini_order_items WHERE order_id=$1`, [o.id])).rows
    }
    return ok(res, { rows, total: parseInt(total) })
  } catch (e) { fail(res, e.message) }
})

// 订单详情
app.get('/miniapi/order/detail/:id', miniAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM mini_orders WHERE id=$1 AND user_id=$2 LIMIT 1`, [req.params.id, req.miniUser.id])
    if (!r.rows[0]) return fail(res, '订单不存在')
    const order = r.rows[0]
    order.items = (await pool.query(`SELECT * FROM mini_order_items WHERE order_id=$1`, [order.id])).rows
    // 标记每个商品是否已评价
    if (order.items.length) {
      const goodsIds = order.items.map(i => i.goods_id).filter(Boolean)
      const reviewed = (await pool.query(
        `SELECT goods_id FROM mini_reviews WHERE order_id=$1 AND goods_id=ANY($2)`,
        [order.id, goodsIds]
      )).rows.map(r => r.goods_id)
      order.items = order.items.map(i => ({ ...i, reviewed: reviewed.includes(i.goods_id) }))
    }
    order.address = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {})
    return ok(res, order)
  } catch (e) { fail(res, e.message) }
})

// 取消待支付订单并释放预扣积分/预占优惠券
app.post('/miniapi/order/cancel', miniAuth, async (req, res) => {
  const client = await pool.connect()
  try {
    const { order_id } = req.body
    if (!order_id) return fail(res, '缺少订单ID')
    // 取消前先查微信实际支付状态，避免"用户已付款但回调延迟到达"卡死
    const orderPre = (await pool.query(`SELECT order_no FROM mini_orders WHERE id=$1 AND user_id=$2 AND status=0 LIMIT 1`, [order_id, req.miniUser.id])).rows[0]
    if (orderPre?.order_no) {
      try {
        const wxQuery = await wxV3QueryOrder(orderPre.order_no)
        if (wxQuery?.status === 200 && wxQuery.body?.trade_state === 'SUCCESS') {
          // 微信确认已支付：把订单更新为已支付，回调进来后变 noop
          await pool.query(
            `UPDATE mini_orders SET status=1, paid_at=NOW(), wx_transaction_id=$2 WHERE id=$1 AND status=0`,
            [order_id, wxQuery.body.transaction_id || '']
          )
          return fail(res, '订单已支付成功，不可取消，请刷新查看')
        }
      } catch (e) {
        console.warn('[order/cancel] wx query failed (continuing to cancel):', e.message)
      }
    }
    await client.query('BEGIN')
    const order = (await client.query(
      `SELECT * FROM mini_orders WHERE id=$1 AND user_id=$2 AND status=0 FOR UPDATE`,
      [order_id, req.miniUser.id]
    )).rows[0]
    if (!order) {
      await client.query('ROLLBACK')
      return fail(res, '订单不存在或不可取消')
    }
    await releaseOrderBenefits(client, order)
    await client.query(`UPDATE mini_orders SET status=4 WHERE id=$1`, [order.id])
    await client.query('COMMIT')
    return ok(res, { id: order.id, status: 4 })
  } catch (e) {
    await client.query('ROLLBACK')
    return fail(res, e.message)
  } finally {
    client.release()
  }
})

// 确认收货（用户）→ 自动结算佣金
app.post('/miniapi/order/confirm', miniAuth, async (req, res) => {
  const { id } = req.body
  if (!id) return fail(res, '参数缺失')
  try {
    const order = (await pool.query(
      `SELECT o.*, u.openid FROM mini_orders o
       JOIN mini_users u ON u.id=o.user_id
       WHERE o.id=$1 AND o.user_id=$2 LIMIT 1`,
      [id, req.miniUser.id]
    )).rows[0]
    if (!order) return fail(res, '订单不存在')
    if (order.status !== 2) return fail(res, '订单未发货，无法确认')
    await pool.query(`UPDATE mini_orders SET status=3, confirmed_at=NOW() WHERE id=$1`, [id])
    // 分销佣金结算延后到冷静期满 7 天，由 settleEligibleCommissions cron 处理
    return ok(res, { id, status: 3 })
  } catch (e) {
    return fail(res, e.message)
  }
})

// ─── 分销商系统 ───────────────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distributors (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        name VARCHAR(100) DEFAULT '',
        phone VARCHAR(20) DEFAULT '',
        code VARCHAR(20) UNIQUE,
        commission_rate NUMERIC(5,2) DEFAULT 10.0,
        status INTEGER DEFAULT 0,
        apply_reason TEXT DEFAULT '',
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        approved_at TIMESTAMP
      )
    `)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS distributor_code VARCHAR(20) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS commission NUMERIC(8,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS commission_settled BOOLEAN DEFAULT FALSE`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS distributor_code VARCHAR(20) DEFAULT ''`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distributor_goods (
        id SERIAL PRIMARY KEY,
        distributor_id INT NOT NULL,
        goods_id INT NOT NULL,
        status INT DEFAULT 1,
        visible BOOLEAN DEFAULT TRUE,
        sort INT DEFAULT 0,
        custom_price NUMERIC(10,2) DEFAULT 0,
        commission_rate NUMERIC(5,2),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(distributor_id, goods_id)
      )
    `)
    await pool.query(`ALTER TABLE distributor_goods ADD COLUMN IF NOT EXISTS visible BOOLEAN DEFAULT TRUE`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distributor_hidden_goods (
        distributor_id INT NOT NULL,
        goods_id INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY(distributor_id, goods_id)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distributor_product_submissions (
        id SERIAL PRIMARY KEY,
        distributor_id INT NOT NULL,
        title VARCHAR(160) NOT NULL DEFAULT '',
        short_title VARCHAR(80) DEFAULT '',
        category VARCHAR(80) DEFAULT '',
        images JSONB DEFAULT '[]',
        detail_images JSONB DEFAULT '[]',
        description TEXT DEFAULT '',
        spec VARCHAR(160) DEFAULT '',
        unit_name VARCHAR(40) DEFAULT '件',
        suggested_price NUMERIC(12,2) DEFAULT 0,
        stock_qty NUMERIC(12,3) DEFAULT 0,
        freight_template VARCHAR(120) DEFAULT '',
        ship_origin VARCHAR(120) DEFAULT '',
        shipping_fee VARCHAR(120) DEFAULT '',
        delivery_time VARCHAR(120) DEFAULT '',
        qualification_urls JSONB DEFAULT '[]',
        platform_fee_rate NUMERIC(5,2),
        review_status VARCHAR(20) DEFAULT 'pending',
        review_note TEXT DEFAULT '',
        reviewed_by INT DEFAULT 0,
        reviewed_at TIMESTAMPTZ,
        goods_id INT DEFAULT 0,
        machine_review_status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `)
    await pool.query(`ALTER TABLE distributor_product_submissions ADD COLUMN IF NOT EXISTS short_title VARCHAR(80) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributor_product_submissions ADD COLUMN IF NOT EXISTS ship_origin VARCHAR(120) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributor_product_submissions ADD COLUMN IF NOT EXISTS shipping_fee VARCHAR(120) DEFAULT ''`)
    await pool.query(`ALTER TABLE distributor_product_submissions ADD COLUMN IF NOT EXISTS delivery_time VARCHAR(120) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS seller_type VARCHAR(20) DEFAULT 'official'`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS seller_distributor_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS promotion_rate_snapshot NUMERIC(5,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS platform_fee_rate_snapshot NUMERIC(5,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(12,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_order_items ADD COLUMN IF NOT EXISTS seller_receivable_amount NUMERIC(12,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE goods ADD COLUMN IF NOT EXISTS owner_type VARCHAR(20) DEFAULT 'official'`)
    await pool.query(`ALTER TABLE goods ADD COLUMN IF NOT EXISTS owner_distributor_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE goods ADD COLUMN IF NOT EXISTS platform_fee_rate NUMERIC(5,2)`)
    await pool.query(`
      INSERT INTO distributor_hidden_goods (distributor_id, goods_id)
      SELECT distributor_id, goods_id FROM distributor_goods WHERE visible IS FALSE
      ON CONFLICT (distributor_id, goods_id) DO NOTHING
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distributor_materials (
        id SERIAL PRIMARY KEY,
        title VARCHAR(120) NOT NULL DEFAULT '',
        type VARCHAR(20) NOT NULL DEFAULT 'text',
        content TEXT DEFAULT '',
        file_url TEXT DEFAULT '',
        file_urls TEXT DEFAULT '[]',
        cover_url TEXT DEFAULT '',
        source VARCHAR(20) DEFAULT 'upload',
        sync_url TEXT DEFAULT '',
        synced_at TIMESTAMPTZ,
        category VARCHAR(30) DEFAULT 'product',
        goods_id INT DEFAULT 0,
        scope VARCHAR(20) DEFAULT 'public',
        distributor_id INT DEFAULT 0,
        status INT DEFAULT 1,
        sort INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS file_urls TEXT DEFAULT '[]'`)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT ''`)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'upload'`)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS sync_url TEXT DEFAULT ''`)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE distributor_materials ADD COLUMN IF NOT EXISTS category VARCHAR(30) DEFAULT 'product'`)
    await pool.query(`
      UPDATE mini_users u
      SET distributor_code = first_orders.distributor_code
      FROM (
        SELECT DISTINCT ON (user_id) user_id, distributor_code
        FROM mini_orders
        WHERE COALESCE(distributor_code, '') != ''
          AND status NOT IN (4, 5)
          AND deleted_at IS NULL
        ORDER BY user_id, id ASC
      ) first_orders
      WHERE u.id = first_orders.user_id
        AND COALESCE(u.distributor_code, '') = ''
    `)
    // 客户等级价格表
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_levels (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      discount NUMERIC(5,2) DEFAULT 100,
      commission_rate NUMERIC(5,2) DEFAULT 0,
      sort INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
    await pool.query(`ALTER TABLE customer_levels ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 0`)
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_level_prices (
      id SERIAL PRIMARY KEY,
      level_id INT NOT NULL,
      goods_id INT NOT NULL,
      level_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      UNIQUE(level_id, goods_id)
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS distributor_bank_cards (
      id SERIAL PRIMARY KEY,
      distributor_id INT NOT NULL,
      bank_name VARCHAR(50) NOT NULL DEFAULT '',
      card_no VARCHAR(30) NOT NULL DEFAULT '',
      holder_name VARCHAR(50) NOT NULL DEFAULT '',
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS distributor_withdraws (
      id SERIAL PRIMARY KEY,
      distributor_id INT NOT NULL,
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      bank_card_id INT NOT NULL DEFAULT 0,
      bank_name VARCHAR(50) DEFAULT '',
      card_no_snapshot VARCHAR(30) DEFAULT '',
      holder_name_snapshot VARCHAR(50) DEFAULT '',
      status INT DEFAULT 0,
      reject_reason TEXT DEFAULT '',
      transfer_no VARCHAR(60) DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      handled_at TIMESTAMPTZ
    )`)
  } catch(e) { console.log('distributor init:', e.message) }
})()

// 申请成为分销商
app.post('/miniapi/distributor/apply', miniAuth, async (req, res) => {
  try {
    const { name, phone, reason } = req.body
    if (!name || !phone) return fail(res, '请填写姓名和手机号')
    const exists = (await pool.query(`SELECT id, status FROM distributors WHERE user_id=$1 LIMIT 1`, [req.miniUser.id])).rows[0]
    const notifyAdmin = (applicantName, applicantPhone, applicantReason) => {
      const key = process.env.SERVER_JIANG_KEY
      if (!key) return
      const title = encodeURIComponent('🔔 新分销商申请')
      const desp = encodeURIComponent(`姓名：${applicantName}\n手机：${applicantPhone}\n申请理由：${applicantReason || '无'}`)
      fetch(`https://sctapi.ftqq.com/${key}.send?title=${title}&desp=${desp}`).catch(() => {})
    }

    if (exists) {
      if (exists.status === 0) return fail(res, '您的申请正在审核中')
      if (exists.status === 1) return fail(res, '您已是分销商')
      // rejected → allow re-apply
      await pool.query(`UPDATE distributors SET name=$1, phone=$2, apply_reason=$3, status=0, created_at=NOW(), note='' WHERE id=$4`,
        [name, phone, reason || '', exists.id])
      notifyAdmin(name, phone, reason)
      return ok(res, { status: 0 })
    }
    await pool.query(
      `INSERT INTO distributors (user_id, name, phone, apply_reason, status, created_at) VALUES ($1,$2,$3,$4,0,NOW())`,
      [req.miniUser.id, name, phone, reason || '']
    )
    notifyAdmin(name, phone, reason)
    return ok(res, { status: 0 })
  } catch(e) { fail(res, e.message) }
})

// 查询自己的分销商状态 + 统计
app.get('/miniapi/distributor/me', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT * FROM distributors WHERE user_id=$1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return ok(res, null)
    if (dist.status !== 1) return ok(res, { status: dist.status, id: dist.id })
    // 统计佣金（排除已取消/退款）
    const stats = (await pool.query(
      `SELECT COUNT(*) as order_count,
              COALESCE(SUM(commission),0) as total_commission,
              COALESCE(SUM(CASE WHEN commission_settled=true THEN commission ELSE 0 END),0) as settled_commission,
              COALESCE(SUM(CASE WHEN status=3 AND commission_settled=false AND confirmed_at IS NOT NULL THEN commission ELSE 0 END),0) as cooling_commission
       FROM mini_orders
       WHERE distributor_code=$1 AND status NOT IN (4,5) AND deleted_at IS NULL`,
      [dist.code]
    )).rows[0]
    const totalCommission = parseFloat(stats.total_commission)
    const settledCommission = parseFloat(stats.settled_commission)
    return ok(res, {
      status: dist.status,
      id: dist.id,
      name: dist.name,
      code: dist.code,
      commission_rate: dist.commission_rate,
      order_count: parseInt(stats.order_count),
      total_commission: totalCommission,
      settled_commission: settledCommission,
      pending_commission: totalCommission - settledCommission,
      cooling_commission: parseFloat(stats.cooling_commission), // 冷静期内待结算
      cooling_days: COMMISSION_COOLING_DAYS,
    })
  } catch(e) { fail(res, e.message) }
})

// 分销商自己的订单明细
app.get('/miniapi/distributor/orders', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT code FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const { page = 1, list_rows = 20 } = req.query
    const offset = (parseInt(page)-1)*parseInt(list_rows)
    const total = parseInt((await pool.query(
      `SELECT COUNT(*) FROM mini_orders WHERE distributor_code=$1 AND status!=4 AND deleted_at IS NULL`, [dist.code]
    )).rows[0].count)
    const rows = (await pool.query(
      `SELECT id, order_no, total_amount, commission, status, created_at FROM mini_orders
       WHERE distributor_code=$1 AND status!=4 AND deleted_at IS NULL
       ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [dist.code, parseInt(list_rows), offset]
    )).rows
    return ok(res, { total, rows })
  } catch(e) { fail(res, e.message) }
})

// 分销商自己的可售商品
app.get('/miniapi/distributor/goods', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    let assigned = (await pool.query(
      `SELECT g.id, g.goods_name, g.images, g.remark, g.sell_price, g.unit_name, g.spec, g.barcode, g.goods_memo, g.sort
       FROM distributor_goods dg
       JOIN goods g ON g.id=dg.goods_id AND g.deleted_at IS NULL AND g.status=1 AND g.can_sale=1
       WHERE dg.distributor_id=$1 AND dg.status=1
       ORDER BY dg.sort ASC, dg.id DESC`,
      [dist.id]
    )).rows
    if (!assigned.length) {
      assigned = (await pool.query(
        `SELECT id, goods_name, images, remark, sell_price, unit_name, spec, barcode, goods_memo, sort
         FROM goods
         WHERE deleted_at IS NULL AND status=1 AND can_sale=1
         ORDER BY sort ASC, id DESC LIMIT 500`
      )).rows.filter(g => {
        try { return JSON.parse(g.remark || '{}')['__brand__']?.show === true } catch { return false }
      })
    }
    const hiddenRows = (await pool.query(
      `SELECT goods_id FROM distributor_hidden_goods WHERE distributor_id=$1`,
      [dist.id]
    )).rows
    const hiddenSet = new Set(hiddenRows.map(row => Number(row.goods_id)))
    const rows = assigned.map(g => ({ ...parseBrandGoods(g), visible: !hiddenSet.has(Number(g.id)) }))
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 分销商自主设置已授权商品是否向客户展示
app.post('/miniapi/distributor/goods/visibility', miniAuth, async (req, res) => {
  try {
    const goodsId = parseInt(req.body.goods_id)
    const visible = req.body.visible !== false
    if (!goodsId) return fail(res, 'goods_id必填')
    const dist = (await pool.query(
      `SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`,
      [req.miniUser.id]
    )).rows[0]
    if (!dist) return fail(res, '非分销商')
    const assignedCount = parseInt((await pool.query(
      `SELECT COUNT(*) FROM distributor_goods WHERE distributor_id=$1 AND status=1`,
      [dist.id]
    )).rows[0].count)
    if (assignedCount > 0) {
      const authorized = (await pool.query(
        `SELECT 1 FROM distributor_goods WHERE distributor_id=$1 AND goods_id=$2 AND status=1`,
        [dist.id, goodsId]
      )).rowCount > 0
      if (!authorized) return fail(res, '该商品未授权给当前分销商')
    } else {
      const goods = (await pool.query(
        `SELECT remark FROM goods WHERE id=$1 AND deleted_at IS NULL AND status=1 AND can_sale=1`,
        [goodsId]
      )).rows[0]
      let shown = false
      try { shown = JSON.parse(goods?.remark || '{}')['__brand__']?.show === true } catch {}
      if (!shown) return fail(res, '该商品当前不可展示')
    }
    if (visible) {
      await pool.query(
        `DELETE FROM distributor_hidden_goods WHERE distributor_id=$1 AND goods_id=$2`,
        [dist.id, goodsId]
      )
    } else {
      await pool.query(
        `INSERT INTO distributor_hidden_goods (distributor_id, goods_id)
         VALUES ($1,$2) ON CONFLICT (distributor_id, goods_id) DO NOTHING`,
        [dist.id, goodsId]
      )
    }
    return ok(res, { goods_id: goodsId, visible })
  } catch(e) { fail(res, e.message) }
})

// 分销商自营商品投稿
app.get('/miniapi/distributor/product-submissions', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(
      `SELECT id, platform_fee_rate FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`,
      [req.miniUser.id]
    )).rows[0]
    if (!dist) return fail(res, '非分销商')
    const rows = (await pool.query(
      `SELECT * FROM distributor_product_submissions
       WHERE distributor_id=$1 AND deleted_at IS NULL ORDER BY id DESC`,
      [dist.id]
    )).rows
    return ok(res, { rows, default_platform_fee_rate: parseFloat(dist.platform_fee_rate || 0) })
  } catch (e) { fail(res, e.message) }
})

app.post('/miniapi/distributor/product-submissions/save', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(
      `SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`,
      [req.miniUser.id]
    )).rows[0]
    if (!dist) return fail(res, '非分销商')
    const {
      id, title, short_title = '', category = '', images = [], detail_images = [], description = '',
      spec = '', unit_name = '件', suggested_price = 0, stock_qty = 0,
      freight_template = '', ship_origin = '', shipping_fee = '', delivery_time = '',
      qualification_urls = [],
    } = req.body
    if (!String(title || '').trim()) return fail(res, '商品名称必填')
    if (!Array.isArray(images) || !images.length) return fail(res, '至少上传一张商品图片')
    if (Number(suggested_price) <= 0) return fail(res, '商品价格必须大于0')
    if (id) {
      const old = (await pool.query(
        `SELECT * FROM distributor_product_submissions
         WHERE id=$1 AND distributor_id=$2 AND deleted_at IS NULL`,
        [id, dist.id]
      )).rows[0]
      if (!old) return fail(res, '商品申请不存在')
      if (old.review_status === 'approved') return fail(res, '已审核商品请在ERP申请修改')
      const row = (await pool.query(
        `UPDATE distributor_product_submissions SET
          title=$1,short_title=$2,category=$3,images=$4,detail_images=$5,description=$6,spec=$7,
          unit_name=$8,suggested_price=$9,stock_qty=$10,freight_template=$11,
          ship_origin=$12,shipping_fee=$13,delivery_time=$14,qualification_urls=$15,
          review_status='pending',review_note='',
          machine_review_status='pending',updated_at=NOW()
         WHERE id=$16 AND distributor_id=$17 RETURNING *`,
        [String(title).trim(), String(short_title).trim(), category, JSON.stringify(images.slice(0, 9)),
          JSON.stringify(detail_images.slice(0, 20)), description, spec, unit_name,
          Number(suggested_price), Number(stock_qty) || 0, freight_template,
          ship_origin, shipping_fee, delivery_time,
          JSON.stringify(qualification_urls.slice(0, 12)), id, dist.id]
      )).rows[0]
      return ok(res, row)
    }
    const row = (await pool.query(
      `INSERT INTO distributor_product_submissions
       (distributor_id,title,short_title,category,images,detail_images,description,spec,unit_name,
        suggested_price,stock_qty,freight_template,ship_origin,shipping_fee,delivery_time,qualification_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [dist.id, String(title).trim(), String(short_title).trim(), category, JSON.stringify(images.slice(0, 9)),
        JSON.stringify(detail_images.slice(0, 20)), description, spec, unit_name,
        Number(suggested_price), Number(stock_qty) || 0, freight_template,
        ship_origin, shipping_fee, delivery_time,
        JSON.stringify(qualification_urls.slice(0, 12))]
    )).rows[0]
    const notifyKey = process.env.SERVER_JIANG_KEY
    if (notifyKey) {
      const notifyTitle = encodeURIComponent('📦 新自营商品申请')
      const notifyDesp = encodeURIComponent(`商品：${String(title).trim()}\n价格：¥${Number(suggested_price).toFixed(2)}\n请进入 ERP「分销商管理 → 自营商品审核」处理。`)
      fetch(`https://sctapi.ftqq.com/${notifyKey}.send?title=${notifyTitle}&desp=${notifyDesp}`).catch(() => {})
    }
    return ok(res, row)
  } catch (e) { fail(res, e.message) }
})

// ERP后台 — 分销商自营商品审核与结算配置
app.get('/adminapi/distributor/product-submissions', auth, async (req, res) => {
  try {
    const params = []
    let where = `WHERE p.deleted_at IS NULL`
    if (req.query.status) { params.push(req.query.status); where += ` AND p.review_status=$${params.length}` }
    if (req.query.distributor_id) { params.push(parseInt(req.query.distributor_id)); where += ` AND p.distributor_id=$${params.length}` }
    const rows = (await pool.query(
      `SELECT p.*, d.name AS distributor_name, d.code AS distributor_code,
              d.platform_fee_rate AS distributor_platform_fee_rate
       FROM distributor_product_submissions p
       JOIN distributors d ON d.id=p.distributor_id
       ${where} ORDER BY p.id DESC`,
      params
    )).rows
    return ok(res, rows)
  } catch (e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/product-submissions/review', auth, async (req, res) => {
  try {
    const id = parseInt(req.body.id)
    const reviewStatus = String(req.body.review_status || '')
    if (!id || !['approved', 'rejected'].includes(reviewStatus)) return fail(res, '审核参数错误')
    let row = (await pool.query(
      `UPDATE distributor_product_submissions SET review_status=$1,review_note=$2,
       platform_fee_rate=COALESCE($3,platform_fee_rate),reviewed_by=$4,reviewed_at=NOW(),updated_at=NOW()
       WHERE id=$5 AND deleted_at IS NULL RETURNING *`,
      [reviewStatus, req.body.review_note || '',
        req.body.platform_fee_rate == null ? null : Number(req.body.platform_fee_rate),
        parseInt(req.admin?.id) || 0, id]
    )).rows[0]
    if (!row) return fail(res, '商品申请不存在')
    if (reviewStatus === 'approved' && !row.goods_id) {
      const brandRemark = JSON.stringify({ __brand__: {
        show: true, image: (row.images || [])[0] || '', headerImages: row.images || [],
        detailImages: row.detail_images || [], description: row.description || '',
        shortTitle: row.short_title || '', shipOrigin: row.ship_origin || '',
        shippingFee: row.shipping_fee || '', deliveryTime: row.delivery_time || '',
        category: row.category || '', baseSales: 0,
      }})
      const goods = (await pool.query(
        `INSERT INTO goods
         (goods_name,unit_name,spec,sell_price,stock,images,remark,status,can_sale,shop_id,
          owner_type,owner_distributor_id,platform_fee_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'distributor',$8,$9) RETURNING id`,
        [row.title, row.unit_name || '件', row.spec || '', row.suggested_price,
          row.stock_qty || 0, (row.images || []).join(','), brandRemark,
          row.distributor_id, row.platform_fee_rate]
      )).rows[0]
      await pool.query(
        `INSERT INTO stock_inventory
         (goods_id,goods_name,goods_code,unit_name,warehouse_id,warehouse_name,qty)
         VALUES ($1,$2,$3,$4,0,'分销商自营',$5)`,
        [
          goods.id,
          row.title,
          `DIST-${row.distributor_id}-${goods.id}`,
          row.unit_name || '件',
          Number(row.stock_qty || 0)
        ]
      )
      row = (await pool.query(
        `UPDATE distributor_product_submissions SET goods_id=$1,updated_at=NOW() WHERE id=$2 RETURNING *`,
        [goods.id, row.id]
      )).rows[0]
    }
    return ok(res, row)
  } catch (e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/settlement-config', auth, async (req, res) => {
  try {
    const id = parseInt(req.body.id)
    if (!id) return fail(res, '分销商ID必填')
    const row = (await pool.query(
      `UPDATE distributors SET platform_fee_rate=$1,settlement_cycle_days=$2,
       agreement_type=$3,agreement_no=$4,agreement_url=$5,agreement_start=$6,
       agreement_end=$7,sub_mchid=$8,merchant_onboarding_status=$9,settlement_mode=$10
       WHERE id=$11 RETURNING *`,
      [Number(req.body.platform_fee_rate) || 0, parseInt(req.body.settlement_cycle_days) || 7,
        req.body.agreement_type || 'offline', req.body.agreement_no || '',
        req.body.agreement_url || '', req.body.agreement_start || null,
        req.body.agreement_end || null, req.body.sub_mchid || '',
        req.body.merchant_onboarding_status || 'not_started',
        req.body.settlement_mode || 'manual', id]
    )).rows[0]
    return ok(res, row)
  } catch (e) { fail(res, e.message) }
})

// 分销商自己的素材库
app.get('/miniapi/distributor/materials', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const rows = (await pool.query(
      `SELECT m.*, g.goods_name
       FROM distributor_materials m
       LEFT JOIN goods g ON g.id=m.goods_id
       WHERE m.status=1
         AND (m.scope='public' OR (m.scope='distributor' AND m.distributor_id=$1))
       ORDER BY m.sort ASC, m.id DESC`,
      [dist.id]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 分销商的客户列表（下单过的用户，按累计佣金聚合）
app.get('/miniapi/distributor/customers', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT id, code FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const rows = (await pool.query(
      `SELECT u.id, u.nickname, u.avatar, u.phone,
              COUNT(o.id) AS order_count,
              COALESCE(SUM(o.total_amount),0) AS total_amount,
              COALESCE(SUM(o.commission),0) AS total_commission,
              MAX(o.created_at) AS last_order_at
       FROM mini_orders o
       JOIN mini_users u ON u.id=o.user_id
       WHERE o.distributor_code=$1 AND o.status NOT IN (4,5) AND o.deleted_at IS NULL
       GROUP BY u.id, u.nickname, u.avatar, u.phone
       ORDER BY last_order_at DESC`,
      [dist.code]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 分销商银行卡列表
app.get('/miniapi/distributor/bank-cards', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const rows = (await pool.query(
      `SELECT id, bank_name, card_no, holder_name, is_default, created_at
       FROM distributor_bank_cards WHERE distributor_id=$1 ORDER BY is_default DESC, id DESC`,
      [dist.id]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

app.post('/miniapi/distributor/bank-cards/add', miniAuth, async (req, res) => {
  try {
    const { bank_name, card_no, holder_name, is_default } = req.body
    if (!bank_name || !card_no || !holder_name) return fail(res, '请填写完整信息')
    if (!/^\d{12,25}$/.test(String(card_no))) return fail(res, '银行卡号格式不正确')
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const setDefault = Boolean(is_default) || parseInt((await pool.query(
      `SELECT COUNT(*) FROM distributor_bank_cards WHERE distributor_id=$1`, [dist.id]
    )).rows[0].count) === 0
    if (setDefault) {
      await pool.query(`UPDATE distributor_bank_cards SET is_default=false WHERE distributor_id=$1`, [dist.id])
    }
    await pool.query(
      `INSERT INTO distributor_bank_cards (distributor_id, bank_name, card_no, holder_name, is_default) VALUES ($1,$2,$3,$4,$5)`,
      [dist.id, bank_name, card_no, holder_name, setDefault]
    )
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

app.post('/miniapi/distributor/bank-cards/del', miniAuth, async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id必填')
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    await pool.query(`DELETE FROM distributor_bank_cards WHERE id=$1 AND distributor_id=$2`, [id, dist.id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// 分销商申请提现
app.post('/miniapi/distributor/withdraw/apply', miniAuth, async (req, res) => {
  try {
    const { amount, bank_card_id } = req.body
    const amt = parseFloat(amount)
    if (!(amt > 0)) return fail(res, '提现金额不正确')
    if (amt < 10) return fail(res, '提现金额至少 10 元')
    if (!bank_card_id) return fail(res, '请选择银行卡')
    const dist = (await pool.query(`SELECT id, code FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const card = (await pool.query(
      `SELECT bank_name, card_no, holder_name FROM distributor_bank_cards WHERE id=$1 AND distributor_id=$2`,
      [bank_card_id, dist.id]
    )).rows[0]
    if (!card) return fail(res, '银行卡不存在')
    // 可提现余额 = 已结算佣金 - 已申请中/处理中的提现
    const settled = parseFloat((await pool.query(
      `SELECT COALESCE(SUM(commission),0) AS s FROM mini_orders
       WHERE distributor_code=$1 AND commission_settled=true AND status NOT IN (4,5) AND deleted_at IS NULL`,
      [dist.code]
    )).rows[0].s)
    const locked = parseFloat((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM distributor_withdraws WHERE distributor_id=$1 AND status IN (0,1,2)`,
      [dist.id]
    )).rows[0].s)
    const available = settled - locked
    if (amt > available + 0.001) return fail(res, `可提现余额不足，当前可提 ¥${available.toFixed(2)}`)
    await pool.query(
      `INSERT INTO distributor_withdraws (distributor_id, amount, bank_card_id, bank_name, card_no_snapshot, holder_name_snapshot, status)
       VALUES ($1,$2,$3,$4,$5,$6,0)`,
      [dist.id, amt, bank_card_id, card.bank_name, card.card_no, card.holder_name]
    )
    const notifyKey = process.env.SERVER_JIANG_KEY
    if (notifyKey) {
      const notifyTitle = encodeURIComponent('💳 新分销提现申请')
      const notifyDesp = encodeURIComponent(`分销码：${dist.code}\n金额：¥${amt.toFixed(2)}\n收款人：${card.holder_name}\n请进入 ERP「分销提现审批」处理。`)
      fetch(`https://sctapi.ftqq.com/${notifyKey}.send?title=${notifyTitle}&desp=${notifyDesp}`).catch(() => {})
    }
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// 分销商提现记录
app.get('/miniapi/distributor/withdraw/list', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(`SELECT id FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id])).rows[0]
    if (!dist) return fail(res, '非分销商')
    const rows = (await pool.query(
      `SELECT id, amount, bank_name, card_no_snapshot, holder_name_snapshot, status, reject_reason, transfer_no, created_at, handled_at
       FROM distributor_withdraws WHERE distributor_id=$1 ORDER BY id DESC LIMIT 200`,
      [dist.id]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 分销商列表
app.get('/adminapi/distributor/list', auth, async (req, res) => {
  try {
    const { status, page = 1, list_rows = 20 } = req.query
    const offset = (parseInt(page)-1)*parseInt(list_rows)
    const where = status !== undefined ? `WHERE status=${parseInt(status)}` : ''
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM distributors ${where}`)).rows[0].count)
    const rows = (await pool.query(
      `SELECT d.*,
        (SELECT COUNT(*) FROM mini_orders WHERE distributor_code=d.code AND status!=4 AND deleted_at IS NULL) as order_count,
        COALESCE((SELECT SUM(commission) FROM mini_orders WHERE distributor_code=d.code AND status!=4 AND deleted_at IS NULL),0) as total_commission
       FROM distributors d ${where} ORDER BY d.id DESC LIMIT $1 OFFSET $2`,
      [parseInt(list_rows), offset]
    )).rows
    return ok(res, { total, rows })
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 分销商商品池
app.get('/adminapi/distributor/goods', auth, async (req, res) => {
  try {
    const distributorId = parseInt(req.query.distributor_id)
    if (!distributorId) return fail(res, 'distributor_id必填')
    const rows = (await pool.query(
      `SELECT dg.*, g.goods_name, g.goods_sn, g.sell_price, g.unit_name
       FROM distributor_goods dg
       LEFT JOIN goods g ON g.id=dg.goods_id
       WHERE dg.distributor_id=$1 AND dg.status=1
       ORDER BY dg.sort ASC, dg.id DESC`,
      [distributorId]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/goods/save', auth, async (req, res) => {
  const client = await pool.connect()
  try {
    const distributorId = parseInt(req.body.distributor_id)
    const goodsIds = Array.isArray(req.body.goods_ids) ? req.body.goods_ids.map(Number).filter(Boolean) : []
    if (!distributorId) return fail(res, 'distributor_id必填')
    await client.query('BEGIN')
    const visibilityRows = (await client.query(
      `SELECT goods_id, visible FROM distributor_goods WHERE distributor_id=$1`,
      [distributorId]
    )).rows
    const visibilityMap = new Map(visibilityRows.map(row => [Number(row.goods_id), row.visible !== false]))
    await client.query(`DELETE FROM distributor_goods WHERE distributor_id=$1`, [distributorId])
    for (let i = 0; i < goodsIds.length; i++) {
      await client.query(
        `INSERT INTO distributor_goods (distributor_id, goods_id, status, sort, visible)
         VALUES ($1,$2,1,$3,$4)
         ON CONFLICT (distributor_id, goods_id) DO UPDATE SET status=1, sort=$3, visible=$4`,
        [distributorId, goodsIds[i], i, visibilityMap.get(goodsIds[i]) !== false]
      )
    }
    await client.query('COMMIT')
    return ok(res)
  } catch(e) {
    await client.query('ROLLBACK').catch(() => {})
    fail(res, e.message)
  } finally {
    client.release()
  }
})

// ERP后台 — 分销素材库
app.get('/adminapi/distributor/materials', auth, async (req, res) => {
  try {
    const distributorId = parseInt(req.query.distributor_id || 0)
    const params = []
    let where = `WHERE m.status=1`
    if (distributorId) {
      params.push(distributorId)
      where += ` AND (m.scope='public' OR m.distributor_id=$${params.length})`
    }
    const rows = (await pool.query(
      `SELECT m.*, d.name as distributor_name, g.goods_name
       FROM distributor_materials m
       LEFT JOIN distributors d ON d.id=m.distributor_id
       LEFT JOIN goods g ON g.id=m.goods_id
       ${where}
       ORDER BY m.sort ASC, m.id DESC`,
      params
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/materials/save', auth, async (req, res) => {
  try {
    const {
      id, title, type = 'article', content = '', file_url = '', file_urls = [],
      cover_url = '', source = 'upload', sync_url = '', goods_id = 0,
      category = 'product', scope = 'public', distributor_id = 0, sort = 0,
    } = req.body
    if (!title) return fail(res, '标题必填')
    const normalizedFiles = Array.isArray(file_urls)
      ? file_urls.filter(Boolean).slice(0, 9)
      : (() => { try { return JSON.parse(file_urls || '[]').filter(Boolean).slice(0, 9) } catch { return [] } })()
    const filesJson = JSON.stringify(normalizedFiles)
    const syncedAt = source === 'sync' ? new Date() : null
    if (id) {
      const row = (await pool.query(
        `UPDATE distributor_materials
         SET title=$1,type=$2,content=$3,file_url=$4,file_urls=$5,cover_url=$6,
             source=$7,sync_url=$8,synced_at=$9,goods_id=$10,scope=$11,
             distributor_id=$12,sort=$13,category=$14,updated_at=NOW()
         WHERE id=$15 RETURNING *`,
        [
          title, type, content, file_url, filesJson, cover_url, source,
          sync_url, syncedAt, parseInt(goods_id) || 0, scope,
          parseInt(distributor_id) || 0, parseInt(sort) || 0, category, id,
        ]
      )).rows[0]
      return ok(res, row)
    }
    const row = (await pool.query(
      `INSERT INTO distributor_materials
       (title,type,content,file_url,file_urls,cover_url,source,sync_url,synced_at,goods_id,scope,distributor_id,sort,category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        title, type, content, file_url, filesJson, cover_url, source,
        sync_url, syncedAt, parseInt(goods_id) || 0, scope,
        parseInt(distributor_id) || 0, parseInt(sort) || 0, category,
      ]
    )).rows[0]
    return ok(res, row)
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/materials/del', auth, async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id必填')
    await pool.query(`UPDATE distributor_materials SET status=0, updated_at=NOW() WHERE id=$1`, [id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// ─── 客户等级 & 等级价格 ──────────────────────────────────────────────────────

// 等级列表
app.get('/adminapi/customer-level/list', auth, async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT * FROM customer_levels ORDER BY sort ASC, id ASC`)).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 新增等级
app.post('/adminapi/customer-level/add', auth, async (req, res) => {
  try {
    const { name, discount = 100, commission_rate = 0, sort = 0 } = req.body
    if (!name) return fail(res, '名称必填')
    const r = (await pool.query(
      `INSERT INTO customer_levels (name, discount, commission_rate, sort) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, parseFloat(discount), parseFloat(commission_rate), parseInt(sort)]
    )).rows[0]
    return ok(res, r)
  } catch(e) { fail(res, e.message) }
})

// 编辑等级
app.post('/adminapi/customer-level/edit', auth, async (req, res) => {
  try {
    const { id, name, discount, commission_rate, sort } = req.body
    if (!id) return fail(res, 'id必填')
    const r = (await pool.query(
      `UPDATE customer_levels SET name=COALESCE($1,name), discount=COALESCE($2,discount), commission_rate=COALESCE($3,commission_rate), sort=COALESCE($4,sort) WHERE id=$5 RETURNING *`,
      [name, discount != null ? parseFloat(discount) : null, commission_rate != null ? parseFloat(commission_rate) : null, sort != null ? parseInt(sort) : null, id]
    )).rows[0]
    return ok(res, r)
  } catch(e) { fail(res, e.message) }
})

// 删除等级
app.post('/adminapi/customer-level/del', auth, async (req, res) => {
  try {
    const { id } = req.body
    await pool.query(`DELETE FROM customer_levels WHERE id=$1`, [id])
    await pool.query(`DELETE FROM customer_level_prices WHERE level_id=$1`, [id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// 查某等级的所有商品价格
app.get('/adminapi/customer-level/prices', auth, async (req, res) => {
  try {
    const { level_id } = req.query
    if (!level_id) return fail(res, 'level_id必填')
    const rows = (await pool.query(
      `SELECT p.*, g.goods_name, g.goods_sn, g.unit_name, g.sell_price
       FROM customer_level_prices p
       LEFT JOIN goods g ON g.id=p.goods_id
       WHERE p.level_id=$1 ORDER BY p.id ASC`,
      [level_id]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 批量保存等级商品价格（upsert）
app.post('/adminapi/customer-level/prices/save', auth, async (req, res) => {
  try {
    const { level_id, goods_id, level_price } = req.body
    if (!level_id || !goods_id) return fail(res, '参数缺失')
    await pool.query(
      `INSERT INTO customer_level_prices (level_id, goods_id, level_price)
       VALUES ($1,$2,$3)
       ON CONFLICT (level_id, goods_id) DO UPDATE SET level_price=$3`,
      [level_id, goods_id, parseFloat(level_price)]
    )
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// 删除等级某商品价格
app.post('/adminapi/customer-level/prices/del', auth, async (req, res) => {
  try {
    const { level_id, goods_id } = req.body
    await pool.query(`DELETE FROM customer_level_prices WHERE level_id=$1 AND goods_id=$2`, [level_id, goods_id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// 小程序用：根据用户openid获取其等级价格表
app.get('/miniapi/level-prices', miniAuth, async (req, res) => {
  try {
    const customer = (await pool.query(
      `SELECT c.level_name FROM sale_customers c
       JOIN mini_users u ON u.phone=c.mobile
       WHERE u.id=$1 AND c.deleted_at IS NULL LIMIT 1`,
      [req.miniUser.id]
    )).rows[0]
    if (!customer) return ok(res, {})
    const level = (await pool.query(
      `SELECT id FROM customer_levels WHERE name=$1 LIMIT 1`,
      [customer.level_name]
    )).rows[0]
    if (!level) return ok(res, {})
    const prices = (await pool.query(
      `SELECT goods_id, level_price FROM customer_level_prices WHERE level_id=$1`,
      [level.id]
    )).rows
    const map = {}
    for (const p of prices) map[p.goods_id] = parseFloat(p.level_price)
    return ok(res, map)
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 审批通过
app.post('/adminapi/distributor/approve', auth, async (req, res) => {
  try {
    const { id, note = '' } = req.body
    if (!id) return fail(res, 'id必填')
    const dist = (await pool.query(`SELECT * FROM distributors WHERE id=$1 LIMIT 1`, [id])).rows[0]
    if (!dist) return fail(res, '不存在')
    const code = dist.code || `D${String(id).padStart(4,'0')}`
    // 从「分销商」等级取佣金率，没有则默认10
    const level = (await pool.query(
      `SELECT commission_rate FROM customer_levels WHERE name='分销商' LIMIT 1`
    )).rows[0]
    const commission_rate = level ? parseFloat(level.commission_rate) : 10
    await pool.query(
      `UPDATE distributors SET status=1, code=$1, commission_rate=$2, note=$3, approved_at=NOW() WHERE id=$4`,
      [code, commission_rate, note, id]
    )
    // 同步到ERP客户管理（按手机号去重）
    const existing = (await pool.query(
      `SELECT id FROM sale_customers WHERE mobile=$1 AND deleted_at IS NULL LIMIT 1`,
      [dist.phone]
    )).rows[0]
    if (existing) {
      await pool.query(
        `UPDATE sale_customers SET level_name='分销商', remark=CASE WHEN remark NOT LIKE '%分销码%' THEN CONCAT(remark, ' 分销码:', $1) ELSE remark END, update_time=NOW() WHERE id=$2`,
        [code, existing.id]
      )
    } else {
      await pool.query(
        `INSERT INTO sale_customers (name, mobile, level_name, source_name, remark, status, create_time, update_time)
         VALUES ($1, $2, '分销商', '小程序分销', $3, 1, NOW(), NOW())`,
        [dist.name, dist.phone, `分销码:${code}`]
      )
    }
    return ok(res, { code })
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 拒绝
app.post('/adminapi/distributor/reject', auth, async (req, res) => {
  try {
    const { id, note = '' } = req.body
    if (!id) return fail(res, 'id必填')
    await pool.query(`UPDATE distributors SET status=2, note=$1 WHERE id=$2`, [note, id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 修改佣金比例
app.post('/adminapi/distributor/edit', auth, async (req, res) => {
  try {
    const { id, commission_rate } = req.body
    if (!id) return fail(res, 'id必填')
    await pool.query(`UPDATE distributors SET commission_rate=$1 WHERE id=$2`, [parseFloat(commission_rate), id])
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// ERP后台 — 提现申请列表
app.get('/adminapi/distributor/withdraw/list', auth, async (req, res) => {
  try {
    const { status, page = 1, list_rows = 20 } = req.query
    const offset = (parseInt(page)-1)*parseInt(list_rows)
    const conds = []
    const params = []
    if (status !== undefined && status !== '') {
      params.push(parseInt(status))
      conds.push(`w.status=$${params.length}`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = parseInt((await pool.query(
      `SELECT COUNT(*) FROM distributor_withdraws w ${where}`, params
    )).rows[0].count)
    params.push(parseInt(list_rows), offset)
    const rows = (await pool.query(
      `SELECT w.*, d.name AS distributor_name, d.code AS distributor_code, d.phone AS distributor_phone
       FROM distributor_withdraws w
       LEFT JOIN distributors d ON d.id=w.distributor_id
       ${where}
       ORDER BY w.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    )).rows
    return ok(res, { total, rows })
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/withdraw/approve', auth, async (req, res) => {
  try {
    const { id, transfer_no = '' } = req.body
    if (!id) return fail(res, 'id必填')
    await pool.query(
      `UPDATE distributor_withdraws SET status=2, transfer_no=$1, handled_at=NOW() WHERE id=$2 AND status IN (0,1)`,
      [transfer_no, id]
    )
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/distributor/withdraw/reject', auth, async (req, res) => {
  try {
    const { id, reason = '' } = req.body
    if (!id) return fail(res, 'id必填')
    await pool.query(
      `UPDATE distributor_withdraws SET status=3, reject_reason=$1, handled_at=NOW() WHERE id=$2 AND status IN (0,1)`,
      [reason, id]
    )
    return ok(res)
  } catch(e) { fail(res, e.message) }
})

// ─── 小程序订单管理（ERP后台用，使用adminapi auth）─────────────────────────────

// 建表时补字段（运行时幂等）
;(async () => {
  try {
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS express_company VARCHAR(50) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS tracking_no VARCHAR(100) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP`)
    // delivery_type: 0=物流发货 1=跑腿送货 2=自提
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS delivery_type INT DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS store_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS store_name VARCHAR(100) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS store_address TEXT DEFAULT ''`)
  } catch(e) { console.log('mini_orders alter:', e.message) }
})()

// 门店列表（小程序端，无需登录）
app.get('/miniapi/stores', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, address, tel FROM retail_stores WHERE status=1 ORDER BY id ASC`)
    return ok(res, r.rows)
  } catch (e) { fail(res, e.message) }
})

// 订单列表（ERP后台）
app.get('/adminapi/mini/orders', auth, async (req, res) => {
  try {
    const { page = 1, list_rows = 20, status, keyword } = req.query
    const offset = (parseInt(page) - 1) * parseInt(list_rows)
    const conditions = ['o.deleted_at IS NULL']
    const params = []
    if (status !== undefined && status !== '') { params.push(parseInt(status)); conditions.push(`o.status=$${params.length}`) }
    if (keyword) { params.push(`%${keyword}%`); conditions.push(`(o.order_no ILIKE $${params.length} OR o.address::text ILIKE $${params.length} OR o.tracking_no ILIKE $${params.length})`) }
    const where = conditions.join(' AND ')
    const total = (await pool.query(`SELECT COUNT(*) FROM mini_orders o LEFT JOIN mini_users u ON u.id=o.user_id WHERE ${where}`, params)).rows[0].count
    params.push(parseInt(list_rows)); params.push(offset)
    const rows = (await pool.query(
      `SELECT o.*, u.phone as user_phone FROM mini_orders o LEFT JOIN mini_users u ON u.id=o.user_id WHERE ${where} ORDER BY o.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    )).rows
    for (const o of rows) {
      o.items = (await pool.query(`SELECT * FROM mini_order_items WHERE order_id=$1`, [o.id])).rows
      o.address = typeof o.address === 'string' ? JSON.parse(o.address || '{}') : (o.address || {})
    }
    return ok(res, { rows, total: parseInt(total) })
  } catch (e) { fail(res, e.message) }
})

// 发货（ERP后台）
app.post('/adminapi/mini/order/ship', auth, async (req, res) => {
  try {
    const { order_id, express_company, tracking_no } = req.body
    if (!order_id) return fail(res, '缺少订单ID')
    // 查订单的配送类型
    const orderRow = (await pool.query(`SELECT delivery_type FROM mini_orders WHERE id=$1 AND status=1`, [order_id])).rows[0]
    if (!orderRow) return fail(res, '订单不存在或状态不是待发货')
    const deliveryType = parseInt(orderRow.delivery_type ?? 0)
    // 物流发货必须有快递单号
    if (deliveryType === 0 && !tracking_no) return fail(res, '请填写快递单号')
    const r = await pool.query(
      `UPDATE mini_orders SET status=2, express_company=$1, tracking_no=$2, shipped_at=NOW() WHERE id=$3 AND status=1 RETURNING *`,
      [express_company || '', tracking_no || '', order_id]
    )
    if (!r.rows[0]) return fail(res, '操作失败')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

// 自提核销（ERP后台店员操作）：status=2 → 3，标记已被取货
app.post('/adminapi/mini/order/pickup-confirm', auth, async (req, res) => {
  try {
    const { order_id } = req.body
    if (!order_id) return fail(res, '缺少订单ID')
    const orderRow = (await pool.query(
      `SELECT delivery_type, status FROM mini_orders WHERE id=$1 AND deleted_at IS NULL`, [order_id]
    )).rows[0]
    if (!orderRow) return fail(res, '订单不存在')
    if (parseInt(orderRow.delivery_type) !== 2) return fail(res, '仅自提订单可核销')
    if (orderRow.status !== 2) return fail(res, '订单状态不是已备货，无法核销')
    const r = await pool.query(
      `UPDATE mini_orders SET status=3, confirmed_at=NOW() WHERE id=$1 AND status=2 AND delivery_type=2 RETURNING *`,
      [order_id]
    )
    if (!r.rows[0]) return fail(res, '操作失败（可能已被核销）')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

// V3 支付配置健康检查（管理员用）
app.get('/adminapi/wxpay/v3-health', auth, async (req, res) => {
  try {
    const config = {
      WX_APPID: !!WX_APPID,
      WX_MCH_ID: !!WX_MCH_ID,
      WX_MCH_PRIVATE_KEY: WX_MCH_PRIVATE_KEY ? `配置（${WX_MCH_PRIVATE_KEY.length} chars）` : '未配置',
      WX_MCH_CERT_SERIAL: WX_MCH_CERT_SERIAL || '未配置',
      WX_API_V3_KEY: WX_API_V3_KEY ? `配置（${WX_API_V3_KEY.length} chars）` : '未配置',
      WX_PLATFORM_PUBLIC_KEY: WX_PLATFORM_PUBLIC_KEY ? `配置（${WX_PLATFORM_PUBLIC_KEY.length} chars）` : '未配置',
      WX_MCH_PUBLIC_KEY_ID: WX_MCH_PUBLIC_KEY_ID || '未配置',
    }
    // 调微信 /v3/certificates 测签名是否被接受
    // 公钥模式下此接口返回 404 RESOURCE_NOT_EXISTS 是预期行为（说明微信认证通过，只是不再发证书）
    let signTest = { ok: false }
    try {
      const result = await wxV3Get('/v3/certificates')
      signTest.status = result.status
      const isPublicKeyMode = result.status === 404 && result.body?.code === 'RESOURCE_NOT_EXISTS'
      if (result.status === 200) {
        signTest.ok = true
        signTest.note = '签名通过，平台已下发证书（证书模式）'
      } else if (isPublicKeyMode) {
        signTest.ok = true
        signTest.note = '签名通过，当前为公钥模式（404 是预期行为）'
      } else if (result.status === 401) {
        signTest.error = '签名验证失败，请检查 WX_MCH_PRIVATE_KEY / WX_MCH_CERT_SERIAL'
        signTest.detail = result.body
      } else {
        signTest.error = '未知状态'
        signTest.detail = result.body
      }
    } catch (e) {
      signTest.error = e.message
    }
    return ok(res, { config, signTest })
  } catch (e) { fail(res, e.message) }
})

// 订单详情（ERP后台）
app.get('/adminapi/mini/order/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.*, u.phone as user_phone FROM mini_orders o LEFT JOIN mini_users u ON u.id=o.user_id WHERE o.id=$1 AND o.deleted_at IS NULL`,
      [req.params.id]
    )
    if (!r.rows[0]) return fail(res, '订单不存在')
    const order = r.rows[0]
    order.items = (await pool.query(`SELECT * FROM mini_order_items WHERE order_id=$1`, [order.id])).rows
    order.address = typeof order.address === 'string' ? JSON.parse(order.address || '{}') : (order.address || {})
    return ok(res, order)
  } catch (e) { fail(res, e.message) }
})

// 发起微信支付
app.post('/miniapi/pay/unified', miniAuth, async (req, res) => {
  try {
    const { orderId } = req.body
    const r = await pool.query(`SELECT * FROM mini_orders WHERE id=$1 AND user_id=$2 LIMIT 1`, [orderId, req.miniUser.id])
    if (!r.rows[0]) return fail(res, '订单不存在')
    const order = r.rows[0]
    if (order.status !== 0) return fail(res, '订单已支付')

    const totalFee = Math.round(parseFloat(order.total_amount || order.total || 0) * 100) // 转分
    const notifyUrl = 'https://erp-server-xsji.onrender.com/miniapi/pay/notify'

    if (totalFee <= 0) {
      const updOrder = (await pool.query(`UPDATE mini_orders SET status=1, paid_at=NOW() WHERE id=$1 AND status=0 RETURNING *`, [order.id])).rows[0]
      if (updOrder && parseInt(updOrder.coupon_id || 0) > 0) {
        await pool.query(
          `UPDATE mini_user_coupons SET status=1, used_at=NOW()
           WHERE id=$1 AND user_id=$2 AND order_id=$3 AND status=3`,
          [updOrder.coupon_id, updOrder.user_id, updOrder.id]
        )
      }
      return ok(res, { paid: true, orderId: order.id })
    }

    // V3 JSAPI 下单
    const wxRes = await wxV3Post('/v3/pay/transactions/jsapi', {
      appid: WX_APPID,
      mchid: WX_MCH_ID,
      description: '牧区纯坊品牌直营',
      out_trade_no: order.order_no,
      notify_url: notifyUrl,
      amount: { total: totalFee, currency: 'CNY' },
      payer: { openid: req.miniUser.openid },
    })

    if (!wxRes.prepay_id) {
      console.error('[V3 unifiedorder]', JSON.stringify(wxRes))
      return fail(res, wxRes.message || wxRes.detail?.message || '微信支付下单失败')
    }

    // 调起支付参数（V3 用 RSA 签名）
    const crypto = require('crypto')
    const timeStamp = String(Math.floor(Date.now() / 1000))
    const nonceStr = crypto.randomBytes(16).toString('hex')
    const packageStr = `prepay_id=${wxRes.prepay_id}`
    const signMsg = `${WX_APPID}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`
    const sign = crypto.createSign('RSA-SHA256')
    sign.update(signMsg)
    const paySign = sign.sign(WX_MCH_PRIVATE_KEY, 'base64')

    return ok(res, { timeStamp, nonceStr, package: packageStr, signType: 'RSA', paySign })
  } catch (e) { fail(res, e.message) }
})

// 支付回调（V3 JSON 格式）
app.post('/miniapi/pay/notify', async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {})
    // 1. 验签
    const verify = wxV3VerifyCallback(req.headers, rawBody)
    if (!verify.ok) {
      console.error('[pay/notify V3] verify failed:', verify.reason)
      return res.status(401).json({ code: 'FAIL', message: verify.reason })
    }
    // 2. 解密 resource
    const notification = req.body || {}
    if (notification.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '已忽略非成功事件' })
    }
    let payload
    try {
      payload = wxV3DecryptResource(notification.resource)
    } catch (e) {
      console.error('[pay/notify V3] decrypt failed:', e.message)
      return res.status(500).json({ code: 'FAIL', message: 'decrypt failed' })
    }
    // payload 字段：out_trade_no, transaction_id, trade_state, amount{total}, payer{openid}
    if (payload.trade_state !== 'SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '已忽略非成功状态' })
    }
    const outTradeNo = payload.out_trade_no
    const transactionId = payload.transaction_id || ''
    const paidFen = parseInt(payload.amount?.total ?? 0)

    // 3. 校验金额（防伪造）
    const expectedOrder = (await pool.query(`SELECT total_amount FROM mini_orders WHERE order_no=$1 LIMIT 1`, [outTradeNo])).rows[0]
    if (!expectedOrder) {
      return res.status(404).json({ code: 'FAIL', message: 'ORDER_NOT_FOUND' })
    }
    const expectedFen = Math.round(parseFloat(expectedOrder.total_amount) * 100)
    if (paidFen !== expectedFen) {
      console.error('[pay/notify V3] amount mismatch', { order_no: outTradeNo, expected: expectedFen, got: paidFen })
      return res.status(400).json({ code: 'FAIL', message: 'AMOUNT_MISMATCH' })
    }

    // 4. 更新订单 + 锁定优惠券 + 发积分 + 推送
    const updOrder = (await pool.query(
      `UPDATE mini_orders SET status=1, paid_at=NOW(), wx_transaction_id=$2 WHERE order_no=$1 AND status=0 RETURNING *`,
      [outTradeNo, transactionId]
    )).rows[0]
    if (updOrder) {
      if (parseInt(updOrder.coupon_id || 0) > 0) {
        await pool.query(
          `UPDATE mini_user_coupons SET status=1, used_at=NOW()
           WHERE id=$1 AND user_id=$2 AND order_id=$3 AND status=3`,
          [updOrder.coupon_id, updOrder.user_id, updOrder.id]
        )
      }
      const paidUser = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [updOrder.user_id])).rows[0]
      if (paidUser) {
        const paidItems = (await pool.query(`SELECT goods_name, qty FROM mini_order_items WHERE order_id=$1`, [updOrder.id])).rows
        if (paidUser.openid && TMPL_ORDER_SUCCESS) {
          const goodsName = paidItems.map(i => i.goods_name).join('、').slice(0, 20)
          const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
          sendSubscribeMsg(paidUser.openid, TMPL_ORDER_SUCCESS, `pages/order/detail?id=${updOrder.id}`, {
            thing1: { value: goodsName || '商品' },
            amount1: { value: `¥${parseFloat(updOrder.total_amount || updOrder.total || 0).toFixed(2)}` },
            character_string1: { value: updOrder.order_no },
            time1: { value: now.slice(0, 16) },
          }).catch(() => {})
        }
        notifyAdminNewOrder(updOrder, paidItems).catch(() => {})
        const lvl = calcLevel(paidUser)
        const mult = MEMBER_LEVELS[lvl].multiplier
        const earnPoints = Math.floor(parseFloat(updOrder.total_amount || updOrder.total || 0) * POINTS_PER_YUAN * mult)
        const newSpent = parseFloat(paidUser.total_spent || 0) + parseFloat(updOrder.total_amount || updOrder.total || 0)
        const newLevel = newSpent >= 2000 ? 2 : newSpent >= 500 ? 1 : 0
        await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+$1, total_spent=COALESCE(total_spent,0)+$2, level=GREATEST(level,$3) WHERE id=$4`,
          [earnPoints, parseFloat(updOrder.total_amount || updOrder.total || 0), newLevel, updOrder.user_id])
        await pool.query(`INSERT INTO mini_points_log (user_id,points,type,remark,order_id,created_at) VALUES ($1,$2,'earn','消费送积分',$3,NOW())`,
          [updOrder.user_id, earnPoints, updOrder.id])
      }
    }
    return res.json({ code: 'SUCCESS', message: 'OK' })
  } catch (e) {
    console.error('[pay/notify V3] error:', e.message)
    return res.status(500).json({ code: 'FAIL', message: e.message })
  }
})

// ─── 会员系统 ─────────────────────────────────────────────────────────────────

const MEMBER_LEVELS = [
  { level: 0, name: '普通会员', minSpent: 0,    multiplier: 1,   discount: 1.0  },
  { level: 1, name: '银牌会员', minSpent: 500,  multiplier: 1.5, discount: 0.95 },
  { level: 2, name: '金牌会员', minSpent: 2000, multiplier: 2,   discount: 0.90 },
  { level: 3, name: 'VIP会员',  minSpent: 0,    multiplier: 3,   discount: 0.85 },
]
const VIP_PRICE = 99
const POINTS_PER_YUAN = 10  // 消费1元得10积分
const POINTS_REDEEM_RATE = 100  // 100积分=1元

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_vip_payments (
        id SERIAL PRIMARY KEY,
        order_no VARCHAR(64) UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        amount NUMERIC(8,2) DEFAULT 99,
        processed_at TIMESTAMP DEFAULT NOW()
      )
    `)
  } catch(e) { console.log('mini_vip_payments init:', e.message) }
})()

function calcLevel(user) {
  const now = new Date()
  if (user.vip_expire_at && new Date(user.vip_expire_at) > now) return 3
  const spent = parseFloat(user.total_spent || 0)
  if (spent >= 2000) return 2
  if (spent >= 500) return 1
  return 0
}

async function releaseOrderBenefits(client, order, remark = '订单取消退回') {
  const pointsUsed = parseInt(order.points_used || 0)
  if (pointsUsed > 0) {
    // 防重：已经返过积分就不再返
    const existed = (await client.query(
      `SELECT id FROM mini_points_log WHERE order_id=$1 AND type='refund' LIMIT 1`, [order.id]
    )).rows[0]
    if (!existed) {
      await client.query(`UPDATE mini_users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [pointsUsed, order.user_id])
      await client.query(
        `INSERT INTO mini_points_log (user_id,points,type,remark,order_id,created_at)
         VALUES ($1,$2,'refund',$3,$4,NOW())`,
        [order.user_id, pointsUsed, remark, order.id]
      )
    }
  }
  const couponId = parseInt(order.coupon_id || 0)
  if (couponId > 0) {
    await client.query(
      `UPDATE mini_user_coupons
       SET status=0, used_at=NULL, order_id=NULL
       WHERE id=$1 AND user_id=$2 AND order_id=$3 AND status IN (1,3)`,
      [couponId, order.user_id, order.id]
    )
  }
  // 阻止后续佣金结算（即使冷静期已过，cron 不应再发放）
  await client.query(`UPDATE mini_orders SET commission_settled=true WHERE id=$1 AND commission_settled=false`, [order.id])
  // 回滚库存（防重：检查 stock_flow 是否已存在该订单的回滚记录）
  const orderNo = order.order_no || ''
  if (orderNo) {
    const restored = (await client.query(
      `SELECT id FROM stock_flow WHERE order_no=$1 AND type='mini_refund' LIMIT 1`, [orderNo]
    )).rows[0]
    if (!restored) {
      const items = (await client.query(`SELECT goods_id, goods_name, qty FROM mini_order_items WHERE order_id=$1`, [order.id])).rows
      for (const it of items) {
        if (!it.goods_id || !it.qty) continue
        const inv = (await client.query(
          `SELECT qty, warehouse_id, warehouse_name FROM stock_inventory WHERE goods_id=$1 ORDER BY warehouse_id ASC LIMIT 1 FOR UPDATE`,
          [it.goods_id]
        )).rows[0]
        if (!inv) continue
        const before = parseFloat(inv.qty)
        const after = before + parseFloat(it.qty)
        await client.query(
          `UPDATE stock_inventory SET qty=$1, update_time=NOW() WHERE goods_id=$2 AND warehouse_id=$3`,
          [after, it.goods_id, inv.warehouse_id]
        )
        await client.query(
          `INSERT INTO stock_flow (goods_id, goods_name, warehouse_id, warehouse_name, type, qty, before_qty, after_qty, order_no, remark)
           VALUES ($1,$2,$3,$4,'mini_refund',$5,$6,$7,$8,$9)`,
          [it.goods_id, it.goods_name || '', inv.warehouse_id, inv.warehouse_name || '', parseFloat(it.qty), before, after, orderNo, remark]
        )
      }
    }
  }
}

// 会员信息
app.get('/miniapi/member/info', miniAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [req.miniUser.id])
    const user = r.rows[0]
    if (!user) return fail(res, '用户不存在')
    const level = calcLevel(user)
    const levelInfo = MEMBER_LEVELS[level]
    const nextLevel = MEMBER_LEVELS[Math.min(level + 1, 3)]
    const spent = parseFloat(user.total_spent || 0)
    return ok(res, {
      points: user.points || 0,
      total_spent: spent,
      level,
      level_name: level === 3 ? 'VIP会员' : levelInfo.name,
      discount: levelInfo.discount,
      multiplier: levelInfo.multiplier,
      vip_expire_at: user.vip_expire_at,
      next_level: level < 3 ? { name: nextLevel.name, need: Math.max(0, nextLevel.minSpent - spent) } : null,
    })
  } catch (e) { fail(res, e.message) }
})

// 积分明细
app.get('/miniapi/member/points/log', miniAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT * FROM mini_points_log WHERE user_id=$1 ORDER BY id DESC LIMIT 30`,
      [req.miniUser.id]
    )).rows
    return ok(res, rows)
  } catch (e) { fail(res, e.message) }
})

// 购买VIP会员（发起支付）
app.post('/miniapi/member/buy-vip', miniAuth, async (req, res) => {
  try {
    const orderNo = genOrderNo('VIP')
    const totalFee = VIP_PRICE * 100
    // V3 JSAPI 下单
    const wxRes = await wxV3Post('/v3/pay/transactions/jsapi', {
      appid: WX_APPID,
      mchid: WX_MCH_ID,
      description: '牧区纯坊品牌直营',
      out_trade_no: orderNo,
      notify_url: 'https://erp-server-xsji.onrender.com/miniapi/pay/vip-notify',
      amount: { total: totalFee, currency: 'CNY' },
      payer: { openid: req.miniUser.openid },
      attach: String(req.miniUser.id),
    })
    if (!wxRes.prepay_id) {
      console.error('[V3 vip-unifiedorder]', JSON.stringify(wxRes))
      return fail(res, wxRes.message || wxRes.detail?.message || 'VIP支付下单失败')
    }
    const crypto = require('crypto')
    const timeStamp = String(Math.floor(Date.now() / 1000))
    const nonceStr = crypto.randomBytes(16).toString('hex')
    const packageStr = `prepay_id=${wxRes.prepay_id}`
    const signMsg = `${WX_APPID}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`
    const sign = crypto.createSign('RSA-SHA256')
    sign.update(signMsg)
    const paySign = sign.sign(WX_MCH_PRIVATE_KEY, 'base64')
    return ok(res, { timeStamp, nonceStr, package: packageStr, signType: 'RSA', paySign, orderNo })
  } catch (e) { fail(res, e.message) }
})

// VIP支付回调（V3 JSON 格式）
app.post('/miniapi/pay/vip-notify', async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {})
    const verify = wxV3VerifyCallback(req.headers, rawBody)
    if (!verify.ok) {
      console.error('[vip-notify V3] verify failed:', verify.reason)
      return res.status(401).json({ code: 'FAIL', message: verify.reason })
    }
    const notification = req.body || {}
    if (notification.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '已忽略非成功事件' })
    }
    let payload
    try {
      payload = wxV3DecryptResource(notification.resource)
    } catch (e) {
      console.error('[vip-notify V3] decrypt failed:', e.message)
      return res.status(500).json({ code: 'FAIL', message: 'decrypt failed' })
    }
    if (payload.trade_state !== 'SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '已忽略非成功状态' })
    }
    // 校验金额（防伪造低额回调）
    const paidFen = parseInt(payload.amount?.total ?? 0)
    if (paidFen !== VIP_PRICE * 100) {
      console.error('[vip-notify V3] amount mismatch', { expected: VIP_PRICE * 100, got: paidFen })
      return res.status(400).json({ code: 'FAIL', message: 'AMOUNT_MISMATCH' })
    }
    const userId = parseInt(payload.attach)
    const inserted = (await pool.query(
      `INSERT INTO mini_vip_payments (order_no, user_id, amount)
       VALUES ($1,$2,$3)
       ON CONFLICT (order_no) DO NOTHING
       RETURNING id`,
      [payload.out_trade_no, userId, VIP_PRICE]
    )).rows[0]
    if (!inserted) return res.json({ code: 'SUCCESS', message: '已处理' })
    const expireAt = new Date(Date.now() + 365 * 24 * 3600 * 1000)
    await pool.query(`UPDATE mini_users SET vip_expire_at=$1, level=3 WHERE id=$2`, [expireAt, userId])
    await pool.query(`INSERT INTO mini_points_log (user_id, points, type, remark, created_at) VALUES ($1,990,'earn','购买VIP会员赠送积分',NOW())`, [userId])
    await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+990 WHERE id=$1`, [userId])
    return res.json({ code: 'SUCCESS', message: 'OK' })
  } catch (e) {
    console.error('[vip-notify V3] error:', e.message)
    return res.status(500).json({ code: 'FAIL', message: e.message })
  }
})

// Nova 客服聊天（收集 Cloudflare SSE → 返回完整 JSON）
// 品牌主页配置（代理 Cloudflare KV，补全图片绝对路径）
app.get('/miniapi/brand/config', async (req, res) => {
  try {
    const cfRes = await fetch('https://nomaderp.pages.dev/api/brand-config')
    const json = await cfRes.json()
    const cfg = json.data || {}
    // 补全相对路径图片 URL
    const abs = (url) => {
      if (!url) return ''
      if (url.startsWith('http')) return url
      return 'https://nomaderp.pages.dev' + (url.startsWith('/') ? '' : '/') + url
    }
    cfg.heroImage = abs(cfg.heroImage)
    if (Array.isArray(cfg.heroImages)) {
      cfg.heroImages = cfg.heroImages.filter(Boolean).map(abs)
    }
    if (Array.isArray(cfg.homeStoryImages)) {
      cfg.homeStoryImages = cfg.homeStoryImages.filter(Boolean).map(abs)
    }
    if (Array.isArray(cfg.categories)) {
      cfg.categories = cfg.categories.map(c => ({ ...c, img: abs(c.img) }))
    }
    return ok(res, cfg)
  } catch (e) { fail(res, e.message) }
})

app.post('/miniapi/nova/chat', async (req, res) => {
  try {
    const { messages = [] } = req.body

    // 动态加载所有上架商品数据构建上下文
    let productLines = ''
    try {
      const rows = (await pool.query(
        `SELECT id, goods_name, sell_price, remark, unit_name FROM goods WHERE deleted_at IS NULL AND status=1 AND can_sale=1 LIMIT 200`
      )).rows
      const brandRows = rows.filter(g => {
        try { return JSON.parse(g.remark || '{}')['__brand__']?.show === true } catch { return false }
      })
      productLines = brandRows.map(g => {
        let brand = {}
        try { brand = JSON.parse(g.remark || '{}')['__brand__'] || {} } catch {}
        const skus = (brand.skuVariants || []).filter(s => s.label)
        const skuStr = skus.length ? '，规格：' + skus.map(s => `${s.label}¥${s.price}`).join('、') : ''
        const desc = brand.description || ''
        return `• ${g.goods_name}，售价¥${g.sell_price}/${g.unit_name || '件'}${skuStr}${desc ? '，' + desc.slice(0, 30) : ''}`
      }).join('\n')
    } catch {}

    const brandContext = `【在售商品】
${productLines || '（暂无实时商品数据，遇到具体价格/规格问题请引导用户去商店页面查看）'}

【物流】基本全店包邮，通常用圆通速递发货
【售后】7 天无理由退换
【批发】起订量各品类不同，请引导用户填写采购商申请表或联系客服报价

回答时如果用户问具体产品的价格或规格，只能从上方【在售商品】里准确引用，不要编造数字；商品列表里没有的品类，如实说"这个目前没上架"。`

    const cfRes = await fetch('https://nomaderp.pages.dev/api/brand-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, brandContext }),
    })

    const text = await cfRes.text()
    // 解析 SSE 拼接完整回复
    let reply = ''
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try {
        const d = JSON.parse(line.slice(6))
        if (d.type === 'text') reply += (d.text || d.content || '')
      } catch {}
    }
    return ok(res, { reply: reply || '抱歉，暂时无法回复，请稍后再试。' })
  } catch (e) { fail(res, e.message) }
})

// ─── 批发合作意向 ─────────────────────────────────────────────────────────────
// ─── 评价系统 ────────────────────────────────────────────────────────────────

// 建表 + 默认评价（幂等）
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_reviews (
        id SERIAL PRIMARY KEY,
        goods_id INT NOT NULL,
        user_id INT NOT NULL DEFAULT 0,
        order_id INT NOT NULL,
        rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        content TEXT DEFAULT '',
        images TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(order_id, goods_id)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mini_reviews_goods ON mini_reviews(goods_id)`)
    await pool.query(`ALTER TABLE mini_reviews ADD COLUMN IF NOT EXISTS images TEXT DEFAULT NULL`)

    // 默认好评种子数据（order_id 用负数，不与真实订单冲突）
    const seeds = [
      // 青砖奶茶 996
      [996, -1,  5, '奶香味很浓，冲出来颜色漂亮，比超市买的好喝多了，回购了好几次！', 12],
      [996, -2,  5, '地道的蒙古奶茶味道，咸香适中，朋友来家里喝了都想买。', 25],
      [996, -3,  4, '味道正宗，包装也干净，下次还买。', 38],
      [996, -19, 5, '第一次喝蒙古奶茶，完全爱上了！咸香浓郁，比网红店的强多了。', 3],
      [996, -20, 5, '买了5盒装，家人每天早上都要喝一杯，已经成了习惯。', 17],
      [996, -21, 5, '给父母买的，他们说是他们年轻时喝过的味道，很感动。', 44],
      [996, -22, 4, '奶香纯正，颜色好看，家里来客人都会泡上一壶招待。', 60],
      // 冻炒米 994
      [994, -4,  5, '从小吃的味道！放在牛奶里泡着吃超香，孩子特别喜欢，已经买了三盒了。', 8],
      [994, -5,  5, '真正的牧区炒米，酥脆不甜腻，配奶茶绝了。', 19],
      [994, -6,  5, '货真价实，分量足，包装密封很好，保持了酥脆。', 42],
      [994, -23, 5, '泡在牛奶里吃，简直是完美的早餐！朋友圈晒了好多人问我在哪儿买的。', 5],
      [994, -24, 5, '炒米的香气一打开就飘出来，特别纯正，不像外面的有奇怪添加剂。', 29],
      [994, -25, 4, '口感酥脆，不太硬，老人也能吃，全家都爱。', 51],
      // 奶豆腐盒装 992
      [992, -7,  5, '第一次吃奶豆腐，口感扎实，奶香纯正，不加防腐剂放心吃，很喜欢！', 6],
      [992, -8,  4, '口味独特，有点像硬奶酪，喜欢纯天然食品的朋友值得试试。', 30],
      [992, -9,  5, '买来送父母，他们说好久没吃到这么正宗的奶豆腐了。', 55],
      [992, -26, 5, '盒装的很精致，送礼很有面子，朋友收到了特别高兴。', 11],
      [992, -27, 5, '嚼起来有弹性，奶香浓，晒干了直接当零食也很好吃。', 33],
      [992, -28, 5, '在内蒙旅游时吃过，回来就网上找同款，这个味道最接近！', 48],
      // 黄油 989
      [989, -10, 5, '纯天然黄油，奶香浓郁，抹面包拌饭都香，家里老人孩子都爱吃。', 15],
      [989, -11, 5, '颜色金黄，入口即化，比市面上的黄油香多了，正宗牧区出品！', 28],
      [989, -12, 4, '味道纯正，就是量少了点，下次多买几瓶。', 50],
      [989, -29, 5, '抹在蒙古饼上一起吃，人间美味。比进口黄油更香，而且更健康。', 4],
      [989, -30, 5, '家里煎饺时换成了这个黄油，香味提升了好几倍，以后就认这家了。', 22],
      [989, -31, 5, '颜色很自然，不像某些黄油那么白，一看就是纯手工制作的感觉。', 40],
      // 奶豆腐袋装 988
      [988, -13, 5, '原味的最喜欢，有嚼劲，晒干后更香，配茶吃一绝。', 10],
      [988, -14, 5, '正宗牧区手工味道，买了好几次了，品质稳定，每次都很满意。', 22],
      [988, -15, 5, '外甥女超爱，当零食吃健康又好吃，已经推荐给朋友圈了。', 45],
      [988, -32, 5, '袋装量大实惠，平时当零食嚼，越嚼越香，停不下来。', 7],
      [988, -33, 4, '奶味浓郁，口感嚼劲好，天然无添加，孩子的健康零食首选。', 26],
      [988, -34, 5, '泡在奶茶里一起喝，软化了之后口感超赞，这个吃法强烈推荐。', 58],
      // 甜味奶条 1008
      [1008,-16, 5, '甜味的很好吃，奶香浓，嚼起来有劲，比奶糖健康多了！', 7],
      [1008,-17, 5, '孩子当零食，我当代餐，全家都喜欢，已经回购三次了。', 20],
      [1008,-18, 4, '味道很正宗，甜度刚好不腻，包装精致，送礼自用都合适。', 36],
      [1008,-35, 5, '甜而不腻，奶香足，随手包装出门吃很方便，小孩超爱。', 9],
      [1008,-36, 5, '上次买的快吃完了，又补货了。家里备着当零食，健康又好吃。', 31],
      [1008,-37, 5, '在展会上尝了一口就买了，回来网上又找到同款，幸运！', 62],
      // 牛肉干成品袋 874
      [874, -38, 5, '肉质紧实有嚼劲，咸淡适中，下酒下饭都绝！朋友来了都抢着吃。', 5],
      [874, -39, 5, '从内蒙直发，月内新产，新鲜能看到，比外面卖的强太多了。', 14],
      [874, -40, 5, '买了好多次了，品质一直很稳定，不加乱七八糟的添加剂，吃得放心。', 28],
      [874, -41, 4, '口感比超市那种软，但香味更浓，正宗草原风味，下次多买点。', 42],
      [874, -42, 5, '打开袋子香味扑鼻，切片够厚实，嚼着很过瘾，同事问我哪买的。', 9],
      [874, -43, 5, '给爸爸买的，他说是几十年前的那种老味道，很感动，已经回购了。', 33],
      [874, -44, 5, '140克分量刚好，出差当口粮，方便携带，已经备了好几袋在包里了。', 21],
    ]
    for (const [goods_id, order_id, rating, content, days] of seeds) {
      const d = new Date(Date.now() - days * 86400000)
      await pool.query(
        `INSERT INTO mini_reviews (goods_id, user_id, order_id, rating, content, created_at) VALUES ($1,0,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [goods_id, order_id, rating, content, d]
      )
    }
    console.log('mini_reviews seed done')
  } catch(e) { console.log('mini_reviews create:', e.message) }
})()

// 获取商品评价列表
app.get('/miniapi/review/list', async (req, res) => {
  try {
    const { goods_id, page = 1, list_rows = 10 } = req.query
    if (!goods_id) return fail(res, 'goods_id必填')
    const offset = (parseInt(page) - 1) * parseInt(list_rows)
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM mini_reviews WHERE goods_id=$1`, [goods_id])).rows[0].count)
    const rows = (await pool.query(
      `SELECT r.id, r.rating, r.content, r.created_at, r.images,
              COALESCE(u.name, u.phone, '匿名用户') as user_name
       FROM mini_reviews r
       LEFT JOIN mini_users u ON u.id=r.user_id
       WHERE r.goods_id=$1
       ORDER BY r.id DESC LIMIT $2 OFFSET $3`,
      [goods_id, parseInt(list_rows), offset]
    )).rows
    const avgRow = (await pool.query(`SELECT AVG(rating)::numeric(3,1) as avg, COUNT(*) as cnt FROM mini_reviews WHERE goods_id=$1`, [goods_id])).rows[0]
    return ok(res, { rows, total, avg_rating: parseFloat(avgRow.avg) || 0, review_count: parseInt(avgRow.cnt) })
  } catch(e) { fail(res, e.message) }
})

// 七牛云上传 token（小程序端）—— 已迁移到 Cloudflare KV 存储
// 新方式：小程序直接 POST 到 https://nomaderp.pages.dev/miniapi/upload/review-img
app.get('/miniapi/upload/review-token', miniAuth, (_req, res) => fail(res, '请升级小程序：评价图片上传已迁移到 /miniapi/upload/review-img'))

// 公众号原文配图代理：小程序只请求自有业务域名，避免 qpic 图片域名白名单限制。
app.get('/miniapi/article-image', async (req, res) => {
  try {
    const target = String(req.query.url || '')
    if (!/^https?:\/\/mmbiz\.qpic\.cn\//i.test(target)) return res.status(400).end()
    const upstream = await fetch(target)
    if (!upstream.ok) return res.status(upstream.status).end()
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch (e) { res.status(502).end() }
})

// 提交评价（需登录，且该订单包含该商品）
app.post('/miniapi/review/create', miniAuth, async (req, res) => {
  try {
    const { goods_id, order_id, rating, content } = req.body
    if (!goods_id || !order_id || !rating) return fail(res, '参数不完整')
    if (rating < 1 || rating > 5) return fail(res, '评分1-5分')
    // 验证订单属于该用户且包含该商品
    const orderRow = (await pool.query(
      `SELECT o.id FROM mini_orders o
       JOIN mini_order_items i ON i.order_id=o.id
       WHERE o.id=$1 AND o.user_id=$2 AND i.goods_id=$3 AND o.status>=1 LIMIT 1`,
      [order_id, req.miniUser.id, goods_id]
    )).rows[0]
    if (!orderRow) return fail(res, '无权评价，请确认订单已付款')
    // 防重复
    const exist = (await pool.query(`SELECT id FROM mini_reviews WHERE order_id=$1 AND goods_id=$2 LIMIT 1`, [order_id, goods_id])).rows[0]
    if (exist) return fail(res, '已评价过')
    const { goods_id: _g, order_id: _o, rating: _r, content: _c, images: imgArr } = req.body
    const imagesJson = Array.isArray(imgArr) && imgArr.length ? JSON.stringify(imgArr) : null
    await pool.query(
      `INSERT INTO mini_reviews (goods_id, user_id, order_id, rating, content, images) VALUES ($1,$2,$3,$4,$5,$6)`,
      [goods_id, req.miniUser.id, order_id, rating, content || '', imagesJson]
    )
    // 基础10积分 + 图片每张1积分（最多10张=10分）
    const photoBonus = Array.isArray(imgArr) ? Math.min(imgArr.length, 6) : 0
    const totalPoints = 10 + photoBonus
    await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [totalPoints, req.miniUser.id])
    const msg = photoBonus > 0
      ? `评价成功！获得${totalPoints}积分（评价+10，图片+${photoBonus}）`
      : '评价成功，获得10积分'
    return ok(res, { message: msg })
  } catch(e) { fail(res, e.message) }
})

// 检查某订单某商品是否已评价
app.get('/miniapi/review/check', miniAuth, async (req, res) => {
  try {
    const { order_id, goods_id } = req.query
    const r = (await pool.query(
      `SELECT id FROM mini_reviews WHERE order_id=$1 AND goods_id=$2 AND user_id=$3 LIMIT 1`,
      [order_id, goods_id, req.miniUser.id]
    )).rows[0]
    return ok(res, { reviewed: !!r })
  } catch(e) { fail(res, e.message) }
})

// 内存级频控（够用，重启清空）
const wholesaleInquiryRateLimit = new Map()
app.post('/miniapi/wholesale/inquiry', async (req, res) => {
  try {
    const { name, wechat, mobile } = req.body
    if (!name || (!wechat && !mobile)) return fail(res, '请填写姓名及微信号或手机号')

    // 频控：同 mobile/wechat/IP 任一维度 5 分钟内只能 1 次
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || ''
    const keys = [`m:${mobile || ''}`, `w:${wechat || ''}`, `ip:${ip}`].filter(k => k.length > 3)
    const nowMs = Date.now()
    for (const [k, ts] of wholesaleInquiryRateLimit) {
      if (nowMs - ts > 600000) wholesaleInquiryRateLimit.delete(k) // 清理 10 分钟前的
    }
    for (const k of keys) {
      const last = wholesaleInquiryRateLimit.get(k)
      if (last && nowMs - last < 300000) {
        return fail(res, '提交过于频繁，请 5 分钟后再试')
      }
    }
    keys.forEach(k => wholesaleInquiryRateLimit.set(k, nowMs))

    // 保存到 ERP 客户表
    const now = Math.floor(Date.now() / 1000)
    const remark = `【批发合作意向】微信：${wechat || '-'}  手机：${mobile || '-'}  来源：品牌页`
    await pool.query(
      `INSERT INTO shop_customer (name, mobile, remark, create_time, update_time)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT DO NOTHING`,
      [name, mobile || '', remark, now]
    )

    // Server酱推送到微信
    const key = process.env.SERVER_JIANG_KEY
    if (key) {
      const title = encodeURIComponent('📦 新批发合作意向')
      const contact = wechat ? `微信：${wechat}` : `手机：${mobile}`
      const desp  = encodeURIComponent(`姓名：${name}\n${contact}\n来源：品牌合作页`)
      fetch(`https://sctapi.ftqq.com/${key}.send?title=${title}&desp=${desp}`).catch(() => {})
    }

    return ok(res, { message: '已收到，我们会尽快联系您' })
  } catch (e) { fail(res, e.message) }
})

// ─── 优惠券系统 ──────────────────────────────────────────────────────────────

// 建表（幂等）
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_coupons (
        id SERIAL PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'general',
        discount_value NUMERIC(8,2) NOT NULL,
        min_order NUMERIC(8,2) NOT NULL DEFAULT 0,
        validity_days INT NOT NULL DEFAULT 30,
        total_count INT NOT NULL DEFAULT -1,
        claimed_count INT NOT NULL DEFAULT 0,
        status SMALLINT NOT NULL DEFAULT 1,
        start_at TIMESTAMP DEFAULT NOW(),
        end_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_user_coupons (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        coupon_id INT NOT NULL,
        status SMALLINT NOT NULL DEFAULT 0,
        expire_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        order_id INT,
        claimed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, coupon_id, claimed_at)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_muc_user ON mini_user_coupons(user_id)`)
    // 优惠券去重迁移：coupon_type冗余列 + 按签名的偏索引 + 清理历史脏数据
    await pool.query(`ALTER TABLE mini_user_coupons ADD COLUMN IF NOT EXISTS coupon_type VARCHAR(20)`)
    await pool.query(`UPDATE mini_user_coupons uc SET coupon_type = c.type FROM mini_coupons c WHERE uc.coupon_id = c.id AND uc.coupon_type IS NULL`)
    // 清理新客券：按"券签名"(name+discount_value+min_order)去重，每档只保留1张
    // 保留优先级：已用 > 锁定 > 有order_id > 券本身active > 最早领取
    // 允许一人多张不同档位（如满100减10 + 满300减20）
    await pool.query(`DELETE FROM mini_user_coupons WHERE id IN (
      SELECT uc_id FROM (
        SELECT uc.id AS uc_id, ROW_NUMBER() OVER (
          PARTITION BY uc.user_id, c.name, c.discount_value, c.min_order
          ORDER BY (uc.status=1)::int DESC, (uc.status=3)::int DESC,
                   (uc.order_id IS NOT NULL)::int DESC,
                   (c.status=1)::int DESC, uc.claimed_at ASC, uc.id ASC
        ) rn
        FROM mini_user_coupons uc
        JOIN mini_coupons c ON c.id=uc.coupon_id
        WHERE uc.coupon_type='new_user'
      ) x WHERE x.rn > 1
    )`)
    // 清理生日券：一人每年每档只保留一张
    await pool.query(`DELETE FROM mini_user_coupons WHERE id IN (
      SELECT uc_id FROM (
        SELECT uc.id AS uc_id, ROW_NUMBER() OVER (
          PARTITION BY uc.user_id, c.name, c.discount_value, c.min_order, EXTRACT(YEAR FROM uc.claimed_at)
          ORDER BY (uc.status=1)::int DESC, (uc.status=3)::int DESC,
                   (uc.order_id IS NOT NULL)::int DESC,
                   (c.status=1)::int DESC, uc.claimed_at ASC, uc.id ASC
        ) rn
        FROM mini_user_coupons uc
        JOIN mini_coupons c ON c.id=uc.coupon_id
        WHERE uc.coupon_type='birthday'
      ) x WHERE x.rn > 1
    )`)
    // 按类型的偏唯一索引：DB兜底，(user_id, coupon_id) 内一人一张
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_muc_new_user ON mini_user_coupons(user_id, coupon_id) WHERE coupon_type='new_user'`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_muc_birthday_year ON mini_user_coupons(user_id, coupon_id, (EXTRACT(YEAR FROM claimed_at))) WHERE coupon_type='birthday'`)
    // 同步 claimed_count 到真实数量
    await pool.query(`UPDATE mini_coupons c SET claimed_count = sub.cnt FROM (SELECT coupon_id, COUNT(*)::int AS cnt FROM mini_user_coupons GROUP BY coupon_id) sub WHERE c.id = sub.coupon_id AND c.claimed_count <> sub.cnt`)
    // 补生日字段
    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS birth_month SMALLINT`)
    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS birth_day SMALLINT`)
    await pool.query(`ALTER TABLE mini_coupons ADD COLUMN IF NOT EXISTS points_cost INT NOT NULL DEFAULT 0`)
    // 预置默认券
    await pool.query(`
      INSERT INTO mini_coupons (name, type, discount_value, min_order, validity_days, total_count, points_cost)
      SELECT v.* FROM (VALUES
        ('新客满减券·满100减10', 'new_user', 10::numeric, 100::numeric, 30, -1, 0),
        ('新客满减券·满300减20', 'new_user', 20::numeric, 300::numeric, 30, -1, 0),
        ('生日特权券', 'birthday', 15::numeric, 50::numeric, 7, -1, 0),
        ('签到7天专享券', 'signin7', 8::numeric, 30::numeric, 14, -1, 0),
        ('抽奖券·满50减5', 'lottery', 5::numeric, 50::numeric, 7, -1, 0),
        ('抽奖券·满100减10', 'lottery', 10::numeric, 100::numeric, 7, -1, 0)
      ) AS v(name, type, discount_value, min_order, validity_days, total_count, points_cost)
      WHERE NOT EXISTS (
        SELECT 1 FROM mini_coupons c
        WHERE c.type=v.type AND c.discount_value=v.discount_value AND c.min_order=v.min_order
      )
    `)
    // 历史版本曾在每次服务启动时重复插入默认券；只保留每组最早的一张有效券。
    await pool.query(`
      WITH duplicates AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY type, name, discount_value, min_order, validity_days, points_cost
          ORDER BY id
        ) AS rn
        FROM mini_coupons
      )
      UPDATE mini_coupons SET status=0
      WHERE id IN (SELECT id FROM duplicates WHERE rn > 1)
    `)
    console.log('mini_coupons tables ready')
  } catch(e) { console.log('mini_coupons init:', e.message) }
})()

// 可领优惠券列表（当前用户视角）
app.get('/miniapi/coupon/list', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const user = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [uid])).rows[0]
    const now = new Date()
    const coupons = (await pool.query(
      `SELECT * FROM mini_coupons WHERE status=1 AND (end_at IS NULL OR end_at > NOW()) ORDER BY id ASC`
    )).rows

    const result = []
    for (const c of coupons) {
      // 已领数量（该券该用户）
      const claimedByUser = parseInt((await pool.query(
        `SELECT COUNT(*) FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2`, [uid, c.id]
      )).rows[0].count)

      let canClaim = true
      let reason = ''

      if (c.type === 'new_user') {
        // 按手机号判断（防止换 openid 重新注册重领）
        const userPhone = user?.phone || ''
        if (userPhone) {
          const phoneOrderCount = parseInt((await pool.query(
            `SELECT COUNT(*) FROM mini_orders o
             JOIN mini_users u ON u.id=o.user_id
             WHERE u.phone=$1 AND o.status>=1`, [userPhone]
          )).rows[0].count)
          if (phoneOrderCount > 0) { canClaim = false; reason = '仅限新客' }
          const phoneClaimed = parseInt((await pool.query(
            `SELECT COUNT(*) FROM mini_user_coupons uc
             JOIN mini_users u ON u.id=uc.user_id
             WHERE u.phone=$1 AND uc.coupon_id=$2`, [userPhone, c.id]
          )).rows[0].count)
          if (phoneClaimed > 0) { canClaim = false; reason = '已领取' }
        } else {
          if (claimedByUser > 0) { canClaim = false; reason = '已领取' }
        }
      } else if (c.type === 'birthday') {
        const bm = user?.birth_month, bd = user?.birth_day
        if (!bm) { canClaim = false; reason = '请先设置生日' }
        else if (bm !== now.getMonth() + 1) { canClaim = false; reason = `生日月(${bm}月)可领` }
        else {
          // 同一年只能领一次
          const thisYear = (await pool.query(
            `SELECT COUNT(*) FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2 AND EXTRACT(YEAR FROM claimed_at)=$3`,
            [uid, c.id, now.getFullYear()]
          )).rows[0].count
          if (parseInt(thisYear) > 0) { canClaim = false; reason = '今年已领' }
        }
      } else {
        if (claimedByUser > 0) { canClaim = false; reason = '已领取' }
      }

      if (c.total_count > 0 && c.claimed_count >= c.total_count) { canClaim = false; reason = '已抢完' }

      result.push({ ...c, can_claim: canClaim, reason, claimed_by_user: claimedByUser })
    }
    return ok(res, result)
  } catch(e) { fail(res, e.message) }
})

// 领取优惠券
app.post('/miniapi/coupon/claim', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const { coupon_id } = req.body
    if (!coupon_id) return fail(res, 'coupon_id必填')
    const c = (await pool.query(`SELECT * FROM mini_coupons WHERE id=$1 AND status=1`, [coupon_id])).rows[0]
    if (!c) return fail(res, '优惠券不存在')
    if (c.end_at && new Date(c.end_at) < new Date()) return fail(res, '优惠券已过期')
    if (c.total_count > 0 && c.claimed_count >= c.total_count) return fail(res, '已抢完')

    const user = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [uid])).rows[0]
    const now = new Date()

    if (c.type === 'new_user') {
      const userPhone = user?.phone || ''
      if (userPhone) {
        const phoneOrderCount = parseInt((await pool.query(
          `SELECT COUNT(*) FROM mini_orders o
           JOIN mini_users u ON u.id=o.user_id
           WHERE u.phone=$1 AND o.status>=1`, [userPhone]
        )).rows[0].count)
        if (phoneOrderCount > 0) return fail(res, '仅限新用户领取')
        // 按券签名判断，防止历史重复券定义（不同 coupon_id）被重复领取；
        // 不同满减档位仍可各领一张。
        const phoneAlready = (await pool.query(
          `SELECT uc.id FROM mini_user_coupons uc
           JOIN mini_users u ON u.id=uc.user_id
           JOIN mini_coupons owned ON owned.id=uc.coupon_id
           WHERE u.phone=$1 AND uc.coupon_type='new_user'
             AND owned.name=$2 AND owned.discount_value=$3 AND owned.min_order=$4
           LIMIT 1`, [userPhone, c.name, c.discount_value, c.min_order]
        )).rows[0]
        if (phoneAlready) return fail(res, '您已领取过该档新客券')
      } else {
        const already = (await pool.query(
          `SELECT uc.id FROM mini_user_coupons uc
           JOIN mini_coupons owned ON owned.id=uc.coupon_id
           WHERE uc.user_id=$1 AND uc.coupon_type='new_user'
             AND owned.name=$2 AND owned.discount_value=$3 AND owned.min_order=$4
           LIMIT 1`, [uid, c.name, c.discount_value, c.min_order]
        )).rows[0]
        if (already) return fail(res, '您已领取过该档新客券')
      }
    } else if (c.type === 'birthday') {
      if (!user?.birth_month) return fail(res, '请先在个人中心设置生日')
      if (user.birth_month !== now.getMonth() + 1) return fail(res, `生日月（${user.birth_month}月）才能领取`)
      // 按类型判断：一年只能领一张 birthday 类型券
      const thisYear = parseInt((await pool.query(
        `SELECT COUNT(*) FROM mini_user_coupons WHERE user_id=$1 AND coupon_type='birthday' AND EXTRACT(YEAR FROM claimed_at)=$2`,
        [uid, now.getFullYear()]
      )).rows[0].count)
      if (thisYear > 0) return fail(res, '今年已领取过生日券')
    } else {
      const already = (await pool.query(`SELECT id FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2 LIMIT 1`, [uid, coupon_id])).rows[0]
      if (already) return fail(res, '您已领取过该券')
    }

    const expireAt = new Date(Date.now() + c.validity_days * 86400000)
    await pool.query(
      `INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,$3,0,$4)`,
      [uid, coupon_id, c.type, expireAt]
    )
    await pool.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [coupon_id])
    return ok(res, { message: `领取成功！${c.validity_days}天内有效`, expire_at: expireAt })
  } catch(e) { fail(res, e.message) }
})

// 我的优惠券列表
app.get('/miniapi/coupon/mine', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    // 自动标记过期
    await pool.query(`UPDATE mini_user_coupons SET status=2 WHERE user_id=$1 AND status=0 AND expire_at<NOW()`, [uid])
    const rows = (await pool.query(
      `SELECT uc.*, c.name, c.type, c.discount_value, c.min_order
       FROM mini_user_coupons uc JOIN mini_coupons c ON c.id=uc.coupon_id
       WHERE uc.user_id=$1 ORDER BY uc.status ASC, uc.expire_at ASC`,
      [uid]
    )).rows
    return ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 设置生日
app.post('/miniapi/user/birthday', miniAuth, async (req, res) => {
  try {
    const { month, day } = req.body
    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return fail(res, '日期无效')
    const existing = (await pool.query(`SELECT birth_month FROM mini_users WHERE id=$1`, [req.miniUser.id])).rows[0]
    if (existing?.birth_month) return fail(res, '生日只能设置一次')
    await pool.query(`UPDATE mini_users SET birth_month=$1, birth_day=$2 WHERE id=$3`, [month, day, req.miniUser.id])
    return ok(res, { message: '生日设置成功' })
  } catch(e) { fail(res, e.message) }
})

// 结算时验证并预占优惠券
app.post('/miniapi/coupon/apply', miniAuth, async (req, res) => {
  try {
    const { coupon_id, order_amount } = req.body
    if (!coupon_id) return ok(res, { discount: 0 })
    const uc = (await pool.query(
      `SELECT uc.*, c.discount_value, c.min_order FROM mini_user_coupons uc JOIN mini_coupons c ON c.id=uc.coupon_id WHERE uc.id=$1 AND uc.user_id=$2 AND uc.status=0`,
      [coupon_id, req.miniUser.id]
    )).rows[0]
    if (!uc) return fail(res, '优惠券无效或已使用')
    if (new Date(uc.expire_at) < new Date()) return fail(res, '优惠券已过期')
    if (parseFloat(order_amount) < parseFloat(uc.min_order)) return fail(res, `满${uc.min_order}元可用`)
    return ok(res, { discount: parseFloat(uc.discount_value), coupon_name: uc.name })
  } catch(e) { fail(res, e.message) }
})

// ERP后台：优惠券管理
app.get('/adminapi/mini/coupons', auth, async (req, res) => {
  try {
    const { page = 1, list_rows = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(list_rows)
    const total = parseInt((await pool.query(`SELECT COUNT(*) FROM mini_coupons`)).rows[0].count)
    const rows = (await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM mini_user_coupons uc WHERE uc.coupon_id=c.id) as user_count,
       (SELECT COUNT(*) FROM mini_user_coupons uc WHERE uc.coupon_id=c.id AND uc.status=1) as used_count
       FROM mini_coupons c ORDER BY c.id DESC LIMIT $1 OFFSET $2`,
      [parseInt(list_rows), offset]
    )).rows
    return ok(res, { rows, total })
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/mini/coupons/save', auth, async (req, res) => {
  try {
    const { id, name, type = 'general', discount_value, min_order = 0, validity_days = 30, total_count = -1, status = 1, end_at } = req.body
    if (!name || !discount_value) return fail(res, '名称和金额必填')
    if (id) {
      const r = await pool.query(
        `UPDATE mini_coupons SET name=$1,type=$2,discount_value=$3,min_order=$4,validity_days=$5,total_count=$6,status=$7,end_at=$8 WHERE id=$9 RETURNING *`,
        [name, type, discount_value, min_order, validity_days, total_count, status, end_at || null, id]
      )
      return ok(res, r.rows[0])
    } else {
      const r = await pool.query(
        `INSERT INTO mini_coupons (name,type,discount_value,min_order,validity_days,total_count,status,end_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name, type, discount_value, min_order, validity_days, total_count, status, end_at || null]
      )
      return ok(res, r.rows[0])
    }
  } catch(e) { fail(res, e.message) }
})

app.post('/adminapi/mini/coupons/del', auth, async (req, res) => {
  try {
    await pool.query(`UPDATE mini_coupons SET status=0 WHERE id=$1`, [req.body.id])
    return ok(res, {})
  } catch(e) { fail(res, e.message) }
})

// ─── 视频系统初始化 ──────────────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_videos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        video_url TEXT NOT NULL,
        cover_url TEXT DEFAULT '',
        goods_id INT DEFAULT 0,
        like_count INT DEFAULT 0,
        comment_count INT DEFAULT 0,
        view_count INT DEFAULT 0,
        sort INT DEFAULT 0,
        status SMALLINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_video_likes (
        id SERIAL PRIMARY KEY,
        video_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(video_id, user_id)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_video_comments (
        id SERIAL PRIMARY KEY,
        video_id INT NOT NULL,
        user_id INT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mvc_video ON mini_video_comments(video_id)`)
    await pool.query(`ALTER TABLE mini_video_comments ADD COLUMN IF NOT EXISTS display_name VARCHAR(40)`)
    // 内容频道兼容升级：保留原表及互动外键，增加图文所需字段。
    await pool.query(`ALTER TABLE mini_videos ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) NOT NULL DEFAULT 'video'`)
    await pool.query(`ALTER TABLE mini_videos ADD COLUMN IF NOT EXISTS content TEXT DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_videos ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await pool.query(`ALTER TABLE mini_videos ADD COLUMN IF NOT EXISTS source_url TEXT DEFAULT ''`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mini_content_type ON mini_videos(content_type, status, sort DESC, id DESC)`)
    // 首次启用图文频道时，用现有在售商品生成两篇可直接预览的示例内容。
    await pool.query(`
      WITH products AS (
        SELECT goods_id, jsonb_build_array(cover_url) AS pics,
               ROW_NUMBER() OVER (ORDER BY sort DESC, id DESC) AS rn
        FROM mini_videos
        WHERE content_type='video' AND status=1
          AND cover_url IS NOT NULL AND cover_url<>''
        LIMIT 2
      ), samples AS (
        SELECT goods_id, pics, rn,
          CASE rn
            WHEN 1 THEN '一口来自草原的鲜香，藏着怎样的好味道'
            ELSE '从产地到餐桌，我们认真守住每一份新鲜'
          END AS sample_title,
          CASE rn
            WHEN 1 THEN '顺着食材的来路，认识草原馈赠的自然风味。'
            ELSE '好食材不需要复杂修饰，安心、新鲜和本真的味道就是答案。'
          END AS sample_desc,
          CASE rn
            WHEN 1 THEN '风吹过牧场，草木的清香也被收藏进食材里。我们沿着产地寻找真实的味道，把适合一家人分享的草原好物认真送到餐桌。\\n\\n打开图片，看看这份鲜香从哪里来；也可以点击文末商品，了解更多食用与搭配方式。'
            ELSE '从挑选原料、整理包装到送达，每一步都值得认真。我们希望大家收到的不只是一件商品，也是一份看得见来路、吃得出新鲜的安心。\\n\\n简单烹饪，保留食材本身的香气，就是草原餐桌最舒服的打开方式。'
          END AS sample_content
        FROM products
      )
      INSERT INTO mini_videos
        (title, description, video_url, cover_url, goods_id, sort, status, content_type, content, images)
      SELECT sample_title, sample_desc, '', pics->>0, goods_id, 100-rn, 1, 'article', sample_content, pics
      FROM samples s
      WHERE NOT EXISTS (
        SELECT 1 FROM mini_videos v WHERE v.content_type='article'
      )
    `)
    // 品牌发现示例：6 张为同一篇内容，列表展示首图，详情页左右滑动查看。
    await pool.query(`
      UPDATE mini_videos
      SET title='发现｜了不起的家乡特产',
          description='奶豆腐、奶条、青砖茶与风干牛肉，一次认识来自草原的家乡味道。',
          content='有些味道来自时间，有些味道来自土地。奶豆腐慢慢蒸制，奶条保留鲜奶本味，青砖茶用热水一泡就香，风干牛肉则收藏着黄金纬度的风与阳光。\\n\\n左右滑动图片，一起发现这些值得被看见的家乡特产。',
          cover_url='https://nomaderp.pages.dev/media/covers/1784978586592_b8jhkm.jpg',
          images='[
            "https://nomaderp.pages.dev/media/covers/1784978586592_b8jhkm.jpg",
            "https://nomaderp.pages.dev/media/covers/1784978596721_k7fug2.jpg",
            "https://nomaderp.pages.dev/media/covers/1784978599407_zurfpr.jpg",
            "https://nomaderp.pages.dev/media/covers/1784978600545_276qyb.jpg",
            "https://nomaderp.pages.dev/media/covers/1784978599250_0mn7cc.jpg",
            "https://nomaderp.pages.dev/media/covers/1784978600234_5holkb.jpg"
          ]'::jsonb,
          source_url='',
          sort=120
      WHERE content_type='article'
        AND title IN ('一口来自草原的鲜香，藏着怎样的好味道', '发现｜了不起的家乡特产')
    `)
    // 第二张首屏卡片使用统一的品牌产品视觉，替换早期界面截图示例。
    await pool.query(`
      UPDATE mini_videos
      SET title='黄金纬度，藏在风里的草原滋味',
          description='经典风干牛肉，从黄金纬度出发，留下肉香与嚼劲。',
          content='在北纬 45° 左右的草原，充足日照、清爽空气与传统风干方式，共同塑造了牛肉干紧实而有层次的口感。\\n\\n慢慢嚼，能尝到肉香，也能尝到来自草原的风。',
          cover_url='https://nomaderp.pages.dev/media/covers/1784978599407_zurfpr.jpg',
          images='["https://nomaderp.pages.dev/media/covers/1784978599407_zurfpr.jpg"]'::jsonb,
          source_url='',
          goods_id=0,
          sort=110
      WHERE content_type='article'
        AND title IN ('从产地到餐桌，我们认真守住每一份新鲜', '黄金纬度，藏在风里的草原滋味')
    `)
    // 公众号文章同步：将右侧示例卡替换为“草原儿女从小吃到大的营养奶食品”。
    await pool.query(`
      UPDATE mini_videos
      SET title='草原儿女从小吃到大的营养奶食品',
          description='奶品营养家 · 牧区纯坊',
          content='',
          cover_url='https://nomaderp.pages.dev/media/covers/1784979365056_p5sgw6.jpg',
          images='[
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWyY3CAjsLLCiah6rOxsz9anwCoxXK0GRAgLOs5Sg7v2HwdibI7jNNtmibA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWynz5u4u2ua0ZU4e6WCqvzuxLySFzWAJSFba0uG04JVDfWwsM8BT4BA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWr9e4M6FqKIqRtsvNpK5HicutRux4LGy0tT1zoH8l4uQ8kaJKykIHTPA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWWpAibLIjyQpBvxbopR5Y9yQvt94Egiam2njSXNdcJeibBfaGhwmZkwO1w%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWdGgXOiby1kdCCStajmL49VDmWUOiacibcldf7nn6eZpGJS6kSWHIeadpg%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWiaTAeGG5BbdZmlL3qh1Ie2EVSLvicMic5XHcBgj59t1sIOPibp1MdN4JJg%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWom5szcYmn5ic69X5ygPHsPL2YnmYa7M7CWDXHuBToDh97plIU0ClBIQ%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWbKso7Xs9nNdeFTb91O3ia1lpYkx6giauyyNp4gsUKnrZ5dVzKIU9ZJCQ%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWxiasUOl0300w0gteRWWLV2hT1pHDLGasVZuz8FQyOfib1IwJfHtKtMHg%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWHOzWZqSh4ic5qWNAroI4W9ddy44CG5ZGpo7O2icxs34xzy23Cq6WgPcQ%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWeWPLaa39B3EohBss7icrmplHLnLLvyBmI5LxV9rIXVOUftpNZ09sQIg%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWNh1iaUAvkzs32eKDomxgkfqFqZA0q4N8iaEEQ3Y4VE5uQ3dbIl8k5Y8g%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWBNu72qLCxBhy0j2NwvrxTiaJXsgrvmkGkaToibGPdw1IXR0PA8Jq4e5w%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcW4Qh8ib5E1osWaKxSB2QWZzaDSQu6WXnja9HXJ7m1gGangBtE2SjRIPw%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcW6nST85VdCV6uS2ibyfeOmDz63kW593ibibCWyXvmWbzT1MFERFddeovMA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWX4wmw79zjjncWdPicMjLvvZl2rwBdiccRXhL0iapQhpOibjdwsSZHW4RdA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcW2vwOic6T2zeAuMQ1VEHEjMQqAO0VnzeFhQ6w2XWq3qz5H2jq4Sm1BNA%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWbIiaajGUOwaiac3dndGia8rbALoQdibzW8Mwm8fY5jPmlWQW14HfLiceicFw%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWzzqib82WeasnynG7VNUebMYXMnwiaUViaF0nEJ8lT5ic68Nu5X2daLBGxw%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWX9h0K0vJhe1880fCEXrteu3Sv3cLPVLHuyhKj2eW6rgyYC9XxTGOicw%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWN6qJLVn1fB94iba3HupL9V2dibVkl50kJ0Hic2xZxGWFj1BUE0fttchUQ%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWBQHZCL6iaGMSNms3VjNYFbM3fcnxRicEtPUF5FibH227QVaX0Zsq7vUYQ%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S37zYy14RhdE2T13hvMypcWILibyYs7DZY6u6nBqb7Q0kTYtuGHl3ibNCdChnia7j2DUSvcZqaJXNxPg%2F640%3Fwx_fmt%3Djpeg",
  "https://erp-server-xsji.onrender.com/miniapi/article-image?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fmmbiz_jpg%2FeOl7PcZd7S1dIqDJXky2fDLC3icpyzC9h6KNkM93CaW2hqnIZibukyonJqW9rEdTZo0YgID1qqsHgHXp3embKtBA%2F640%3Fwx_fmt%3Djpeg"
]'::jsonb,
          source_url='https://mp.weixin.qq.com/s/JeyRlj9GhCuMkui_XCJg4g',
          goods_id=0,
          sort=110
      WHERE content_type='article'
        AND title IN ('黄金纬度，藏在风里的草原滋味', '草原儿女从小吃到大的营养奶食品')
    `)
    // 清理由早期示例标题变更导致的重复记录，每篇只保留最早创建的一条。
    await pool.query(`
      DELETE FROM mini_videos
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY title ORDER BY id ASC) AS rn
          FROM mini_videos
          WHERE content_type='article'
            AND title IN ('发现｜了不起的家乡特产', '草原儿女从小吃到大的营养奶食品')
        ) duplicates
        WHERE rn > 1
      )
    `)

    // 为没有评论的视频插入预设评论
    const SEED_COMMENTS = [
      '草原的味道真的不一样，纯天然！',
      '买过好几次了，品质很稳定👍',
      '物流挺快的，包装也很用心',
      '奶酪真的很香，家里小孩特别喜欢',
      '支持国产好品牌，一直回购！',
      '第一次买，直接被种草了',
    ]
    const SEED_NAMES = ['草原阿嬷', '内蒙古买家', '奶酪爱好者', 'Monica💕', '小胖妈妈', '羊羊']
    const videos = (await pool.query(`SELECT id FROM mini_videos WHERE status=1`)).rows
    for (const v of videos) {
      const cnt = parseInt((await pool.query(`SELECT COUNT(*) FROM mini_video_comments WHERE video_id=$1`, [v.id])).rows[0].count)
      if (cnt === 0) {
        const picks = SEED_COMMENTS.sort(() => Math.random() - 0.5).slice(0, 3)
        for (let i = 0; i < picks.length; i++) {
          await pool.query(
            `INSERT INTO mini_video_comments (video_id, user_id, content, display_name) VALUES ($1, 0, $2, $3)`,
            [v.id, picks[i], SEED_NAMES[i % SEED_NAMES.length]]
          )
        }
        await pool.query(`UPDATE mini_videos SET comment_count=3 WHERE id=$1 AND comment_count=0`, [v.id])
      }
    }
    console.log('mini_videos tables ready')
  } catch(e) { console.log('mini_videos init:', e.message) }
})();

// 签到 & 转盘表初始化
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_signin (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        signin_date DATE NOT NULL,
        points_earned INTEGER DEFAULT 5,
        streak INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, signin_date)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_lottery (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        prize_name VARCHAR(50),
        prize_type VARCHAR(20) DEFAULT 'none',
        prize_value INTEGER DEFAULT 0,
        sector_index INTEGER DEFAULT 0,
        use_points BOOLEAN DEFAULT FALSE,
        points_spent INTEGER DEFAULT 0,
        spin_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE user_lottery ADD COLUMN IF NOT EXISTS use_points BOOLEAN DEFAULT FALSE`)
    await pool.query(`ALTER TABLE user_lottery ADD COLUMN IF NOT EXISTS points_spent INTEGER DEFAULT 0`)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS user_lottery_free_once_idx
      ON user_lottery(user_id, spin_date)
      WHERE COALESCE(use_points, FALSE) = FALSE
    `)
    console.log('signin & lottery tables ready')
  } catch(e) { console.log('signin/lottery init:', e.message) }
})()

// 视频列表（分页，支持滑动加载）
app.get('/miniapi/video/list', optionalMiniAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const contentType = req.query.type === 'article' ? 'article' : 'video'
    const limit = 5
    const offset = (page - 1) * limit
    const uid = req.miniUser?.id || 0

    const rows = (await pool.query(
      `SELECT v.*, g.goods_name, g.sell_price AS sale_price, g.images AS header_images
       FROM mini_videos v
       LEFT JOIN goods g ON g.id=v.goods_id
       WHERE v.status=1 AND v.content_type=$3
       ORDER BY v.sort DESC, v.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, contentType]
    )).rows

    // 当前用户点赞状态
    let likedIds = new Set()
    if (uid && rows.length) {
      const vids = rows.map(r => r.id)
      const lk = (await pool.query(
        `SELECT video_id FROM mini_video_likes WHERE user_id=$1 AND video_id=ANY($2)`,
        [uid, vids]
      )).rows
      lk.forEach(r => likedIds.add(r.video_id))
    }

    const list = rows.map(r => ({
      ...r,
      liked: likedIds.has(r.id),
      images: Array.isArray(r.images) ? r.images : [],
      header_images: r.header_images ? (typeof r.header_images === 'string' ? JSON.parse(r.header_images) : r.header_images) : [],
    }))
    return ok(res, { list, has_more: rows.length === limit })
  } catch(e) { fail(res, e.message) }
})

// 图文详情
app.get('/miniapi/content/detail/:id', optionalMiniAuth, async (req, res) => {
  try {
    const uid = req.miniUser?.id || 0
    const row = (await pool.query(
      `SELECT v.*, g.goods_name, g.sell_price AS sale_price, g.images AS header_images
       FROM mini_videos v
       LEFT JOIN goods g ON g.id=v.goods_id
       WHERE v.id=$1 AND v.status=1 LIMIT 1`,
      [req.params.id]
    )).rows[0]
    if (!row) return fail(res, '内容不存在')
    let liked = false
    if (uid) {
      liked = !!(await pool.query(
        `SELECT id FROM mini_video_likes WHERE video_id=$1 AND user_id=$2 LIMIT 1`,
        [row.id, uid]
      )).rows[0]
    }
    await pool.query(`UPDATE mini_videos SET view_count=view_count+1 WHERE id=$1`, [row.id])
    return ok(res, {
      ...row,
      liked,
      images: Array.isArray(row.images) ? row.images : [],
      header_images: row.header_images ? (typeof row.header_images === 'string' ? JSON.parse(row.header_images) : row.header_images) : [],
    })
  } catch(e) { fail(res, e.message) }
})

// 点赞/取消点赞
app.post('/miniapi/video/like', miniAuth, async (req, res) => {
  try {
    const { video_id } = req.body
    const uid = req.miniUser.id
    const existing = (await pool.query(
      `SELECT id FROM mini_video_likes WHERE video_id=$1 AND user_id=$2`, [video_id, uid]
    )).rows[0]
    if (existing) {
      await pool.query(`DELETE FROM mini_video_likes WHERE video_id=$1 AND user_id=$2`, [video_id, uid])
      await pool.query(`UPDATE mini_videos SET like_count=GREATEST(0,like_count-1) WHERE id=$1`, [video_id])
      return ok(res, { liked: false })
    } else {
      await pool.query(`INSERT INTO mini_video_likes (video_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [video_id, uid])
      await pool.query(`UPDATE mini_videos SET like_count=like_count+1 WHERE id=$1`, [video_id])
      return ok(res, { liked: true })
    }
  } catch(e) { fail(res, e.message) }
})

// 评论列表
app.get('/miniapi/video/comments', async (req, res) => {
  try {
    const { video_id } = req.query
    const rows = (await pool.query(
      `SELECT c.*, u.name, u.phone FROM mini_video_comments c
       LEFT JOIN mini_users u ON u.id=c.user_id
       WHERE c.video_id=$1 ORDER BY c.id DESC LIMIT 50`,
      [video_id]
    )).rows
    return ok(res, rows.map(r => ({
      ...r,
      display_name: r.display_name || r.name || (r.phone ? r.phone.slice(0,3)+'****'+r.phone.slice(-2) : '用户'),
    })))
  } catch(e) { fail(res, e.message) }
})

// 发表评论
app.post('/miniapi/video/comment', miniAuth, async (req, res) => {
  try {
    const { video_id, content } = req.body
    if (!content?.trim()) return fail(res, '评论不能为空')
    const uid = req.miniUser.id
    await pool.query(
      `INSERT INTO mini_video_comments (video_id,user_id,content) VALUES ($1,$2,$3)`,
      [video_id, uid, content.trim()]
    )
    await pool.query(`UPDATE mini_videos SET comment_count=comment_count+1 WHERE id=$1`, [video_id])
    const user = (await pool.query(`SELECT name,phone FROM mini_users WHERE id=$1`, [uid])).rows[0]
    return ok(res, {
      display_name: user?.name || (user?.phone ? user.phone.slice(0,3)+'****'+user.phone.slice(-2) : '用户'),
      content: content.trim(),
      created_at: new Date(),
    })
  } catch(e) { fail(res, e.message) }
})

// 曝光计数（静默，不返回数据）
app.post('/miniapi/video/view', async (req, res) => {
  try {
    const { video_id } = req.body
    if (video_id) await pool.query(`UPDATE mini_videos SET view_count=view_count+1 WHERE id=$1`, [video_id])
    return ok(res, {})
  } catch(e) { ok(res, {}) }
})

// 管理端：视频列表
app.get('/adminapi/mini/videos', auth, async (req, res) => {
  try {
    const { page = 1, list_rows = 20 } = req.query
    const offset = (page - 1) * list_rows
    const total = (await pool.query(`SELECT COUNT(*) FROM mini_videos`)).rows[0].count
    const rows = (await pool.query(
      `SELECT * FROM mini_videos ORDER BY sort DESC, id DESC LIMIT $1 OFFSET $2`,
      [list_rows, offset]
    )).rows
    return ok(res, { total: +total, list: rows })
  } catch(e) { fail(res, e.message) }
})

// 管理端：新增/编辑视频
app.post('/adminapi/mini/videos/save', auth, async (req, res) => {
  try {
    const {
      id, title, description, video_url = '', cover_url = '', goods_id,
      sort = 0, status = 1, content_type = 'video', content = '', images = [], source_url = ''
    } = req.body
    if (!title) return fail(res, '标题必填')
    if (content_type === 'video' && !video_url) return fail(res, '请上传视频')
    if (content_type === 'article' && !cover_url && !images.length) return fail(res, '请至少上传一张图片')
    const safeType = content_type === 'article' ? 'article' : 'video'
    const safeImages = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : []
    if (id) {
      const r = await pool.query(
        `UPDATE mini_videos
         SET title=$1,description=$2,video_url=$3,cover_url=$4,goods_id=$5,sort=$6,status=$7,
             content_type=$8,content=$9,images=$10::jsonb,source_url=$11
         WHERE id=$12 RETURNING *`,
        [title, description, video_url, cover_url, goods_id || 0, sort, status,
          safeType, content, JSON.stringify(safeImages), source_url, id]
      )
      return ok(res, r.rows[0])
    } else {
      const r = await pool.query(
        `INSERT INTO mini_videos
         (title,description,video_url,cover_url,goods_id,sort,status,content_type,content,images,source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,
        [title, description, video_url, cover_url, goods_id || 0, sort, status,
          safeType, content, JSON.stringify(safeImages), source_url]
      )
      return ok(res, r.rows[0])
    }
  } catch(e) { fail(res, e.message) }
})

// 管理端：删除视频
app.post('/adminapi/mini/videos/del', auth, async (req, res) => {
  try {
    await pool.query(`UPDATE mini_videos SET status=0 WHERE id=$1`, [req.body.id])
    return ok(res, {})
  } catch(e) { fail(res, e.message) }
})

// 视频上传 token（管理端）—— 七牛已弃用，当前直接把视频文件放进 public/videos/ 随前端 build 部署
app.get('/adminapi/mini/video-token', auth, (_req, res) => fail(res, '视频请直接放在 public/videos/ 目录随前端部署，或上传到 Cloudflare KV 后引用 /media/<key>'))

// 管理端：发货并推送订阅消息
app.post('/adminapi/mini/ship', auth, async (req, res) => {
  try {
    const { order_id, express_company, express_no } = req.body
    if (!order_id) return fail(res, 'order_id必填')
    const order = (await pool.query(`SELECT * FROM mini_orders WHERE id=$1`, [order_id])).rows[0]
    if (!order) return fail(res, '订单不存在')
    // 更新订单状态为已发货（status=2）
    await pool.query(`UPDATE mini_orders SET status=2, express_company=$1, tracking_no=$2, shipped_at=NOW() WHERE id=$3`,
      [express_company || '', express_no || '', order_id])
    // 推送订阅消息
    const user = (await pool.query(`SELECT openid FROM mini_users WHERE id=$1`, [order.user_id])).rows[0]
    if (user?.openid && TMPL_SHIP) {
      const items = (await pool.query(`SELECT goods_name FROM mini_order_items WHERE order_id=$1`, [order_id])).rows
      const goodsName = items.map(i => i.goods_name).join('、').slice(0, 20)
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      await sendSubscribeMsg(user.openid, TMPL_SHIP, `pages/order/detail?id=${order_id}`, {
        thing1: { value: goodsName },                        // 商品名称
        thing2: { value: express_company || '快递' },        // 快递方式
        character_string1: { value: express_no || '待更新' }, // 快递单号
        time1: { value: now.slice(0, 16) },                  // 发货时间
      })
    }
    return ok(res, {})
  } catch(e) { fail(res, e.message) }
})

// 管理端：手动推送营销消息（如新品通知）
app.post('/adminapi/mini/broadcast', auth, async (req, res) => {
  try {
    const { tmpl_id, page = 'pages/index/index', data, user_ids } = req.body
    if (!tmpl_id) return fail(res, 'tmpl_id必填')
    const token = await getWxAccessToken()
    if (!token) return fail(res, '微信Token获取失败，请检查WX_APPSECRET配置')
    // 如果指定了user_ids就只推这几个，否则推所有有openid的用户
    let users
    if (user_ids && user_ids.length) {
      users = (await pool.query(`SELECT openid FROM mini_users WHERE id=ANY($1) AND openid IS NOT NULL`, [user_ids])).rows
    } else {
      users = (await pool.query(`SELECT openid FROM mini_users WHERE openid IS NOT NULL LIMIT 500`)).rows
    }
    let sent = 0
    for (const u of users) {
      await sendSubscribeMsg(u.openid, tmpl_id, page, data || {})
      sent++
      await new Promise(r => setTimeout(r, 50)) // 避免频率限制
    }
    return ok(res, { sent })
  } catch(e) { fail(res, e.message) }
})

// ─── 积分兑换优惠券 ───────────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_points_goods_redemptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        goods_id INTEGER NOT NULL,
        goods_name VARCHAR(128) NOT NULL,
        points_cost INTEGER NOT NULL,
        status SMALLINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
  } catch(e) { console.log('mini_points_goods_redemptions init:', e.message) }
})()

// 可兑换列表（带当前积分）
app.get('/miniapi/points/redeemable', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const user = (await pool.query(`SELECT points FROM mini_users WHERE id=$1`, [uid])).rows[0]
    const coupons = (await pool.query(
      `SELECT id, name, discount_value, min_order, validity_days, points_cost
       FROM mini_coupons WHERE type='points_exchange' AND status=1 ORDER BY points_cost ASC`
    )).rows
    // 查询积分商城商品（remark.__brand__.isRedeemable = true）
    const allGoods = (await pool.query(
      `SELECT id, goods_name, images, remark, sell_price, unit_name FROM goods WHERE deleted_at IS NULL AND status=1 LIMIT 500`
    )).rows
    const redeemGoods = allGoods
      .filter(g => { try { return JSON.parse(g.remark || '{}')['__brand__']?.isRedeemable === true } catch { return false } })
      .map(g => {
        let brand = {}
        try { brand = JSON.parse(g.remark || '{}')['__brand__'] || {} } catch {}
        const img = brand.image || (g.images ? g.images.split(',')[0] : '') || ''
        return {
          id: `goods_${g.id}`,
          goods_id: g.id,
          name: g.goods_name,
          image: img ? (img.startsWith('http') ? img : `https://erp-server-xsji.onrender.com${img}`) : '',
          points_cost: brand.pointsCost || 0,
          description: brand.description || '',
          type: 'goods',
        }
      })
      .filter(g => g.points_cost > 0)
      .sort((a, b) => a.points_cost - b.points_cost)
    ok(res, { points: user?.points || 0, coupons, goods: redeemGoods })
  } catch(e) { fail(res, e.message) }
})

// 积分兑换
app.post('/miniapi/points/redeem', miniAuth, async (req, res) => {
  const client = await pool.connect()
  try {
    const { coupon_id } = req.body
    const uid = req.miniUser.id
    await client.query('BEGIN')
    const c = (await client.query(`SELECT * FROM mini_coupons WHERE id=$1 AND type='points_exchange' AND status=1 FOR UPDATE`, [coupon_id])).rows[0]
    if (!c) {
      await client.query('ROLLBACK')
      return fail(res, '券不存在')
    }
    const user = (await client.query(`SELECT points FROM mini_users WHERE id=$1 FOR UPDATE`, [uid])).rows[0]
    if ((user?.points || 0) < c.points_cost) {
      await client.query('ROLLBACK')
      return fail(res, `积分不足，需要${c.points_cost}分`)
    }
    const expireAt = new Date(Date.now() + c.validity_days * 86400000)
    await client.query(`INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,$3,0,$4)`, [uid, c.id, c.type, expireAt])
    await client.query(`UPDATE mini_users SET points=points-$1 WHERE id=$2`, [c.points_cost, uid])
    await client.query(
      `INSERT INTO mini_points_log (user_id,points,type,remark,created_at)
       VALUES ($1,$2,'use',$3,NOW())`,
      [uid, -c.points_cost, `积分兑换优惠券：${c.name}`]
    )
    await client.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [c.id])
    const newPoints = (user.points || 0) - c.points_cost
    await client.query('COMMIT')
    ok(res, { points: newPoints, coupon_name: c.name })
  } catch(e) {
    await client.query('ROLLBACK')
    fail(res, e.message)
  } finally {
    client.release()
  }
})

// 积分兑换商品
app.post('/miniapi/points/redeem-goods', miniAuth, async (req, res) => {
  const client = await pool.connect()
  try {
    const uid = req.miniUser.id
    const goodsId = parseInt(req.body.goods_id || 0)
    if (!goodsId) return fail(res, 'goods_id必填')
    const g = (await client.query(
      `SELECT id, goods_name, remark FROM goods WHERE id=$1 AND deleted_at IS NULL AND status=1`,
      [goodsId]
    )).rows[0]
    if (!g) return fail(res, '商品不存在')
    let brand = {}
    try { brand = JSON.parse(g.remark || '{}')['__brand__'] || {} } catch {}
    if (brand.isRedeemable !== true) return fail(res, '该商品不可积分兑换')
    const pointsCost = parseInt(brand.pointsCost || 0)
    if (pointsCost <= 0) return fail(res, '兑换积分配置无效')

    await client.query('BEGIN')
    const user = (await client.query(`SELECT points FROM mini_users WHERE id=$1 FOR UPDATE`, [uid])).rows[0]
    if ((user?.points || 0) < pointsCost) {
      await client.query('ROLLBACK')
      return fail(res, `积分不足，需要${pointsCost}分`)
    }
    await client.query(`UPDATE mini_users SET points=COALESCE(points,0)-$1 WHERE id=$2`, [pointsCost, uid])
    await client.query(
      `INSERT INTO mini_points_log (user_id,points,type,remark,created_at)
       VALUES ($1,$2,'use',$3,NOW())`,
      [uid, -pointsCost, `积分兑换商品：${g.goods_name}`]
    )
    const row = (await client.query(
      `INSERT INTO mini_points_goods_redemptions (user_id, goods_id, goods_name, points_cost)
       VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [uid, goodsId, g.goods_name, pointsCost]
    )).rows[0]
    await client.query('COMMIT')
    return ok(res, {
      id: row.id,
      points: (user.points || 0) - pointsCost,
      goods_name: g.goods_name,
      message: '兑换成功，请联系客服确认领取方式',
    })
  } catch(e) {
    await client.query('ROLLBACK')
    return fail(res, e.message)
  } finally {
    client.release()
  }
})

// ─── 包装二维码生成 & 扫码追踪 ────────────────────────────────────────────────

// 初始化扫码记录表
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qr_scans (
        id SERIAL PRIMARY KEY,
        scene VARCHAR(100) NOT NULL,
        user_id INTEGER,
        scanned_at TIMESTAMP DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_qr_scene ON qr_scans(scene)`)
  } catch(e) { console.log('qr_scans init:', e.message) }
})()

// 管理端：生成小程序码图片（返回 base64）
app.post('/adminapi/mini/qrcode', auth, async (req, res) => {
  try {
    const { scene = 'pkg001', page = 'pages/lottery/index', width = 430 } = req.body
    const token = await getWxAccessToken()
    if (!token) return fail(res, '微信Token获取失败，请检查WX_APPSECRET配置')
    const wxRes = await fetch(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene, page, width, is_hyaline: false }),
      }
    )
    const contentType = wxRes.headers.get('content-type') || ''
    if (contentType.includes('image')) {
      const buf = Buffer.from(await wxRes.arrayBuffer())
      const b64 = buf.toString('base64')
      return ok(res, { base64: `data:image/png;base64,${b64}`, scene })
    }
    const json = await wxRes.json()
    fail(res, json.errmsg || '生成失败')
  } catch(e) { fail(res, e.message) }
})

// 管理端：扫码统计
app.get('/adminapi/mini/qrcode/stats', auth, async (req, res) => {
  try {
    const rows = (await pool.query(`
      SELECT scene, COUNT(*) AS total,
             COUNT(DISTINCT user_id) AS unique_users,
             MAX(scanned_at) AS last_scan
      FROM qr_scans GROUP BY scene ORDER BY total DESC
    `)).rows
    ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 小程序端：上报扫码（scene 来自二维码参数）
app.post('/miniapi/qr/scan', async (req, res) => {
  try {
    const { scene } = req.body
    if (!scene) return ok(res, {})
    // 可选：从 token 取 user_id
    let userId = null
    const tk = req.headers['mini-token']
    if (tk) {
      try {
        const jwt = require('jsonwebtoken')
        const dec = jwt.verify(tk, process.env.JWT_SECRET || 'nomad_secret')
        userId = dec.id
      } catch {}
    }
    await pool.query(`INSERT INTO qr_scans (scene, user_id) VALUES ($1,$2)`, [scene, userId])
    ok(res, {})
  } catch(e) { fail(res, e.message) }
})

// ─── 签到 & 转盘 ─────────────────────────────────────────────────────────────

app.get('/miniapi/signin/status', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const today = todayCN()
    const todayRow = (await pool.query(
      `SELECT points_earned, streak FROM user_signin WHERE user_id=$1 AND signin_date=$2`, [uid, today]
    )).rows[0]
    let streak = todayRow ? todayRow.streak : 0
    if (!todayRow) {
      const yesterday = todayCN(-1)
      const y = (await pool.query(`SELECT streak FROM user_signin WHERE user_id=$1 AND signin_date=$2`, [uid, yesterday])).rows[0]
      streak = y ? y.streak : 0
    }
    ok(res, { signed_today: !!todayRow, streak, points_earned: todayRow?.points_earned || 0 })
  } catch(e) { fail(res, e.message) }
})

app.post('/miniapi/signin', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const today = todayCN()
    const existing = (await pool.query(`SELECT id FROM user_signin WHERE user_id=$1 AND signin_date=$2`, [uid, today])).rows[0]
    if (existing) return fail(res, '今天已签到')
    const yesterday = todayCN(-1)
    const y = (await pool.query(`SELECT streak FROM user_signin WHERE user_id=$1 AND signin_date=$2`, [uid, yesterday])).rows[0]
    const streak = y ? y.streak + 1 : 1
    const points = streak >= 7 ? 10 : streak >= 4 ? 8 : 5
    await pool.query(`INSERT INTO user_signin (user_id, signin_date, points_earned, streak) VALUES ($1,$2,$3,$4)`, [uid, today, points, streak])
    await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+$1 WHERE id=$2`, [points, uid])
    // 连签7天整数倍时发签到券
    let coupon_reward = null
    if (streak % 7 === 0) {
      const c = (await pool.query(`SELECT id FROM mini_coupons WHERE type='signin7' AND status=1 LIMIT 1`)).rows[0]
      if (c) {
        const expireAt = new Date(Date.now() + 14 * 86400000)
        try {
          await pool.query(
            `INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,'signin7',0,$3)`,
            [uid, c.id, expireAt]
          )
          await pool.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [c.id])
          coupon_reward = '签到7天专享券 ¥8'
        } catch {}
      }
    }
    ok(res, { streak, points_earned: points, coupon_reward })
  } catch(e) { fail(res, e.message) }
})

app.get('/miniapi/lottery/status', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const today = todayCN()
    const freeRow = (await pool.query(
      `SELECT id FROM user_lottery
       WHERE user_id=$1 AND spin_date=$2 AND COALESCE(use_points,FALSE)=FALSE
       LIMIT 1`,
      [uid, today]
    )).rows[0]
    const row = (await pool.query(
      `SELECT prize_name, prize_type, prize_value, use_points, points_spent
       FROM user_lottery
       WHERE user_id=$1 AND spin_date=$2
       ORDER BY id DESC
       LIMIT 1`,
      [uid, today]
    )).rows[0]
    ok(res, {
      spun_today: !!freeRow,
      last_prize: row ? {
        name: row.prize_name,
        type: row.prize_type,
        value: row.prize_value,
        use_points: row.use_points,
        points_spent: row.points_spent,
      } : null,
    })
  } catch(e) { fail(res, e.message) }
})

app.post('/miniapi/lottery/spin', miniAuth, async (req, res) => {
  try {
    const uid = req.miniUser.id
    const today = todayCN()
    const usePoints = req.body?.use_points === true || req.body?.use_points === 'true' || req.body?.use_points === 1 || req.body?.use_points === '1'
    const extraSpinCost = 50
    const PRIZES = [
      { name: '谢谢参与', type: 'none',   value: 0,   weight: 12 },
      { name: '5积分',   type: 'points', value: 5,   weight: 28 },
      { name: '¥5优惠券', type: 'coupon', value: 5,   weight: 15 },
      { name: '10积分',  type: 'points', value: 10,  weight: 22 },
      { name: '谢谢参与', type: 'none',   value: 0,   weight: 10 },
      { name: '50积分',  type: 'points', value: 50,  weight: 8  },
      { name: '¥10优惠券',type: 'coupon', value: 10,  weight: 3  },
      { name: '神秘好礼', type: 'goods',  value: 0,   weight: 2  },
    ]
    const total = PRIZES.reduce((s, p) => s + p.weight, 0)
    let r = Math.random() * total, prizeIdx = PRIZES.length - 1
    for (let i = 0; i < PRIZES.length; i++) { r -= PRIZES[i].weight; if (r <= 0) { prizeIdx = i; break } }
    const prize = PRIZES[prizeIdx]

    const client = await pool.connect()
    let points = null
    try {
      await client.query('BEGIN')

      if (usePoints) {
        // 每日积分加抽上限 5 次
        const todayUsePointsCount = parseInt((await client.query(
          `SELECT COUNT(*) FROM user_lottery WHERE user_id=$1 AND spin_date=$2 AND COALESCE(use_points,FALSE)=TRUE`,
          [uid, today]
        )).rows[0].count)
        const DAILY_USE_POINTS_LIMIT = 5
        if (todayUsePointsCount >= DAILY_USE_POINTS_LIMIT) {
          const err = new Error(`今日积分加抽已达上限（${DAILY_USE_POINTS_LIMIT}次），明天再来`)
          err.userMessage = err.message
          throw err
        }
        const user = (await client.query(`SELECT points FROM mini_users WHERE id=$1 FOR UPDATE`, [uid])).rows[0]
        const currentPoints = user?.points || 0
        if (currentPoints < extraSpinCost) {
          const err = new Error(`积分不足，需${extraSpinCost}分`)
          err.userMessage = err.message
          throw err
        }
        const updated = (await client.query(
          `UPDATE mini_users SET points=COALESCE(points,0)-$1 WHERE id=$2 RETURNING points`,
          [extraSpinCost, uid]
        )).rows[0]
        points = updated?.points || 0
        await client.query(
          `INSERT INTO mini_points_log (user_id,points,type,remark,created_at)
           VALUES ($1,$2,'use','积分加抽盲盒',NOW())`,
          [uid, -extraSpinCost]
        )
      } else {
        const existing = (await client.query(
          `SELECT id FROM user_lottery
           WHERE user_id=$1 AND spin_date=$2 AND COALESCE(use_points,FALSE)=FALSE
           LIMIT 1`,
          [uid, today]
        )).rows[0]
        if (existing) {
          const err = new Error('今天已抽过奖')
          err.userMessage = err.message
          throw err
        }
      }

      await client.query(
        `INSERT INTO user_lottery
         (user_id, prize_name, prize_type, prize_value, sector_index, use_points, points_spent, spin_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid, prize.name, prize.type, prize.value, prizeIdx, usePoints, usePoints ? extraSpinCost : 0, today]
      )

      if (prize.type === 'points' && prize.value > 0) {
        const updated = (await client.query(
          `UPDATE mini_users SET points=COALESCE(points,0)+$1 WHERE id=$2 RETURNING points`,
          [prize.value, uid]
        )).rows[0]
        points = updated?.points || 0
        await client.query(
          `INSERT INTO mini_points_log (user_id,points,type,remark,created_at)
           VALUES ($1,$2,'earn','盲盒抽奖',NOW())`,
          [uid, prize.value]
        )
      }

      if (prize.type === 'coupon') {
        const lc = (await client.query(
          `SELECT id FROM mini_coupons WHERE type='lottery' AND discount_value=$1 AND status=1 LIMIT 1`,
          [prize.value]
        )).rows[0]
        if (lc) {
          const expireAt = new Date(Date.now() + 7 * 86400000)
          await client.query(`INSERT INTO mini_user_coupons (user_id, coupon_id, coupon_type, status, expire_at) VALUES ($1,$2,'lottery',0,$3)`, [uid, lc.id, expireAt])
          await client.query(`UPDATE mini_coupons SET claimed_count=claimed_count+1 WHERE id=$1`, [lc.id])
        }
      }

      if (points === null) {
        points = ((await client.query(`SELECT points FROM mini_users WHERE id=$1`, [uid])).rows[0]?.points) || 0
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      if (e.code === '23505') return fail(res, '今天已抽过奖')
      if (e.userMessage) return fail(res, e.userMessage)
      throw e
    } finally {
      client.release()
    }

    ok(res, {
      prize_name: prize.name,
      prize_value: prize.value,
      prize_type: prize.type,
      sector_index: prizeIdx,
      use_points: usePoints,
      points_spent: usePoints ? extraSpinCost : 0,
      points,
    })
  } catch(e) { fail(res, e.message) }
})

// ─── 搜索热词 ───────────────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_search_log (
        id SERIAL PRIMARY KEY,
        keyword VARCHAR(100) NOT NULL,
        cnt INT DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(keyword)
      )
    `)
  } catch(e) { console.log('mini_search_log init:', e.message) }
})()

app.post('/miniapi/search/log', async (req, res) => {
  const { keyword } = req.body
  if (!keyword || keyword.trim().length < 1) return ok(res, {})
  pool.query(
    `INSERT INTO mini_search_log (keyword, cnt) VALUES ($1, 1)
     ON CONFLICT (keyword) DO UPDATE SET cnt=mini_search_log.cnt+1, updated_at=NOW()`,
    [keyword.trim().slice(0, 50)]
  ).catch(() => {})
  ok(res, {})
})

app.get('/miniapi/goods/hot-search', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT keyword FROM mini_search_log ORDER BY cnt DESC LIMIT 8`
    )).rows.map(r => r.keyword)
    const fallback = ['羊奶粉', '奶酪', '酥油', '黄油', '牧区礼盒', '牦牛', '马奶', '奶片']
    const hot = rows.length >= 4 ? rows : [...new Set([...rows, ...fallback])].slice(0, 8)
    ok(res, hot)
  } catch(e) { fail(res, e.message) }
})

// 购物车商品有效性验证
app.post('/miniapi/cart/validate', async (req, res) => {
  try {
    const { items } = req.body  // [{goods_id, spec}]
    if (!items?.length) return ok(res, { invalid: [] })
    const ids = items.map(i => i.goods_id)
    const rows = (await pool.query(
      `SELECT id FROM goods WHERE id=ANY($1) AND deleted_at IS NULL AND status=1 AND can_sale=1`,
      [ids]
    )).rows
    const validIds = new Set(rows.map(r => r.id))
    const invalid = items.filter(i => !validIds.has(i.goods_id)).map(i => i.goods_id)
    ok(res, { invalid })
  } catch(e) { fail(res, e.message) }
})

// ─── 退款/售后 ──────────────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_refunds (
        id SERIAL PRIMARY KEY,
        order_id INT NOT NULL,
        user_id INT NOT NULL,
        reason VARCHAR(200) NOT NULL DEFAULT '',
        images TEXT DEFAULT '',
        status INT DEFAULT 0,
        amount DECIMAL(10,2) DEFAULT 0,
        note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        handled_at TIMESTAMPTZ
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refunds_order ON mini_refunds(order_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refunds_user  ON mini_refunds(user_id)`)
    await pool.query(`ALTER TABLE mini_refunds ADD COLUMN IF NOT EXISTS wx_refund_no VARCHAR(64) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_refunds ADD COLUMN IF NOT EXISTS original_order_status INT DEFAULT 1`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS wx_transaction_id VARCHAR(64) DEFAULT ''`)
  } catch(e) { console.log('mini_refunds init:', e.message) }
})()

// 申请退款
app.post('/miniapi/refund/apply', miniAuth, async (req, res) => {
  const client = await pool.connect()
  try {
    const { order_id, reason, images = '' } = req.body
    if (!order_id || !reason) return fail(res, '请填写退款原因')
    await client.query('BEGIN')
    // 锁订单防双击
    const order = (await client.query(
      `SELECT id, user_id, total_amount, status FROM mini_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [order_id]
    )).rows[0]
    if (!order) { await client.query('ROLLBACK'); return fail(res, '订单不存在') }
    if (order.user_id !== req.miniUser.id) { await client.query('ROLLBACK'); return fail(res, '无权操作') }
    if (order.status === 0) { await client.query('ROLLBACK'); return fail(res, '订单未付款，可直接取消') }
    if (order.status === 4) { await client.query('ROLLBACK'); return fail(res, '订单已取消') }
    if (order.status === 5) { await client.query('ROLLBACK'); return fail(res, '退款申请处理中') }
    const existing = (await client.query(
      `SELECT id, status FROM mini_refunds WHERE order_id=$1 AND status != 2 LIMIT 1`, [order_id]
    )).rows[0]
    if (existing) {
      await client.query('ROLLBACK')
      return fail(res, existing.status === 0 ? '退款申请处理中' : '退款已完成')
    }
    // 校验：已退累计 + 本次 ≤ 订单总额
    const refundedSum = parseFloat((await client.query(
      `SELECT COALESCE(SUM(amount),0) as s FROM mini_refunds WHERE order_id=$1 AND status=1`, [order_id]
    )).rows[0].s)
    const remaining = parseFloat(order.total_amount) - refundedSum
    if (remaining <= 0) {
      await client.query('ROLLBACK')
      return fail(res, '该订单已全额退款')
    }
    await client.query(
      `INSERT INTO mini_refunds (order_id, user_id, reason, images, amount, status, original_order_status) VALUES ($1,$2,$3,$4,$5,0,$6)`,
      [order_id, req.miniUser.id, reason, images, remaining, order.status]
    )
    await client.query(`UPDATE mini_orders SET status=5 WHERE id=$1`, [order_id])
    await client.query('COMMIT')
    const key = process.env.SERVER_JIANG_KEY
    if (key) {
      const title = encodeURIComponent('🔄 新退款申请')
      const desp = encodeURIComponent(`订单：#${order_id}\n原因：${reason}\n金额：¥${remaining}`)
      fetch(`https://sctapi.ftqq.com/${key}.send?title=${title}&desp=${desp}`).catch(() => {})
    }
    ok(res, { message: '退款申请已提交' })
  } catch(e) {
    await client.query('ROLLBACK').catch(() => {})
    fail(res, e.message)
  } finally {
    client.release()
  }
})

// 我的退款列表
app.get('/miniapi/refund/mine', miniAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT r.*, o.order_no, o.total_amount as order_amount
       FROM mini_refunds r JOIN mini_orders o ON o.id=r.order_id
       WHERE r.user_id=$1 ORDER BY r.created_at DESC`,
      [req.miniUser.id]
    )).rows
    ok(res, rows)
  } catch(e) { fail(res, e.message) }
})

// 查询订单的退款状态（小程序端用，订单详情页展示）
app.get('/miniapi/refund/order/:order_id', miniAuth, async (req, res) => {
  try {
    const refund = (await pool.query(
      `SELECT id, status, amount, reason, note, created_at, handled_at, wx_refund_no
       FROM mini_refunds WHERE order_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [req.params.order_id, req.miniUser.id]
    )).rows[0]
    ok(res, refund || null)
  } catch(e) { fail(res, e.message) }
})

// 管理端：退款列表
app.get('/adminapi/refund/list', auth, async (req, res) => {
  try {
    const { status, page = 1 } = req.query
    const pageNum = Math.max(1, parseInt(page) || 1)
    const offset = (pageNum - 1) * 20
    let where = ''
    const params = []
    if (status !== undefined && status !== '') { where = 'WHERE r.status=$1'; params.push(parseInt(status)) }
    const listParams = [...params, 20, offset]
    const rows = (await pool.query(
      `SELECT r.*, o.order_no, u.name as user_name, u.phone as user_phone
       FROM mini_refunds r
       JOIN mini_orders o ON o.id=r.order_id
       LEFT JOIN mini_users u ON u.id=r.user_id
       ${where}
       ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    )).rows
    const total = (await pool.query(
      `SELECT COUNT(*) FROM mini_refunds r ${where}`, params
    )).rows[0].count
    ok(res, { rows, total: parseInt(total) })
  } catch(e) { fail(res, e.message) }
})

// 管理端：处理退款（同意/拒绝）
app.post('/adminapi/refund/handle', auth, async (req, res) => {
  try {
    const { id, action, note = '' } = req.body  // action: 'approve' | 'reject'
    if (!id || !action) return fail(res, '参数缺失')
    const refund = (await pool.query(
      `SELECT r.*, o.order_no, o.wx_transaction_id, o.total_amount as order_amount, o.user_id, u.openid
       FROM mini_refunds r
       JOIN mini_orders o ON o.id=r.order_id
       LEFT JOIN mini_users u ON u.id=o.user_id
       WHERE r.id=$1 LIMIT 1`, [id]
    )).rows[0]
    if (!refund) return fail(res, '退款记录不存在')
    if (refund.status !== 0) return fail(res, '该申请已处理')

    if (action === 'approve') {
      // 调用微信退款接口
      const refundNo = `RF${refund.id}T${Date.now()}`
      const wxResult = await wxV3Refund(
        refund.order_no,
        refund.wx_transaction_id || '',
        refundNo,
        parseFloat(refund.amount),
        refund.reason
      )
      if (wxResult.code && wxResult.code !== 'SUCCESS' && !wxResult.skipped) {
        return fail(res, `微信退款失败：${wxResult.message || wxResult.code}`)
      }
      // 同事务：标退款单、改订单状态、回滚积分/券/库存
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE mini_refunds SET status=1, note=$1, handled_at=NOW(), wx_refund_no=$2 WHERE id=$3`,
          [note, wxResult.refund_id || refundNo, id]
        )
        const fullOrder = (await client.query(
          `SELECT * FROM mini_orders WHERE id=$1 FOR UPDATE`, [refund.order_id]
        )).rows[0]
        if (fullOrder) {
          await releaseOrderBenefits(client, fullOrder, '退款回滚')
        }
        await client.query(`UPDATE mini_orders SET status=4 WHERE id=$1`, [refund.order_id])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        // 微信钱已退但DB回滚失败：记日志后人工处理
        console.error('[refund/handle] DB rollback after wx refund success', e.message, { refund_id: id })
        return fail(res, '退款已发起但本地回滚失败，请联系管理员')
      } finally {
        client.release()
      }
    } else {
      // 拒绝：还原订单原始状态
      await pool.query(
        `UPDATE mini_refunds SET status=2, note=$1, handled_at=NOW() WHERE id=$2`,
        [note, id]
      )
      await pool.query(
        `UPDATE mini_orders SET status=$1 WHERE id=$2`,
        [refund.original_order_status || 1, refund.order_id]
      )
    }
    // 推送订阅消息给用户
    if (refund.openid && TMPL_REFUND) {
      const label = action === 'approve' ? '退款已同意' : '退款已拒绝'
      sendSubscribeMsg(refund.openid, TMPL_REFUND, `pages/order/detail?id=${refund.order_id}`, {
        thing1: { value: `订单 ${refund.order_no}` },
        phrase2: { value: label },
        amount3: { value: `¥${refund.amount}` },
        thing4: { value: note || (action === 'approve' ? '将原路退回' : '申请未通过') },
      }).catch(() => {})
    }
    ok(res, { message: action === 'approve' ? '已同意退款' : '已拒绝退款' })
  } catch(e) { fail(res, e.message) }
})

// ─── 商品收藏 ──────────────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_favorites (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        goods_id INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, goods_id)
      )
    `)
  } catch(e) { console.log('mini_favorites init:', e.message) }
})()

// 收藏/取消收藏
app.post('/miniapi/favorite/toggle', miniAuth, async (req, res) => {
  try {
    const { goods_id } = req.body
    if (!goods_id) return fail(res, 'goods_id必填')
    const exists = (await pool.query(
      `SELECT id FROM mini_favorites WHERE user_id=$1 AND goods_id=$2 LIMIT 1`,
      [req.miniUser.id, goods_id]
    )).rows[0]
    if (exists) {
      await pool.query(`DELETE FROM mini_favorites WHERE user_id=$1 AND goods_id=$2`, [req.miniUser.id, goods_id])
      ok(res, { favorited: false })
    } else {
      await pool.query(`INSERT INTO mini_favorites (user_id, goods_id) VALUES ($1,$2)`, [req.miniUser.id, goods_id])
      ok(res, { favorited: true })
    }
  } catch(e) { fail(res, e.message) }
})

// 我的收藏列表
app.get('/miniapi/favorite/list', miniAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT f.goods_id, f.created_at,
              g.goods_name, g.sell_price as sale_price, g.unit_name as unit,
              g.remark, g.images
       FROM mini_favorites f
       JOIN goods g ON g.id=f.goods_id AND g.deleted_at IS NULL
       WHERE f.user_id=$1 ORDER BY f.created_at DESC`,
      [req.miniUser.id]
    )).rows
    const mapped = rows.map(g => {
      let brand = {}
      try { brand = JSON.parse(g.remark || '{}')['__brand__'] || {} } catch {}
      const cover = brand.image || (g.images ? g.images.split(',')[0] : '') || ''
      return { goods_id: g.goods_id, goods_name: g.goods_name, sale_price: parseFloat(g.sale_price) || 0, unit: g.unit || '件', cover, created_at: g.created_at }
    })
    ok(res, mapped)
  } catch(e) { fail(res, e.message) }
})

// 查询单个商品是否已收藏
app.get('/miniapi/favorite/check', miniAuth, async (req, res) => {
  try {
    const { goods_id } = req.query
    const exists = (await pool.query(
      `SELECT id FROM mini_favorites WHERE user_id=$1 AND goods_id=$2 LIMIT 1`,
      [req.miniUser.id, goods_id]
    )).rows[0]
    ok(res, { favorited: !!exists })
  } catch(e) { fail(res, e.message) }
})

// ─── 分销商小程序码（供小程序端调用）────────────────────────────────────────

app.get('/miniapi/qr/distributor', miniAuth, async (req, res) => {
  try {
    const dist = (await pool.query(
      `SELECT code FROM distributors WHERE user_id=$1 AND status=1 LIMIT 1`, [req.miniUser.id]
    )).rows[0]
    if (!dist) return fail(res, '您还不是分销商')
    const token = await getWxAccessToken()
    if (!token) return fail(res, '微信Token获取失败')
    const wxRes = await fetch(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: `d=${dist.code}`, page: 'pages/index/index', width: 280, is_hyaline: true }),
      }
    )
    const ct = wxRes.headers.get('content-type') || ''
    if (ct.includes('image')) {
      const buf = Buffer.from(await wxRes.arrayBuffer())
      ok(res, { base64: `data:image/png;base64,${buf.toString('base64')}`, code: dist.code })
    } else {
      const json = await wxRes.json()
      fail(res, json.errmsg || '生成失败')
    }
  } catch(e) { fail(res, e.message) }
})

// 小程序前端获取订阅消息模板ID
app.get('/miniapi/config/tmpl-ids', (req, res) => {
  ok(res, {
    ship: TMPL_SHIP,
    refund: TMPL_REFUND,
    order_success: TMPL_ORDER_SUCCESS,
  })
})

// ─── 404 fallback ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ code: 0, message: `路由不存在: ${req.method} ${req.path}` })
})

start()
