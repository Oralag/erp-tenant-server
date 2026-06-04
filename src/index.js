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
const JWT_SECRET = process.env.JWT_SECRET || 'erp_secret_2024'

app.use(cors())
app.use(express.json())
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

// 健康检查（含DB诊断）
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

function fail(res, message = '操作失败', status = 200) {
  return res.status(status).json({ code: 0, message })
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
    const token = jwt.sign({ id: user.id, account: user.account }, JWT_SECRET, { expiresIn: '7d' })
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
      await listQuery(res, table, {
        keyword: req.query.keyword,
        keywordCols,
        baseWhere: extraListWhere,
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
      // update_time if column exists
      let sql = `UPDATE ${table} SET ${sets.join(',')}`
      try {
        const hasUpdate = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='update_time'`, [table])
        if (hasUpdate.rows.length > 0) sql += `, update_time=NOW()`
      } catch {}
      sql += ` WHERE id=$${vals.length + 1} RETURNING *`
      const result = await pool.query(sql, [...vals, id])
      return ok(res, result.rows[0])
    } catch (e) {
      return fail(res, e.message)
    }
  })

  router.post(path + '/del', async (req, res) => {
    try {
      const { id } = req.body
      if (!id) return fail(res, 'id不能为空')
      if (softDelete) {
        await pool.query(`UPDATE ${table} SET deleted_at=NOW() WHERE id=$1`, [id])
      } else {
        await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id])
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
      baseWhere: 'deleted_at IS NULL',
      orderBy: 'id DESC',
      page, list_rows, offset,
    })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoods/add', async (req, res) => {
  try {
    const body = req.body
    const cols = Object.keys(body).filter(k => GOODS_ALLOWED_COLS.has(k) && body[k] !== undefined && body[k] !== null && body[k] !== '')
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
    const sql = `UPDATE goods SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} RETURNING *`
    const r = await pool.query(sql, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoods/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE goods SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopGoodsCate
router.get('/goods/ShopGoodsCate/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_cate', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/add', async (req, res) => {
  try {
    const { name, parent_id = 0, sort = 0, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const dup = await pool.query('SELECT * FROM goods_cate WHERE name=$1 AND parent_id=$2 LIMIT 1', [name, parent_id])
    if (dup.rows.length) return ok(res, dup.rows[0])
    const r = await pool.query('INSERT INTO goods_cate (name,parent_id,sort,status) VALUES ($1,$2,$3,$4) RETURNING *', [name, parent_id, sort, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/edit', async (req, res) => {
  try {
    const { id, name, parent_id, sort, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE goods_cate SET name=COALESCE($1,name), parent_id=COALESCE($2,parent_id), sort=COALESCE($3,sort), status=COALESCE($4,status) WHERE id=$5 RETURNING *', [name, parent_id, sort, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopGoodsCate/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    // 同时删除所有子分类
    await pool.query('DELETE FROM goods_cate WHERE id=$1 OR parent_id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopUnit
router.get('/goods/ShopUnit/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_unit', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/add', async (req, res) => {
  try {
    const { name, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const r = await pool.query('INSERT INTO goods_unit (name,status) VALUES ($1,$2) RETURNING *', [name, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/edit', async (req, res) => {
  try {
    const { id, name, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE goods_unit SET name=COALESCE($1,name), status=COALESCE($2,status) WHERE id=$3 RETURNING *', [name, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopUnit/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM goods_unit WHERE id=$1', [id])
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
    await listQuery(res, 'goods_brand', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/add', async (req, res) => {
  try {
    const { name, status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const r = await pool.query('INSERT INTO goods_brand (name,status) VALUES ($1,$2) RETURNING *', [name, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/edit', async (req, res) => {
  try {
    const { id, name, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE goods_brand SET name=COALESCE($1,name), status=COALESCE($2,status) WHERE id=$3 RETURNING *', [name, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopBrand/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM goods_brand WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ShopSpec
router.get('/goods/ShopSpec/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'goods_spec', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/add', async (req, res) => {
  try {
    const { name, values = '', status = 1 } = req.body
    if (!name) return fail(res, '名称不能为空')
    const r = await pool.query('INSERT INTO goods_spec (name,values,status) VALUES ($1,$2,$3) RETURNING *', [name, values, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/edit', async (req, res) => {
  try {
    const { id, name, values, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE goods_spec SET name=COALESCE($1,name), values=COALESCE($2,values), status=COALESCE($3,status) WHERE id=$4 RETURNING *', [name, values, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/goods/ShopSpec/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM goods_spec WHERE id=$1', [id])
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
    await listQuery(res, 'sale_customers', { keyword: req.query.keyword, keywordCols: ['name','mobile','code'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.get('/shop/ShopCustomer/detail', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('SELECT * FROM sale_customers WHERE id=$1 AND deleted_at IS NULL', [id])
    if (!r.rows[0]) return fail(res, '客户不存在')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/add', async (req, res) => {
  try {
    const b = req.body
    const filtered = filterBodyCols('sale_customers', b); const cols = Object.keys(filtered).filter(k => filtered[k] !== undefined && filtered[k] !== null && filtered[k] !== '')
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
    const r = await pool.query(`UPDATE sale_customers SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE sale_customers SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ShopCustomer/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    await pool.query(`UPDATE sale_customers SET deleted_at=NOW() WHERE id=ANY($1)`, [idArr])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ContractOrder (销售合同)
router.get('/shop/ContractOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.customer_name) conditions.push(`customer_name ILIKE '%${req.query.customer_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'sale_contracts', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: conditions.join(' AND '), orderBy: 'id DESC', page, list_rows, offset })
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
    const b = filterBodyCols('sale_contracts', { order_no: genOrderNo('XS'), order_sn: genOrderNo('XS'), ...req.body })
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
    const r = await pool.query(`UPDATE sale_contracts SET ${sets.join(',')} WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    // 已审核的合同删除时，同步撤销关联收款单并扣余额（同反审核逻辑）
    const cR = await pool.query('SELECT * FROM sale_contracts WHERE id=$1', [id])
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
    await pool.query('UPDATE sale_contracts SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/ContractOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const isAudit = Number(status ?? 1) === 1

    const contractR = await pool.query('SELECT * FROM sale_contracts WHERE id=$1', [id])
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
          `INSERT INTO collect_receipt (receipt_no, order_sn, contact_type, contact_name, amount, receipt_date, fund_id, fund_name, remark, status, category)
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

    await pool.query('UPDATE sale_contracts SET status=$1 WHERE id=$2', [status ?? 1, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// offerOrder (报价单)
router.get('/shop/offerOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_offers', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_offers', { order_no: genOrderNo('BJ'), ...req.body })
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
    const r = await pool.query(`UPDATE sale_offers SET ${sets.join(',')} WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE sale_offers SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/shop/offerOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE sale_offers SET status=$1 WHERE id=$2', [status ?? 1, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  STOCK
// ═══════════════════════════════════════════════════════════════════════════

// PurchaseOrder
router.get('/stock/PurchaseOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const conditions = ['deleted_at IS NULL']
    if (req.query.status !== undefined && req.query.status !== '') conditions.push(`status=${parseInt(req.query.status)}`)
    if (req.query.supplier_name) conditions.push(`supplier_name ILIKE '%${req.query.supplier_name.replace(/'/g,"''")}%'`)
    await listQuery(res, 'purchase_order', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: conditions.join(' AND '), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('purchase_order', { order_no: genOrderNo('CG'), order_sn: genOrderNo('CG'), ...req.body })
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
    const r = await pool.query(`UPDATE purchase_order SET ${sets.join(',')} WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    // 已审核的单据删除时，同步撤销关联付款单并还余额（同反审核逻辑）
    const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1', [id])
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
    await pool.query('UPDATE purchase_order SET deleted_at=NOW() WHERE id=$1', [id])
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
    const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1', [id])
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
            `INSERT INTO pay_receipt (receipt_no, order_sn, contact_type, contact_name, amount, pay_date, fund_id, fund_name, remark, status, category)
             VALUES ($1,$2,'supplier',$3,$4,$5,$6,$7,$8,1,'purchase')`,
            [receiptNo, orderNo, supplierName, payAmount, orderDate, fundId, fundName, `采购单${orderNo}审核自动生成`]
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

    await pool.query('UPDATE purchase_order SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/PurchaseOrder/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    // 对每条已审核的采购单，撤销关联付款单并还余额
    for (const id of idArr) {
      const poR = await pool.query('SELECT * FROM purchase_order WHERE id=$1', [id])
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
    await pool.query(`UPDATE purchase_order SET deleted_at=NOW() WHERE id=ANY($1)`, [idArr])
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
    await listQuery(res, 'sale_out_order', { keyword: req.query.keyword, keywordCols: ['order_no'], baseWhere: conditions.join(' AND '), orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_out_order', { order_no: genOrderNo('XC'), order_sn: genOrderNo('XC'), ...req.body })
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
    const r = await pool.query(`UPDATE sale_out_order SET ${sets.join(',')} WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE sale_out_order SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleOutOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const r = await pool.query('SELECT * FROM sale_out_order WHERE id=$1', [id])
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

    await pool.query('UPDATE sale_out_order SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { console.error('[SaleOutOrder audit error]', e.message); fail(res, e.message) }
})

// SaleReturnOrder
router.get('/stock/SaleReturnOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_return_order', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/add', async (req, res) => {
  try {
    const b = filterBodyCols('sale_return_order', { order_no: genOrderNo('TH'), ...req.body })
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
    const r = await pool.query(`UPDATE sale_return_order SET ${sets.join(',')} WHERE id=$${vals.length + 1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM sale_return_order WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/SaleReturnOrder/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const r = await pool.query('SELECT * FROM sale_return_order WHERE id=$1', [id])
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

    await pool.query('UPDATE sale_return_order SET status=$1 WHERE id=$2', [newStatus, id])
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
  'remark','status',
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
    const conditions = ['deleted_at IS NULL']
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
    const old = await pool.query('SELECT status FROM sale_samples WHERE id=$1 AND deleted_at IS NULL', [id])
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
    const r = await pool.query(`UPDATE sale_samples SET ${sets}, updated_at=NOW() WHERE id=$${vals.length + 1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

router.post('/shop/SampleOrder/del', async (req, res) => {
  try {
    await ensureSaleSamplesTable()
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('SELECT status FROM sale_samples WHERE id=$1 AND deleted_at IS NULL', [id])
    if (Number(r.rows[0]?.status) === 1) return fail(res, '请先反审核再删除')
    await pool.query('UPDATE sale_samples SET deleted_at=NOW() WHERE id=$1', [id])
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
    const r = await client.query('SELECT * FROM sale_samples WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
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
        `INSERT INTO stock_other_out (order_no, warehouse_id, warehouse_name, goods_info, remark, status)
         VALUES ($1,$2,$3,$4,$5,1) RETURNING *`,
        [sample.sample_no, sample.warehouse_id || 0, sample.warehouse_name || '', JSON.stringify(goodsInfo), `样品出库：${sample.customer_name || sample.contact_name || ''}`,],
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
          `INSERT INTO finance_receivable (customer_id, customer_name, order_sn, total_amount, paid_amount, un_pay_amount, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [sample.customer_id || 0, sample.customer_name || '', sample.sample_no || '', receivableAmount, paidAmount, unpaidAmount, sample.sample_date || null, unpaidAmount > 0 ? 0 : 1],
        )
        receivableId = rec.rows[0].id
      }
      if (paidAmount > 0) {
        const receipt = await client.query(
          `INSERT INTO collect_receipt (receipt_no, order_sn, customer_id, customer_name, amount, receipt_date, pay_type, fund_id, fund_name, remark, status)
           VALUES ($1,$2,$3,$4,$5,$6,'customer',$7,$8,$9,1) RETURNING *`,
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
          `INSERT INTO finance_expenses (expense_no, name, amount, expense_date, fund_id, fund_name, remark, status)
           VALUES ($1,'样品费用',$2,$3,$4,$5,$6,1) RETURNING *`,
          [
            genOrderNo('FY'),
            companyCost,
            sample.sample_date || null,
            expensePaid ? Number(sample.expense_fund_id || 0) : 0,
            expensePaid ? (sample.expense_fund_name || '') : '',
            expenseRemark,
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
    let where = 'WHERE 1=1'
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
    await listQuery(res, 'stock_flow', { keyword: req.query.keyword, keywordCols: ['goods_name','order_no'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
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
    await listQuery(res, 'warehouses', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/add', async (req, res) => {
  try {
    const { name, address = '', remark = '', status = 1 } = req.body
    if (!name) return fail(res, '仓库名称不能为空')
    const r = await pool.query('INSERT INTO warehouses (name,address,remark,status) VALUES ($1,$2,$3,$4) RETURNING *', [name, address, remark, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/edit', async (req, res) => {
  try {
    const { id, name, address, remark, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE warehouses SET name=COALESCE($1,name), address=COALESCE($2,address), remark=COALESCE($3,remark), status=COALESCE($4,status) WHERE id=$5 RETURNING *', [name, address, remark, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/WarehouseName/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM warehouses WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// OtherIn (其他入库)
router.get('/stock/OtherIn/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_other_in', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherIn/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_other_in', { order_no: genOrderNo('RK'), ...req.body })
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
    await pool.query('DELETE FROM stock_other_in WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherIn/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const r = await pool.query('SELECT * FROM stock_other_in WHERE id=$1', [id])
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
    await pool.query('UPDATE stock_other_in SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { console.error('[OtherIn audit error]', e.message); fail(res, e.message) }
})

// OtherOut (其他出库)
router.get('/stock/OtherOut/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_other_out', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_other_out', { order_no: genOrderNo('CK'), ...req.body })
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
    const r = await pool.query('SELECT * FROM stock_other_out WHERE id=$1', [id])
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
    await pool.query('DELETE FROM stock_other_out WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM stock_other_out WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/OtherOut/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1
    const r = await pool.query('SELECT * FROM stock_other_out WHERE id=$1', [id])
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
    await pool.query('UPDATE stock_other_out SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { console.error('[OtherOut audit error]', e.message); fail(res, e.message) }
})

// Allocation (调拨管理)
router.get('/stock/Allocation/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_allocation', { keyword: req.query.keyword, keywordCols: ['transfer_no','from_warehouse','to_warehouse'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_allocation', { transfer_no: genOrderNo('DB'), status: 0, ...req.body })
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
    const b = filterBodyCols('stock_allocation', rest)
    if (b.goods_info && typeof b.goods_info !== 'string') b.goods_info = JSON.stringify(b.goods_info)
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    await pool.query(`UPDATE stock_allocation SET ${cols.map((c,i)=>`${c}=$${i+1}`)} WHERE id=$${cols.length+1}`, [...vals, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    const r = await pool.query('SELECT * FROM stock_allocation WHERE id=$1', [id])
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

    await pool.query('UPDATE stock_allocation SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { console.error('[Allocation audit error]', e.message); fail(res, e.message) }
})
router.post('/stock/Allocation/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM stock_allocation WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/Allocation/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    await pool.query(`DELETE FROM stock_allocation WHERE id=ANY($1)`, [ids])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// StockCheck (盘点)
router.get('/stock/StockCheck/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'stock_checks', { keyword: req.query.keyword, keywordCols: ['order_no','warehouse_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/stock/StockCheck/add', async (req, res) => {
  try {
    const b = filterBodyCols('stock_checks', { order_no: genOrderNo('PD'), ...req.body })
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
    await pool.query('DELETE FROM stock_checks WHERE id=$1', [id])
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
    await listQuery(res, 'supplier', { keyword: req.query.keyword, keywordCols: ['name','mobile'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/supplier/add', async (req, res) => {
  try {
    const b = filterBodyCols('supplier', req.body)
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
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const r = await pool.query(`UPDATE supplier SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/supplier/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE supplier SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ProcurePlan
router.get('/procure/ProcurePlan/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'procure_plan', { keyword: req.query.keyword, keywordCols: ['order_no','admin_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcurePlan/add', async (req, res) => {
  try {
    const b = filterBodyCols('procure_plan', { order_no: genOrderNo('JH'), ...req.body })
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
    await pool.query('UPDATE procure_plan SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcurePlan/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE procure_plan SET status=$1 WHERE id=$2', [status ?? 1, id])
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
    await listQuery(res, 'procure_inhouse', { keyword: req.query.keyword, keywordCols: ['order_no','supplier_name'], baseWhere: `deleted_at IS NULL${extraWhere}`, extraParams, orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/add', async (req, res) => {
  try {
    // 前端传 order_id，表字段是 purchase_order_id，做映射
    const body = { ...req.body }
    if (body.order_id && !body.purchase_order_id) { body.purchase_order_id = body.order_id; delete body.order_id }
    const b = filterBodyCols('procure_inhouse', { order_no: genOrderNo('CGRK'), ...body })
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
    const rest = filterBodyCols('procure_inhouse', rawRest)
    const cols = Object.keys(rest).filter((k) => rest[k] !== undefined)
    if (cols.length === 0) return fail(res, '无有效字段')
    const sets = cols.map((k, i) => `${k}=$${i + 1}`)
    const vals = cols.map((k) => typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : rest[k])
    const sql = `UPDATE procure_inhouse SET ${sets.join(',')} WHERE id=$${vals.length + 1} RETURNING *`
    const result = await pool.query(sql, [...vals, id])
    return ok(res, result.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE procure_inhouse SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureInhouse/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const newStatus = status ?? 1

    // 查入库单
    const inhouseR = await pool.query('SELECT * FROM procure_inhouse WHERE id=$1', [id])
    const inhouse = inhouseR.rows[0]
    if (!inhouse) return fail(res, '入库单不存在')

    const prevStatus = inhouse.status
    // 状态无变化，直接返回
    if (prevStatus === newStatus) { await pool.query('UPDATE procure_inhouse SET status=$1 WHERE id=$2', [newStatus, id]); return ok(res) }

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

    await pool.query('UPDATE procure_inhouse SET status=$1 WHERE id=$2', [newStatus, id])
    return ok(res)
  } catch (e) { console.error('[ProcureInhouse audit error]', e.message); fail(res, e.message) }
})

// ProcureReturn (采购退货)
router.get('/procure/ProcureReturn/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'procure_return', { keyword: req.query.keyword, keywordCols: ['order_no','supplier_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureReturn/add', async (req, res) => {
  try {
    const b = filterBodyCols('procure_return', { order_no: genOrderNo('CGTH'), ...req.body })
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
    // 已审核的退货单删除时，撤销库存和资金变动
    const retR = await pool.query('SELECT * FROM procure_return WHERE id=$1', [id])
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
    await pool.query('DELETE FROM procure_return WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/procure/ProcureReturn/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')

    const retR = await pool.query('SELECT * FROM procure_return WHERE id=$1', [id])
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

    await pool.query('UPDATE procure_return SET status=$1 WHERE id=$2', [status ?? 1, id])
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
    await listQuery(res, 'finance_receivable', { keyword: req.query.keyword, keywordCols: ['customer_name','order_sn'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// PayAccounts (应付账款)
router.get('/finance/PayAccounts/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_payable', { keyword: req.query.keyword, keywordCols: ['supplier_name','order_sn'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// CollectReceipt (收款单)
router.post('/finance/CollectReceipt/edit', async (req, res) => {
  try {
    const { id, ...fields } = req.body
    if (!id) return fail(res, 'id不能为空')
    const cols = Object.keys(fields)
    if (!cols.length) return fail(res, '无更新字段')
    const sets = cols.map((k, i) => `${k}=$${i + 2}`).join(',')
    const vals = [id, ...cols.map(k => fields[k])]
    const r = await pool.query(`UPDATE collect_receipt SET ${sets} WHERE id=$1 RETURNING *`, vals)
    ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.get('/finance/CollectReceipt/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'collect_receipt', { keyword: req.query.keyword, keywordCols: ['receipt_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/CollectReceipt/add', async (req, res) => {
  try {
    const b = filterBodyCols('collect_receipt', { receipt_no: genOrderNo('SK'), ...req.body })
    // 防重复：同一客户+同一金额+同一销售单已存在则拒绝
    const custName = b.customer_name || b.contact_name || ''
    const receiptDate = b.receipt_date ? String(b.receipt_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
    const amount = Number(b.amount || 0)
    const orderSn = b.order_sn || ''
    if (custName && amount > 0 && orderSn) {
      const dupCheck = await pool.query(
        `SELECT id, receipt_no FROM collect_receipt WHERE contact_name=$1 AND amount=$2 AND order_sn=$3 AND deleted_at IS NULL LIMIT 1`,
        [custName, amount, orderSn]
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
    const r = await pool.query('SELECT fund_id, amount FROM collect_receipt WHERE id=$1', [id])
    await pool.query('UPDATE collect_receipt SET deleted_at=NOW() WHERE id=$1', [id])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance-$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// PayReceipt (付款单)
router.get('/finance/PayReceipt/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'pay_receipt', { keyword: req.query.keyword, keywordCols: ['receipt_no','contact_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/PayReceipt/add', async (req, res) => {
  try {
    const b = filterBodyCols('pay_receipt', { receipt_no: genOrderNo('FK'), ...req.body })
    // 防重复：同一供应商+同一金额+同一天+同一采购单已存在则拒绝
    const supName = b.supplier_name || b.contact_name || ''
    const payDate = b.pay_date ? String(b.pay_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
    const amount = Number(b.amount || 0)
    const orderSn = b.order_sn || ''
    if (supName && amount > 0 && orderSn) {
      const dupCheck = await pool.query(
        `SELECT id, receipt_no FROM pay_receipt WHERE contact_name=$1 AND amount=$2 AND order_sn=$3 AND deleted_at IS NULL LIMIT 1`,
        [supName, amount, orderSn]
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
router.post('/finance/PayReceipt/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('SELECT fund_id, amount FROM pay_receipt WHERE id=$1', [id])
    await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1', [id])
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
    await listQuery(res, 'finance_invoices', { keyword: req.query.keyword, keywordCols: ['invoice_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Invoice/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_invoices', { invoice_no: genOrderNo('FP'), ...req.body })
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
    await pool.query('UPDATE finance_invoices SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Statement (对账单)
router.get('/finance/Statement/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_statements', { keyword: req.query.keyword, keywordCols: ['statement_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Statement/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_statements', { statement_no: genOrderNo('DZ'), ...req.body })
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
    await pool.query('UPDATE finance_statements SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Expense (费用)
router.get('/finance/Expense/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_expenses', { keyword: req.query.keyword, keywordCols: ['expense_no','name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Expense/add', async (req, res) => {
  try {
    const ALLOWED = new Set(['expense_no','name','amount','expense_date','fund_id','fund_name','remark','status','contact_name','pay_date'])
    const b = { expense_no: genOrderNo('FY'), ...req.body }
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
    // 还余额
    const r = await pool.query('SELECT fund_id, amount FROM finance_expenses WHERE id=$1', [id])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    await pool.query('DELETE FROM finance_expenses WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Fund (资金账户)
router.get('/finance/Fund/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_funds', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id ASC', page, list_rows, offset })
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
    const b = normalizeFundBody({ ...req.body })
    if (!b.name) return fail(res, '账户名称不能为空')
    const cols = Object.keys(b).filter(k => FUND_ALLOWED_COLS.has(k) && b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO finance_funds (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Fund/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    if (!id) return fail(res, 'id不能为空')
    const b = normalizeFundBody({ ...rest })
    const cols = Object.keys(b).filter(k => FUND_ALLOWED_COLS.has(k) && b[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`UPDATE finance_funds SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Fund/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE finance_funds SET deleted_at=NOW() WHERE id=$1', [id])
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
    const unionSql = `
      SELECT id, receipt_no AS flow_no, 'collect' AS flow_type, contact_name, amount, receipt_date AS flow_date, fund_name, remark, created_at
      FROM (
        SELECT id, receipt_no, customer_name AS contact_name, amount, receipt_date, fund_name, remark, created_at
        FROM collect_receipt WHERE deleted_at IS NULL
        UNION ALL
        SELECT id, receipt_no, contact_name, amount, pay_date AS receipt_date, fund_name, remark, created_at
        FROM pay_receipt WHERE deleted_at IS NULL
      ) t
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `
    const countSql = `SELECT COUNT(*) FROM (
      SELECT id FROM collect_receipt WHERE deleted_at IS NULL
      UNION ALL
      SELECT id FROM pay_receipt WHERE deleted_at IS NULL
    ) t`
    const [countR, rowsR] = await Promise.all([pool.query(countSql), pool.query(unionSql, [...params, list_rows, offset])])
    return ok(res, { rows: rowsR.rows, total: parseInt(countR.rows[0].count), page, list_rows })
  } catch (e) { fail(res, e.message) }
})

// Cost (成本)
router.get('/finance/Cost/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'finance_costs', { keyword: req.query.keyword, keywordCols: ['cost_no','name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Cost/add', async (req, res) => {
  try {
    const b = filterBodyCols('finance_costs', { cost_no: genOrderNo('CB'), ...req.body })
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
    await pool.query('DELETE FROM finance_costs WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// Prepay (预付款)
router.get('/finance/Prepay/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'prepay_record', { keyword: req.query.keyword, keywordCols: ['order_sn','customer_name','supplier_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Prepay/create', async (req, res) => {
  try {
    const b = filterBodyCols('prepay_record', { order_sn: genOrderNo('YF'), ...req.body })
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
    // 还余额
    const r = await pool.query('SELECT fund_id, amount FROM prepay_record WHERE id=$1', [id])
    if (r.rows[0]?.fund_id && Number(r.rows[0]?.amount)) {
      await pool.query('UPDATE finance_funds SET balance=balance+$1, update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
    }
    await pool.query('DELETE FROM prepay_record WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ═══════════════════════════════════════════════════════════════════════════
//  RETAIL
// ═══════════════════════════════════════════════════════════════════════════

// retail/order
router.get('/retail/order/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_orders', { keyword: req.query.keyword, keywordCols: ['order_sn','member_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/add', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0`)
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS store_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS store_name VARCHAR(100) DEFAULT ''`)
    await loadTableCols()
    const b = filterBodyCols('retail_orders', { order_sn: genOrderNo('LS'), ...req.body })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO retail_orders (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/edit', async (req, res) => {
  try {
    const { id, goods_info, order_date, member_id, member_name, store_id, store_name, pay_type, remark, total_amount, discount_amount, pay_amount } = req.body
    if (!id) return fail(res, '缺少零售单 ID')
    if (!goods_info) return fail(res, '缺少 goods_info')
    const row = await pool.query('SELECT status FROM retail_orders WHERE id=$1', [id])
    if (!row.rows.length) return fail(res, '订单不存在')
    if (Number(row.rows[0].status) === 1) return fail(res, '已审核订单不可编辑，请先反审核')
    const goodsStr = typeof goods_info === 'string' ? goods_info : JSON.stringify(goods_info)
    await pool.query(
      `UPDATE retail_orders SET goods_info=$1, total_amount=$2, discount_amount=$3, pay_amount=$4,
       order_date=$5, member_id=$6, member_name=$7, store_id=$8, store_name=$9, pay_type=$10, remark=$11
       WHERE id=$12`,
      [goodsStr, total_amount??0, discount_amount??0, pay_amount??0,
       order_date||null, member_id||0, member_name||'', store_id||0, store_name||'', pay_type||'cash', remark||'', id]
    )
    const r = await pool.query('SELECT * FROM retail_orders WHERE id=$1', [id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/audit', async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const s = parseInt(status)
    if (s !== 0 && s !== 1) return fail(res, 'status必须是0或1')
    await pool.query('UPDATE retail_orders SET status=$1 WHERE id=$2', [s, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM retail_orders WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/order/batchDel', async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !ids.length) return fail(res, 'ids不能为空')
    const idArr = Array.isArray(ids) ? ids : ids.split(',').map(Number)
    await pool.query(`DELETE FROM retail_orders WHERE id=ANY($1)`, [idArr])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// retail/member
router.get('/retail/member/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_members', { keyword: req.query.keyword, keywordCols: ['name','mobile'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/member/add', async (req, res) => {
  try {
    const b = filterBodyCols('retail_members', req.body)
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
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    const r = await pool.query(`UPDATE retail_members SET ${sets.join(',')} WHERE id=$${vals.length+1} RETURNING *`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/member/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM retail_members WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// retail/recharge
router.get('/retail/recharge/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'retail_recharge', { keyword: req.query.keyword, keywordCols: ['recharge_no','member_name'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/recharge/add', async (req, res) => {
  try {
    const b = filterBodyCols('retail_recharge', { recharge_no: genOrderNo('CZ'), ...req.body })
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
    await pool.query('DELETE FROM retail_recharge WHERE id=$1', [id])
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
      await listQuery(res, 'retail_stores', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
    } catch {
      return ok(res, { rows: [], total: 0, page: 1, list_rows: 20 })
    }
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/add', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS retail_stores (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, address TEXT DEFAULT '', tel VARCHAR(20) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW())`)
    const b = req.body
    if (!b.name) return fail(res, '门店名称不能为空')
    const r = await pool.query('INSERT INTO retail_stores (name,address,tel,remark,status) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.name, b.address||'', b.tel||'', b.remark||'', b.status||1])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/edit', async (req, res) => {
  try {
    const { id, name, address, tel, remark, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE retail_stores SET name=COALESCE($1,name), address=COALESCE($2,address), tel=COALESCE($3,tel), remark=COALESCE($4,remark), status=COALESCE($5,status) WHERE id=$6 RETURNING *', [name, address, tel, remark, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/retail/store/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM retail_stores WHERE id=$1', [id])
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
    await listQuery(res, 'admins', { keyword: req.query.keyword, keywordCols: ['name','account','mobile'], baseWhere: 'deleted_at IS NULL', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/admin/add', async (req, res) => {
  try {
    const b = req.body
    if (!b.account) return fail(res, '账号不能为空')
    if (!b.password) return fail(res, '密码不能为空')
    const hashedPwd = await bcrypt.hash(b.password, 10)
    const data = { ...b, password: hashedPwd }
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
    const data = { ...rest }
    if (password) data.password = await bcrypt.hash(password, 10)
    const cols = Object.keys(data).filter(k => data[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => data[k])
    const r = await pool.query(`UPDATE admins SET ${sets.join(',')}, update_time=NOW() WHERE id=$${vals.length+1} RETURNING id, name, account, role_name, status`, [...vals, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/admin/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('UPDATE admins SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/dept
router.get('/setting/dept/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'depts', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'sort ASC, id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/add', async (req, res) => {
  try {
    const { name, parent_id = 0, sort = 0, status = 1 } = req.body
    if (!name) return fail(res, '部门名称不能为空')
    const r = await pool.query('INSERT INTO depts (name,parent_id,sort,status) VALUES ($1,$2,$3,$4) RETURNING *', [name, parent_id, sort, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/edit', async (req, res) => {
  try {
    const { id, name, parent_id, sort, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE depts SET name=COALESCE($1,name), parent_id=COALESCE($2,parent_id), sort=COALESCE($3,sort), status=COALESCE($4,status) WHERE id=$5 RETURNING *', [name, parent_id, sort, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/dept/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM depts WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/role
router.get('/setting/role/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'roles', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/add', async (req, res) => {
  try {
    const { name, permissions = '', status = 1 } = req.body
    if (!name) return fail(res, '角色名称不能为空')
    const r = await pool.query('INSERT INTO roles (name,permissions,status) VALUES ($1,$2,$3) RETURNING *', [name, permissions, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/edit', async (req, res) => {
  try {
    const { id, name, permissions, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE roles SET name=COALESCE($1,name), permissions=COALESCE($2,permissions), status=COALESCE($3,status) WHERE id=$4 RETURNING *', [name, permissions, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/role/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM roles WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/jobs
router.get('/setting/jobs/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'jobs', { keyword: req.query.keyword, keywordCols: ['name'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/add', async (req, res) => {
  try {
    const { name, dept_id = 0, status = 1 } = req.body
    if (!name) return fail(res, '职位名称不能为空')
    const r = await pool.query('INSERT INTO jobs (name,dept_id,status) VALUES ($1,$2,$3) RETURNING *', [name, dept_id, status])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/edit', async (req, res) => {
  try {
    const { id, name, dept_id, status } = req.body
    if (!id) return fail(res, 'id不能为空')
    const r = await pool.query('UPDATE jobs SET name=COALESCE($1,name), dept_id=COALESCE($2,dept_id), status=COALESCE($3,status) WHERE id=$4 RETURNING *', [name, dept_id, status, id])
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/jobs/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM jobs WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// setting/company
router.get('/setting/company/detail', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM company_info LIMIT 1')
    if (!r.rows[0]) {
      await pool.query("INSERT INTO company_info (name) VALUES ('我的公司')")
      const r2 = await pool.query('SELECT * FROM company_info LIMIT 1')
      return ok(res, r2.rows[0])
    }
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/company/edit', async (req, res) => {
  try {
    const { id, ...rest } = req.body
    const cols = Object.keys(rest).filter(k => rest[k] !== undefined)
    if (!cols.length) return fail(res, '无有效字段')
    const sets = cols.map((k,i) => `${k}=$${i+1}`)
    const vals = cols.map(k => rest[k])
    if (id) {
      await pool.query(`UPDATE company_info SET ${sets.join(',')} WHERE id=$${vals.length+1}`, [...vals, id])
    } else {
      // upsert on first record
      const existing = await pool.query('SELECT id FROM company_info LIMIT 1')
      if (existing.rows[0]) {
        await pool.query(`UPDATE company_info SET ${sets.join(',')} WHERE id=$${vals.length+1}`, [...vals, existing.rows[0].id])
      } else {
        await pool.query(`INSERT INTO company_info (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)})`, vals)
      }
    }
    const r = await pool.query('SELECT * FROM company_info LIMIT 1')
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})

// setting/operationLog
router.get('/setting/operationLog/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'operation_logs', { keyword: req.query.keyword, keywordCols: ['admin_name','action'], baseWhere: '1=1', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})

// setting/params
router.get('/setting/params/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sys_params', { keyword: req.query.keyword, keywordCols: ['key','value'], baseWhere: '1=1', orderBy: 'id ASC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/setting/params/edit', async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key) return fail(res, 'key不能为空')
    await pool.query('INSERT INTO sys_params (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value])
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
    ADD COLUMN IF NOT EXISTS level_id INT DEFAULT 0`)
}

async function start() {
  // Listen first so Render health check passes immediately (Neon cold start can take 30+ sec)
  app.listen(PORT, () => {
    console.log(`ERP server running on port ${PORT}`)
  })
  try {
    await initDb()
    await migrateSaleReturnOrder()
    await loadTableCols()
    console.log('Database ready')
  } catch (e) {
    console.error('DB init failed (server still running):', e)
  }
}

// ─── BOM 物料清单 ───────────────────────────────────────────────────────────
router.get('/goods/BomGoods/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    const keyword = req.query.keyword || ''
    const where = keyword
      ? `deleted_at IS NULL AND (goods_name ILIKE $1 OR goods_sn ILIKE $1 OR bom_code ILIKE $1)`
      : `deleted_at IS NULL`
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
    const bom = await pool.query('SELECT * FROM bom_order WHERE id=$1 AND deleted_at IS NULL', [id])
    if (!bom.rows.length) return fail(res, 'BOM不存在')
    const items = await pool.query('SELECT * FROM bom_items WHERE bom_id=$1 ORDER BY id ASC', [id])
    return ok(res, { ...bom.rows[0], items: items.rows })
  } catch (e) { fail(res, e.message) }
})

router.post('/goods/BomGoods/add', async (req, res) => {
  try {
    const { goods_name, goods_sn, spec, unit_name, remark, items = [] } = req.body
    if (!goods_name) return fail(res, '商品名称不能为空')
    const countR = await pool.query('SELECT COUNT(*) FROM bom_order WHERE deleted_at IS NULL')
    const sn = parseInt(countR.rows[0].count) + 1
    const bomCode = 'BOM' + String(sn).padStart(6, '0')
    const r = await pool.query(
      `INSERT INTO bom_order (bom_code, goods_name, goods_sn, spec, unit_name, remark)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bomCode, goods_name, goods_sn || '', spec || '', unit_name || '', remark || '']
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
    await pool.query(
      `UPDATE bom_order SET goods_name=$1, goods_sn=$2, spec=$3, unit_name=$4, remark=$5, update_time=NOW() WHERE id=$6`,
      [goods_name || '', goods_sn || '', spec || '', unit_name || '', remark || '', id]
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
    await pool.query('UPDATE bom_order SET deleted_at=NOW() WHERE id=$1', [id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// ─── 小程序 miniapi ───────────────────────────────────────────────────────────

const MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'mini_secret_2024'
const WX_SECRET = process.env.WX_SECRET || ''
const WX_MCH_ID = process.env.WX_MCH_ID || ''
const WX_MCH_KEY = process.env.WX_MCH_KEY || ''

// 微信支付V2签名
function wxPaySign(params) {
  const crypto = require('crypto')
  const str = Object.keys(params).filter(k => params[k] !== '' && params[k] !== undefined).sort()
    .map(k => `${k}=${params[k]}`).join('&') + `&key=${WX_MCH_KEY}`
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase()
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
    skuVariants: brand.skuVariants || null,
    rating: brand.rating || 5.0,
    wholesalePrice: brand.wholesalePrice || 0,
    minOrderQuantity: brand.minOrderQuantity || 1,
    sort: row.sort || 0,
    baseSales: brand.baseSales || 0,
  }
}

// 商品列表 — 只返回品牌主页标记 show:true 的商品（与 shopStore.ts 逻辑一致）
app.get('/miniapi/goods/list', async (req, res) => {
  try {
    const { page = 1, list_rows = 10, category_id, keyword } = req.query
    const pageNum = parseInt(page), pageSize = parseInt(list_rows)
    const params = []
    let where = `WHERE deleted_at IS NULL AND status=1 AND can_sale=1`
    if (category_id) { params.push(category_id); where += ` AND cate_id=$${params.length}` }
    if (keyword) { params.push(`%${keyword}%`); where += ` AND goods_name ILIKE $${params.length}` }
    // 拉全量（≤500），在 Node 里过滤 show:true，与品牌主页 .filter(p=>p.show===true) 一致
    const rows = (await pool.query(
      `SELECT id, goods_name, images, remark, sell_price, unit_name, spec, barcode, goods_memo, sort FROM goods ${where} ORDER BY sort ASC, id DESC LIMIT 500`,
      params
    )).rows
    const brandRows = rows.filter(g => {
      try { return JSON.parse(g.remark || '{}')['__brand__']?.show === true } catch { return false }
    })
    const total = brandRows.length
    const pageSlice = brandRows.slice((pageNum - 1) * pageSize, pageNum * pageSize)
    // 批量查销量
    const goodsIds = pageSlice.map(g => g.id)
    let salesMap = {}
    let reviewMap = {}
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
    }
    const pageData = pageSlice.map(g => {
      const item = parseBrandGoods(g)
      item.sales_count = (salesMap[g.id] || 0) + item.baseSales
      item.avg_rating = reviewMap[g.id]?.avg || 0
      item.review_count = reviewMap[g.id]?.cnt || 0
      return item
    })
    return ok(res, { rows: pageData, total, page: pageNum, list_rows: pageSize })
  } catch (e) { fail(res, e.message) }
})

// 商品详情
app.get('/miniapi/goods/detail/:id', async (req, res) => {
  try {
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
    return ok(res, goods)
  } catch (e) { fail(res, e.message) }
})

// 创建订单
app.post('/miniapi/order/create', miniAuth, async (req, res) => {
  try {
    const { items, address, remark } = req.body
    if (!items || items.length === 0) return fail(res, '订单不能为空')

    // 服务端重新计算总价，不信任客户端传值
    const goodsIds = items.map(i => i.goods_id).filter(Boolean)
    if (goodsIds.length === 0) return fail(res, '商品信息有误')
    const goodsRows = (await pool.query(
      `SELECT id, goods_name as name, sell_price as price FROM goods WHERE id = ANY($1) AND status=1 AND can_sale=1`,
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
      validItems.push({ goods_id: g.id, goods_name: g.name, spec: item.spec || '', price, qty })
    }
    originalTotal = Math.round(originalTotal * 100) / 100

    // 会员折扣
    const userRow = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [req.miniUser.id])).rows[0]
    const userLevel = calcLevel(userRow || {})
    const levelInfo = MEMBER_LEVELS[userLevel]
    const discount = levelInfo.discount

    // 积分抵扣
    const usePoints = Math.min(parseInt(req.body.use_points || 0), userRow?.points || 0)
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

    let serverTotal = Math.max(0, Math.round((originalTotal * discount - pointsDeduct - couponDeduct) * 100) / 100)

    const orderNo = genOrderNo('MP')
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS coupon_id INT DEFAULT 0`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS coupon_deduct NUMERIC(8,2) DEFAULT 0`)
    const r = await pool.query(
      `INSERT INTO mini_orders (order_no, user_id, total_amount, original_amount, discount, points_used, coupon_id, coupon_deduct, address, remark, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,NOW()) RETURNING *`,
      [orderNo, req.miniUser.id, serverTotal, originalTotal, discount, usePoints, userCouponId || 0, couponDeduct, JSON.stringify(address || {}), remark || '']
    )
    const order = r.rows[0]
    for (const item of validItems) {
      await pool.query(
        `INSERT INTO mini_order_items (order_id, goods_id, goods_name, spec, price, qty) VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, item.goods_id, item.goods_name, item.spec, item.price, item.qty]
      )
    }
    // 扣积分
    if (usePoints > 0) {
      await pool.query(`UPDATE mini_users SET points=points-$1 WHERE id=$2`, [usePoints, req.miniUser.id])
      await pool.query(`INSERT INTO mini_points_log (user_id,points,type,remark,order_id,created_at) VALUES ($1,$2,'use','积分抵扣',$3,NOW())`, [req.miniUser.id, -usePoints, order.id])
    }
    // 核销优惠券
    if (usedCoupon) {
      await pool.query(`UPDATE mini_user_coupons SET status=1, used_at=NOW(), order_id=$1 WHERE id=$2`, [order.id, userCouponId])
    }

    // 订阅消息：购买成功通知（异步，不阻塞响应）
    const openid = userRow?.openid
    if (openid && TMPL_ORDER_SUCCESS) {
      const goodsName = validItems.map(i => i.goods_name).join('、').slice(0, 20)
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      sendSubscribeMsg(openid, TMPL_ORDER_SUCCESS, `pages/order/detail?id=${order.id}`, {
        thing1: { value: goodsName },           // 商品名称
        amount1: { value: `¥${serverTotal.toFixed(2)}` }, // 订单总价
        character_string1: { value: order.order_no },     // 交易单号
        time1: { value: now.slice(0, 16) },               // 下单时间
      }).catch(() => {})
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
    order.address = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {})
    return ok(res, order)
  } catch (e) { fail(res, e.message) }
})

// ─── 小程序订单管理（ERP后台用，使用adminapi auth）─────────────────────────────

// 建表时补字段（运行时幂等）
;(async () => {
  try {
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS express_company VARCHAR(50) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS tracking_no VARCHAR(100) DEFAULT ''`)
    await pool.query(`ALTER TABLE mini_orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP`)
    // status: 0=待支付 1=待发货 2=已发货 3=已完成 4=已取消
  } catch(e) { console.log('mini_orders alter:', e.message) }
})()

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
    if (!tracking_no) return fail(res, '请填写快递单号')
    const r = await pool.query(
      `UPDATE mini_orders SET status=2, express_company=$1, tracking_no=$2, shipped_at=NOW() WHERE id=$3 AND status=1 RETURNING *`,
      [express_company || '', tracking_no, order_id]
    )
    if (!r.rows[0]) return fail(res, '订单不存在或状态不是待发货')
    return ok(res, r.rows[0])
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

    const https = require('https')
    const nonceStr = Math.random().toString(36).slice(2, 18) + Math.random().toString(36).slice(2, 18)
    const totalFee = Math.round(parseFloat(order.total_amount || order.total || 0) * 100) // 转分
    const notifyUrl = 'https://erp-server-xsji.onrender.com/miniapi/pay/notify'

    const params = {
      appid: WX_APPID,
      mch_id: WX_MCH_ID,
      nonce_str: nonceStr,
      body: '数字游牧ERP-商品购买',
      out_trade_no: order.order_no,
      total_fee: String(totalFee),
      spbill_create_ip: req.ip || '127.0.0.1',
      notify_url: notifyUrl,
      trade_type: 'JSAPI',
      openid: req.miniUser.openid,
    }
    params.sign = wxPaySign(params)

    const xmlBody = toXml(params)
    const wxRes = await new Promise((resolve, reject) => {
      const req2 = https.request({ hostname: 'api.mch.weixin.qq.com', path: '/pay/unifiedorder', method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xmlBody) } }, r2 => {
        let d = ''
        r2.on('data', c => d += c)
        r2.on('end', () => resolve(fromXml(d)))
      })
      req2.on('error', reject)
      req2.write(xmlBody)
      req2.end()
    })

    if (wxRes.return_code !== 'SUCCESS' || wxRes.result_code !== 'SUCCESS') {
      return fail(res, wxRes.err_code_des || wxRes.return_msg || '微信支付下单失败')
    }

    const prepayId = wxRes.prepay_id
    const timeStamp = String(Math.floor(Date.now() / 1000))
    const nonceStr2 = Math.random().toString(36).slice(2, 18)
    const packageStr = `prepay_id=${prepayId}`
    const paySign = wxPaySign({ appId: WX_APPID, timeStamp, nonceStr: nonceStr2, package: packageStr, signType: 'MD5' })

    return ok(res, { timeStamp, nonceStr: nonceStr2, package: packageStr, signType: 'MD5', paySign })
  } catch (e) { fail(res, e.message) }
})

// 支付回调
app.post('/miniapi/pay/notify', async (req, res) => {
  try {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = fromXml(body)
        if (data.return_code === 'SUCCESS' && data.result_code === 'SUCCESS') {
          // 验签
          const sign = data.sign
          const { sign: _, ...rest } = data
          if (wxPaySign(rest) === sign) {
            const updOrder = (await pool.query(`UPDATE mini_orders SET status=1, paid_at=NOW() WHERE order_no=$1 AND status=0 RETURNING *`, [data.out_trade_no])).rows[0]
            if (updOrder) {
              const paidUser = (await pool.query(`SELECT * FROM mini_users WHERE id=$1`, [updOrder.user_id])).rows[0]
              if (paidUser) {
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
          }
        }
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>')
      } catch { res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>') }
    })
  } catch {
    res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>')
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

function calcLevel(user) {
  const now = new Date()
  if (user.vip_expire_at && new Date(user.vip_expire_at) > now) return 3
  const spent = parseFloat(user.total_spent || 0)
  if (spent >= 2000) return 2
  if (spent >= 500) return 1
  return 0
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
    const https = require('https')
    const orderNo = genOrderNo('VIP')
    const nonceStr = Math.random().toString(36).slice(2, 18) + Math.random().toString(36).slice(2, 18)
    const totalFee = VIP_PRICE * 100
    const params = {
      appid: WX_APPID,
      mch_id: WX_MCH_ID,
      nonce_str: nonceStr,
      body: '数字游牧-VIP年度会员',
      out_trade_no: orderNo,
      total_fee: String(totalFee),
      spbill_create_ip: req.ip || '127.0.0.1',
      notify_url: 'https://erp-server-xsji.onrender.com/miniapi/pay/vip-notify',
      trade_type: 'JSAPI',
      openid: req.miniUser.openid,
      attach: String(req.miniUser.id),
    }
    params.sign = wxPaySign(params)
    const xmlBody = toXml(params)
    const wxRes = await new Promise((resolve, reject) => {
      const req2 = https.request({ hostname: 'api.mch.weixin.qq.com', path: '/pay/unifiedorder', method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xmlBody) } }, r2 => {
        let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(fromXml(d)))
      })
      req2.on('error', reject); req2.write(xmlBody); req2.end()
    })
    if (wxRes.return_code !== 'SUCCESS' || wxRes.result_code !== 'SUCCESS')
      return fail(res, wxRes.err_code_des || wxRes.return_msg || 'VIP支付下单失败')
    const prepayId = wxRes.prepay_id
    const timeStamp = String(Math.floor(Date.now() / 1000))
    const nonceStr2 = Math.random().toString(36).slice(2, 18)
    const packageStr = `prepay_id=${prepayId}`
    const paySign = wxPaySign({ appId: WX_APPID, timeStamp, nonceStr: nonceStr2, package: packageStr, signType: 'MD5' })
    return ok(res, { timeStamp, nonceStr: nonceStr2, package: packageStr, signType: 'MD5', paySign, orderNo })
  } catch (e) { fail(res, e.message) }
})

// VIP支付回调
app.post('/miniapi/pay/vip-notify', async (req, res) => {
  try {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = fromXml(body)
        if (data.return_code === 'SUCCESS' && data.result_code === 'SUCCESS') {
          const { sign: _, ...rest } = data
          if (wxPaySign(rest) === data.sign) {
            const userId = parseInt(data.attach)
            const expireAt = new Date(Date.now() + 365 * 24 * 3600 * 1000)
            await pool.query(`UPDATE mini_users SET vip_expire_at=$1, level=3 WHERE id=$2`, [expireAt, userId])
            await pool.query(`INSERT INTO mini_points_log (user_id, points, type, remark, created_at) VALUES ($1,990,'earn','购买VIP会员赠送积分',NOW())`, [userId])
            await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+990 WHERE id=$1`, [userId])
          }
        }
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>')
      } catch { res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>') }
    })
  } catch { res.send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>') }
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

    const brandContext = `你是 NOMADIC DAIRY（游牧乳业）的专属客服 Nova，熟悉所有产品详情，语气亲切自然。

【品牌】NOMADIC DAIRY — 内蒙古锡林郭勒盟草原奶食品牌。纯天然无添加，传统蒙古族工艺，鲜奶直供，可溯源到牧场。

【在售商品】
${productLines || '奶皮、奶豆腐、青砖奶茶、冻炒米、奶果子、蒙古黄油'}

【物流】顺丰冷链1-3日、京东次日达，满199包邮。
【售后】7天无忧退换，破损必赔。
【批发】起订量各品类不同，请联系客服报价。

回答时如果用户问具体产品的价格或规格，从上方商品列表里准确引用，不要编造数字。`

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
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(order_id, goods_id)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mini_reviews_goods ON mini_reviews(goods_id)`)

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
      `SELECT r.id, r.rating, r.content, r.created_at,
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
    await pool.query(
      `INSERT INTO mini_reviews (goods_id, user_id, order_id, rating, content) VALUES ($1,$2,$3,$4,$5)`,
      [goods_id, req.miniUser.id, order_id, rating, content || '']
    )
    // 评价完成赠10积分
    await pool.query(`UPDATE mini_users SET points=COALESCE(points,0)+10 WHERE id=$1`, [req.miniUser.id])
    return ok(res, { message: '评价成功，赠送10积分' })
  } catch(e) { fail(res, e.message) }
})

// 检查某订单某商品是否已评价
app.get('/miniapi/review/check', miniAuth, async (req, res) => {
  try {
    const { order_id, goods_id } = req.query
    const r = (await pool.query(`SELECT id FROM mini_reviews WHERE order_id=$1 AND goods_id=$2 LIMIT 1`, [order_id, goods_id])).rows[0]
    return ok(res, { reviewed: !!r })
  } catch(e) { fail(res, e.message) }
})

app.post('/miniapi/wholesale/inquiry', async (req, res) => {
  try {
    const { name, wechat, mobile } = req.body
    if (!name || (!wechat && !mobile)) return fail(res, '请填写姓名及微信号或手机号')

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
    // 补生日字段
    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS birth_month SMALLINT`)
    await pool.query(`ALTER TABLE mini_users ADD COLUMN IF NOT EXISTS birth_day SMALLINT`)
    // 预置默认券：新客6元券 + 生日8元券
    await pool.query(`
      INSERT INTO mini_coupons (name, type, discount_value, min_order, validity_days, total_count)
      VALUES ('新客专享券', 'new_user', 6, 0, 30, -1),
             ('生日特权券', 'birthday', 15, 50, 7, -1)
      ON CONFLICT DO NOTHING
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
        const orderCount = parseInt((await pool.query(
          `SELECT COUNT(*) FROM mini_orders WHERE user_id=$1 AND status>=1`, [uid]
        )).rows[0].count)
        if (orderCount > 0) { canClaim = false; reason = '仅限新客' }
        if (claimedByUser > 0) { canClaim = false; reason = '已领取' }
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
      const orderCount = parseInt((await pool.query(
        `SELECT COUNT(*) FROM mini_orders WHERE user_id=$1 AND status>=1`, [uid]
      )).rows[0].count)
      if (orderCount > 0) return fail(res, '仅限新用户领取')
      const already = (await pool.query(`SELECT id FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2 LIMIT 1`, [uid, coupon_id])).rows[0]
      if (already) return fail(res, '您已领取过该券')
    } else if (c.type === 'birthday') {
      if (!user?.birth_month) return fail(res, '请先在个人中心设置生日')
      if (user.birth_month !== now.getMonth() + 1) return fail(res, `生日月（${user.birth_month}月）才能领取`)
      const thisYear = parseInt((await pool.query(
        `SELECT COUNT(*) FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2 AND EXTRACT(YEAR FROM claimed_at)=$3`,
        [uid, coupon_id, now.getFullYear()]
      )).rows[0].count)
      if (thisYear > 0) return fail(res, '今年已领取过生日券')
    } else {
      const already = (await pool.query(`SELECT id FROM mini_user_coupons WHERE user_id=$1 AND coupon_id=$2 LIMIT 1`, [uid, coupon_id])).rows[0]
      if (already) return fail(res, '您已领取过该券')
    }

    const expireAt = new Date(Date.now() + c.validity_days * 86400000)
    await pool.query(
      `INSERT INTO mini_user_coupons (user_id, coupon_id, status, expire_at) VALUES ($1,$2,0,$3)`,
      [uid, coupon_id, expireAt]
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
    console.log('mini_videos tables ready')
  } catch(e) { console.log('mini_videos init:', e.message) }
})()

// 视频列表（分页，支持滑动加载）
app.get('/miniapi/video/list', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = 5
    const offset = (page - 1) * limit
    const uid = req.miniUser?.id || 0

    const rows = (await pool.query(
      `SELECT v.*, g.goods_name, g.sell_price AS sale_price, g.images AS header_images
       FROM mini_videos v
       LEFT JOIN goods g ON g.id=v.goods_id
       WHERE v.status=1
       ORDER BY v.sort DESC, v.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
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
      header_images: r.header_images ? (typeof r.header_images === 'string' ? JSON.parse(r.header_images) : r.header_images) : [],
    }))
    return ok(res, { list, has_more: rows.length === limit })
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
      display_name: r.name || (r.phone ? r.phone.slice(0,3)+'****'+r.phone.slice(-2) : '用户'),
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
    const { id, title, description, video_url, cover_url, goods_id, sort = 0, status = 1 } = req.body
    if (!title || !video_url) return fail(res, '标题和视频URL必填')
    if (id) {
      const r = await pool.query(
        `UPDATE mini_videos SET title=$1,description=$2,video_url=$3,cover_url=$4,goods_id=$5,sort=$6,status=$7 WHERE id=$8 RETURNING *`,
        [title, description, video_url, cover_url, goods_id || 0, sort, status, id]
      )
      return ok(res, r.rows[0])
    } else {
      const r = await pool.query(
        `INSERT INTO mini_videos (title,description,video_url,cover_url,goods_id,sort,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [title, description, video_url, cover_url, goods_id || 0, sort, status]
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

// 管理端：获取七牛云上传token（纯内置crypto，无需qiniu包）
app.get('/adminapi/mini/video-token', auth, (req, res) => {
  try {
    const crypto = require('crypto')
    const AK = process.env.QINIU_AK || '5Y3KQi2xwmjZG339-mPFwsrSHm1e5e9nZkoW46Gl'
    const SK = process.env.QINIU_SK || 'y8BmL62oTxlZSl38IC3pJFyiBO_5g6l6gU7vroYk'
    const BUCKET = process.env.QINIU_BUCKET || 'nomad-videos'
    const DOMAIN = process.env.QINIU_DOMAIN || 'https://nomaderp.pages.dev/media'
    const UPLOAD_URL = process.env.QINIU_UPLOAD_URL || 'https://up-z2.qiniup.com/'
    const deadline = Math.floor(Date.now() / 1000) + 3600
    const policy = { scope: BUCKET, deadline, returnBody: '{"key":"$(key)","hash":"$(etag)"}' }
    const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_')
    const sign = crypto.createHmac('sha1', SK).update(encodedPolicy).digest()
    const encodedSign = sign.toString('base64').replace(/\+/g,'-').replace(/\//g,'_')
    const token = `${AK}:${encodedSign}:${encodedPolicy}`
    ok(res, { token, domain: DOMAIN, bucket: BUCKET, uploadUrl: UPLOAD_URL })
  } catch(e) { fail(res, e.message) }
})

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

// ─── 404 fallback ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ code: 0, message: `路由不存在: ${req.method} ${req.path}` })
})

start()
