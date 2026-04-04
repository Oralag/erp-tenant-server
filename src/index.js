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

const app = express()
const PORT = process.env.PORT || 8888
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
    const result = await pool.query('SELECT * FROM admins WHERE account=$1 AND deleted_at IS NULL', [account])
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
    await listQuery(res, 'sale_contracts', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: conditions.join(' AND '), orderBy: 'id DESC', page, list_rows, offset })
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
    await listQuery(res, 'purchase_order', { keyword: req.query.keyword, keywordCols: ['order_no','supplier_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
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
    const supplierName = po.supplier_name || '未知供应商'
    const orderNo = po.order_no || ''
    const orderDate = po.order_date || new Date()

    const fundId = po.fund_id ? parseInt(po.fund_id) : 0
    const fundName = po.fund_name || ''

    // 审核时必须选择资金账户
    if (isAudit && totalAmount > 0 && !fundId) {
      return fail(res, '请先在采购单中选择资金账户再审核')
    }

    if (totalAmount > 0) {
      if (isAudit) {
        // 审核：扣减账户余额，生成付款单
        await pool.query('UPDATE finance_funds SET balance=balance-$1 WHERE id=$2', [totalAmount, fundId])
        const receiptNo = genOrderNo('FK')
        await pool.query(
          `INSERT INTO pay_receipt (receipt_no, order_sn, contact_type, contact_name, amount, pay_date, fund_id, fund_name, remark, status, category)
           VALUES ($1,$2,'supplier',$3,$4,$5,$6,$7,$8,1,'purchase')`,
          [receiptNo, orderNo, supplierName, totalAmount, orderDate, fundId, fundName, `采购单${orderNo}审核自动生成`]
        )
      } else {
        // 反审核：加回余额，删除对应付款单
        if (fundId) {
          await pool.query('UPDATE finance_funds SET balance=balance+$1 WHERE id=$2', [totalAmount, fundId])
        }
        await pool.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE order_sn=$1 AND deleted_at IS NULL', [orderNo])
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
    await pool.query(`UPDATE purchase_order SET deleted_at=NOW() WHERE id=ANY($1)`, [idArr])
    return ok(res)
  } catch (e) { fail(res, e.message) }
})

// SaleOutOrder
router.get('/stock/SaleOutOrder/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'sale_out_order', { keyword: req.query.keyword, keywordCols: ['order_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
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
    await pool.query('UPDATE sale_out_order SET status=$1 WHERE id=$2', [status ?? 1, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
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
    await pool.query('UPDATE sale_return_order SET status=$1 WHERE id=$2', [status ?? 1, id])
    return ok(res)
  } catch (e) { fail(res, e.message) }
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
router.post('/stock/OtherOut/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
    await pool.query('DELETE FROM stock_other_out WHERE id=$1', [id])
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
        await pool.query(
          'UPDATE stock_inventory SET qty=GREATEST(0, qty-$1), update_time=NOW() WHERE goods_id=$2',
          [parseFloat(item.num), item.goods_id]
        )
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
        await pool.query(
          'UPDATE stock_inventory SET qty=qty+$1, update_time=NOW() WHERE goods_id=$2',
          [parseFloat(item.num), item.goods_id]
        )
      }
      // 从资金账户扣回退款
      if (fundId && totalAmount > 0) {
        const unpaid = Math.max(0, orderTotalAmount - orderPayAmount)
        const refund = Math.max(0, totalAmount - unpaid)
        if (refund > 0) {
          await pool.query('UPDATE finance_funds SET balance=GREATEST(0,balance-$1), update_time=NOW() WHERE id=$2', [refund, fundId])
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
router.get('/finance/CollectReceipt/index', async (req, res) => {
  try {
    const { page, list_rows, offset } = pageParams(req.query)
    await listQuery(res, 'collect_receipt', { keyword: req.query.keyword, keywordCols: ['receipt_no','customer_name'], baseWhere: 'deleted_at IS NULL', orderBy: 'id DESC', page, list_rows, offset })
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/CollectReceipt/add', async (req, res) => {
  try {
    const b = filterBodyCols('collect_receipt', { receipt_no: genOrderNo('SK'), ...req.body })
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
      await pool.query('UPDATE finance_funds SET balance=GREATEST(0,balance-$1), update_time=NOW() WHERE id=$2', [Number(r.rows[0].amount), r.rows[0].fund_id])
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
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => b[k])
    const r = await pool.query(`INSERT INTO pay_receipt (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    // 同步资金账户余额
    if (b.fund_id && Number(b.amount)) {
      await pool.query('UPDATE finance_funds SET balance=GREATEST(0,balance-$1), update_time=NOW() WHERE id=$2', [Number(b.amount), b.fund_id])
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
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Expense/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
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
    return ok(res, r.rows[0])
  } catch (e) { fail(res, e.message) }
})
router.post('/finance/Prepay/del', async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return fail(res, 'id不能为空')
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
    const b = filterBodyCols('retail_orders', { order_sn: genOrderNo('LS'), ...req.body })
    const cols = Object.keys(b).filter(k => b[k] !== undefined)
    const vals = cols.map(k => typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k])
    const r = await pool.query(`INSERT INTO retail_orders (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`)}) RETURNING *`, vals)
    return ok(res, r.rows[0])
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

// ─── 404 fallback ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ code: 0, message: `路由不存在: ${req.method} ${req.path}` })
})

// ─── start ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDb()
    await loadTableCols()
    app.listen(PORT, () => {
      console.log(`ERP server running on port ${PORT}`)
    })
  } catch (e) {
    console.error('Failed to start server:', e)
    process.exit(1)
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

start()

