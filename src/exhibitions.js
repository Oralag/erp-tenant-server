'use strict'

// Exhibition attribution is metadata. It never re-audits a sale or touches stock.
function registerExhibitions(router, pool, { ok, fail, genOrderNo }) {
  let migration
  const ensure = () => migration ||= pool.query(`
    CREATE TABLE IF NOT EXISTS retail_exhibitions (
      id SERIAL PRIMARY KEY, shop_id INTEGER NOT NULL, name VARCHAR(120) NOT NULL,
      start_date DATE NOT NULL, end_date DATE NOT NULL, location VARCHAR(200) NOT NULL DEFAULT '',
      owner_name VARCHAR(100) NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), UNIQUE(shop_id, name, start_date)
    );
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS exhibition_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE finance_expenses ADD COLUMN IF NOT EXISTS exhibition_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE finance_expenses ADD COLUMN IF NOT EXISTS exhibition_payment_id INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS retail_exhibition_orders ON retail_orders(shop_id, exhibition_id);
    CREATE INDEX IF NOT EXISTS retail_exhibition_expenses ON finance_expenses(shop_id, exhibition_id);
    CREATE TABLE IF NOT EXISTS exhibition_attribution_log (
      id BIGSERIAL PRIMARY KEY, shop_id INTEGER NOT NULL, admin_id INTEGER NOT NULL,
      document_type TEXT NOT NULL, document_id INTEGER NOT NULL, previous_id INTEGER NOT NULL,
      exhibition_id INTEGER NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `).catch(error => { migration = undefined; throw error })
  const sid = req => Number(req.admin?.shop_id) || 1
  const validId = value => {
    const id = Number(value || 0)
    if (!Number.isSafeInteger(id) || id < 0) throw Error('无效的展会编号')
    return id
  }
  async function validate(db, shopId, value) {
    const id = validId(value)
    if (id && !(await db.query('SELECT id FROM retail_exhibitions WHERE id=$1 AND shop_id=$2', [id, shopId])).rows.length) throw Error('展会不存在或不属于当前公司')
    return id
  }
  const route = fn => async (req, res) => {
    try { await ensure(); await fn(req, res) } catch (error) { fail(res, error.message) }
  }
  const transaction = async fn => {
    const db = await pool.connect()
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result }
    catch (error) { await db.query('ROLLBACK'); throw error }
    finally { db.release() }
  }
  // Validate attribution before the existing create/edit handlers persist it.
  router.use(async (req, res, next) => {
    const paths = ['/retail/order/add', '/retail/order/edit', '/finance/Expense/add', '/finance/Expense/edit']
    if (!paths.includes(req.path) || req.method !== 'POST') return next()
    try {
      await ensure()
      if (req.body.exhibition_id !== undefined) req.body.exhibition_id = await validate(pool, sid(req), req.body.exhibition_id)
      next()
    } catch (error) { fail(res, error.message) }
  })
  router.get('/retail/exhibition/index', route(async (req, res) => {
    const r = await pool.query('SELECT * FROM retail_exhibitions WHERE shop_id=$1 ORDER BY start_date DESC, id DESC', [sid(req)])
    ok(res, { rows: r.rows, total: r.rows.length })
  }))
  router.post('/finance/Expense/edit', route(async (req, res) => {
    const b = req.body
    const result = await transaction(async db => {
      const row = (await db.query('SELECT * FROM finance_expenses WHERE id=$1 AND shop_id=$2 AND deleted_at IS NULL FOR UPDATE', [validId(b.id), sid(req)])).rows[0]
      if (!row) throw Error('费用不存在')
      const amount = Number(b.amount ?? row.amount)
      if (!Number.isFinite(amount) || amount <= 0) throw Error('费用金额必须大于0')
      if (Number(row.exhibition_payment_id)) throw Error('展会费用已付款，请先撤销付款再编辑')
      const eventId = b.exhibition_id === undefined ? row.exhibition_id : await validate(db, sid(req), b.exhibition_id)
      return (await db.query('UPDATE finance_expenses SET name=$1,amount=$2,expense_date=$3,remark=$4,exhibition_id=$5 WHERE id=$6 AND shop_id=$7 RETURNING *', [String(b.name ?? row.name), amount, b.expense_date ?? row.expense_date, String(b.remark ?? row.remark), eventId, row.id, sid(req)])).rows[0]
    })
    ok(res, result)
  }))
  router.use(async (req, res, next) => {
    if (req.method !== 'POST' || !['/finance/Expense/del', '/finance/PayReceipt/del', '/finance/PayReceipt/edit', '/finance/PayReceipt/batchDel'].includes(req.path)) return next()
    try {
      await ensure()
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.id]).map(Number).filter(Number.isSafeInteger)
      const column = req.path.includes('/Expense/') ? 'id' : 'exhibition_payment_id'
      const paid = await pool.query(`SELECT id FROM finance_expenses WHERE shop_id=$1 AND ${column}=ANY($2::int[]) AND exhibition_payment_id>0 AND deleted_at IS NULL`, [sid(req), ids])
      if (paid.rows.length) throw Error('这笔付款关联展会费用，请先在展会管理中撤销付款')
      next()
    } catch (error) { fail(res, error.message) }
  })
  router.post('/retail/exhibition/undoExpensePayment', route(async (req, res) => {
    await transaction(async db => {
      const expense = (await db.query('SELECT * FROM finance_expenses WHERE id=$1 AND shop_id=$2 AND deleted_at IS NULL FOR UPDATE', [validId(req.body.id), sid(req)])).rows[0]
      if (!expense || !Number(expense.exhibition_payment_id)) throw Error('费用没有可撤销的展会付款')
      const receipt = (await db.query('SELECT * FROM pay_receipt WHERE id=$1 AND shop_id=$2 AND deleted_at IS NULL FOR UPDATE', [expense.exhibition_payment_id, sid(req)])).rows[0]
      if (!receipt) throw Error('关联付款单缺失，请核对后处理')
      const fund = await db.query('UPDATE finance_funds SET balance=balance+$1,update_time=NOW() WHERE id=$2 AND shop_id=$3 RETURNING id', [receipt.amount, receipt.fund_id, sid(req)])
      if (!fund.rows.length) throw Error('付款账户不存在')
      await db.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [receipt.id, sid(req)])
      await db.query('UPDATE finance_expenses SET exhibition_payment_id=0,remark=$1 WHERE id=$2 AND shop_id=$3', ['【待付款】 ' + String(expense.remark || '').replace(/【待付款】|【已付款】|\[待付款\]|\[已付款\]/g, '').trim(), expense.id, sid(req)])
    })
    ok(res)
  }))
  router.post('/retail/exhibition/save', route(async (req, res) => {
    const b = req.body
    const name = String(b.name || '').trim()
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value))
    if (!name || name.length > 120 || !validDate(b.start_date) || !validDate(b.end_date) || b.end_date < b.start_date) throw Error('请填写展会名称及有效的起止日期')
    const vals = [name, b.start_date, b.end_date, String(b.location || ''), String(b.owner_name || ''), String(b.remark || ''), sid(req)]
    const r = b.id
      ? await pool.query('UPDATE retail_exhibitions SET name=$1,start_date=$2,end_date=$3,location=$4,owner_name=$5,remark=$6 WHERE shop_id=$7 AND id=$8 RETURNING *', [...vals, validId(b.id)])
      : await pool.query('INSERT INTO retail_exhibitions(name,start_date,end_date,location,owner_name,remark,shop_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', vals)
    if (!r.rows.length) throw Error('展会不存在')
    ok(res, r.rows[0])
  }))
  router.get('/retail/exhibition/detail', route(async (req, res) => {
    const id = await validate(pool, sid(req), req.query.id)
    if (!id) throw Error('请选择展会')
    const [event, orders, expenses] = await Promise.all([
      pool.query('SELECT * FROM retail_exhibitions WHERE id=$1 AND shop_id=$2', [id, sid(req)]),
      pool.query('SELECT * FROM retail_orders WHERE exhibition_id=$1 AND shop_id=$2 ORDER BY order_date DESC,id DESC', [id, sid(req)]),
      pool.query('SELECT * FROM finance_expenses WHERE exhibition_id=$1 AND shop_id=$2 AND deleted_at IS NULL ORDER BY expense_date DESC,id DESC', [id, sid(req)]),
    ])
    ok(res, { exhibition: event.rows[0], orders: orders.rows, expenses: expenses.rows })
  }))
  router.get('/retail/exhibition/candidates', route(async (req, res) => {
    const { start_date, end_date } = req.query
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '') || end_date < start_date) throw Error('请选择有效日期范围')
    const r = await pool.query('SELECT * FROM retail_orders WHERE shop_id=$1 AND order_date BETWEEN $2::date AND $3::date ORDER BY order_date,id', [sid(req), start_date, end_date])
    ok(res, { rows: r.rows, total: r.rows.length })
  }))
  router.post('/retail/exhibition/assign', route(async (req, res) => {
    const type = req.body.type === 'expense' ? 'expense' : 'order'
    const table = type === 'expense' ? 'finance_expenses' : 'retail_orders'
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number))]
    if (!ids.length || ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('请选择有效单据（每次最多1000张）')
    const result = await transaction(async db => {
      const eventId = await validate(db, sid(req), req.body.exhibition_id)
      const rows = (await db.query(`SELECT id,exhibition_id FROM ${table} WHERE shop_id=$1 AND id=ANY($2::int[]) ${type === 'expense' ? 'AND deleted_at IS NULL' : ''} ORDER BY id FOR UPDATE`, [sid(req), ids])).rows
      if (rows.length !== ids.length) throw Error('部分单据不存在或不属于当前公司，未修改任何单据')
      // Require the caller's observed prior state, preventing stale selections from moving another event's sales.
      for (const row of rows) {
        const previous = req.body.previous?.[row.id]
        if (previous === undefined || Number(previous) !== Number(row.exhibition_id)) throw Error('单据归属已变化，请刷新后重试')
        if (Number(row.exhibition_id) === eventId) continue
        await db.query('INSERT INTO exhibition_attribution_log(shop_id,admin_id,document_type,document_id,previous_id,exhibition_id) VALUES($1,$2,$3,$4,$5,$6)', [sid(req), Number(req.admin?.id) || 0, type, row.id, row.exhibition_id, eventId])
      }
      await db.query(`UPDATE ${table} SET exhibition_id=$1 WHERE shop_id=$2 AND id=ANY($3::int[])`, [eventId, sid(req), ids])
      return { count: rows.length, exhibition_id: eventId }
    })
    ok(res, result)
  }))
  // Keep the existing expense record as the single source of cost. Payment is a separate atomic operation.
  router.post('/retail/exhibition/payExpense', route(async (req, res) => {
    const result = await transaction(async db => {
      const expense = (await db.query('SELECT * FROM finance_expenses WHERE id=$1 AND shop_id=$2 AND exhibition_id>0 AND deleted_at IS NULL FOR UPDATE', [validId(req.body.id), sid(req)])).rows[0]
      if (!expense || Number(expense.status) !== 1) throw Error('费用不存在或尚未确认')
      if (Number(expense.exhibition_payment_id) || /【已付款】|\[已付款\]/.test(expense.remark || '')) throw Error('这笔费用已付款，请勿重复支付')
      const fund = (await db.query('SELECT id,name FROM finance_funds WHERE id=$1 AND shop_id=$2 AND deleted_at IS NULL FOR UPDATE', [validId(req.body.fund_id), sid(req)])).rows[0]
      if (!fund) throw Error('请选择当前公司的资金账户')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.pay_date || '')) throw Error('请选择付款日期')
      const receipt = (await db.query(`INSERT INTO pay_receipt(receipt_no,order_sn,contact_type,contact_name,amount,pay_date,fund_id,fund_name,remark,status,shop_id)
        VALUES($1,$2,'other',$3,$4,$5,$6,$7,$8,1,$9) RETURNING id`, [genOrderNo('FK'), expense.expense_no, expense.name, expense.amount, req.body.pay_date, fund.id, fund.name, `展会费用 #${expense.id}`, sid(req)])).rows[0]
      await db.query('UPDATE finance_funds SET balance=balance-$1,update_time=NOW() WHERE id=$2 AND shop_id=$3', [expense.amount, fund.id, sid(req)])
      const remark = '【已付款】 ' + String(expense.remark || '').replace(/【待付款】|【已付款】|\[待付款\]|\[已付款\]/g, '').trim()
      await db.query('UPDATE finance_expenses SET exhibition_payment_id=$1,remark=$2 WHERE id=$3 AND shop_id=$4', [receipt.id, remark, expense.id, sid(req)])
      return { id: expense.id, receipt_id: receipt.id }
    })
    ok(res, result)
  }))
  return { ensure }
}

module.exports = { registerExhibitions }
