// All effects of an audit run on the same connection. Row locks make retries
// and concurrent audit/unaudit requests idempotent.
function createAuditService(pool) {
  let schemaReady
  function ensureSchema() {
    if (!schemaReady) schemaReady = (async () => {
      // Existing installations used integer stock quantities. Weighing requires
      // fractional base units; widen without rounding or changing stored values.
      await pool.query(`DO $$
        DECLARE col RECORD;
        BEGIN
          PERFORM pg_advisory_xact_lock(731204916);
          FOR col IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND data_type IN ('smallint','integer','bigint')
              AND ((table_name = 'stock_inventory' AND column_name = 'qty')
                OR (table_name = 'stock_flow' AND column_name IN ('qty','before_qty','after_qty')))
          LOOP
            EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC USING %I::numeric',
              col.table_name, col.column_name, col.column_name);
          END LOOP;
        END $$`)
      await pool.query(`CREATE TABLE IF NOT EXISTS retail_audit_effects (
        order_id INTEGER PRIMARY KEY, shop_id INTEGER NOT NULL,
        fund_id INTEGER NOT NULL, amount NUMERIC(18,2) NOT NULL,
        other_out_id INTEGER NOT NULL DEFAULT 0
      )`)
    })().catch(e => { schemaReady = null; throw e })
    return schemaReady
  }
  async function transaction(work) {
    await ensureSchema()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  }
  function statusValue(value) {
    const n = Number(value)
    if (value == null || value === '' || ![0, 1].includes(n)) throw new Error('status必须是0或1')
    return n
  }
  function positiveInteger(value, label = '商品ID') {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}无效，请刷新商品列表后重试`)
    return n
  }
  function itemsOf(raw) {
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(items)) throw new Error('商品明细格式错误')
    return items.filter(i => Number(i.num) > 0).map(i => ({ ...i, goods_id: positiveInteger(i.goods_id), num: Number(i.num) }))
  }
  async function lockOrder(client, table, id, shopId) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE id=$1 AND shop_id=$2 FOR UPDATE`, [id, shopId])
    if (!rows[0] || rows[0].deleted_at) throw new Error('单据不存在')
    return rows[0]
  }
  async function fundDelta(client, fundId, amount, shopId) {
    const r = await client.query(`UPDATE finance_funds SET balance=COALESCE(balance,0)+$1, update_time=NOW()
      WHERE id=$2 AND shop_id=$3 AND deleted_at IS NULL RETURNING id`, [amount, fundId, shopId])
    if (!r.rows.length) throw new Error('资金账户不存在或不属于当前公司')
  }
  // 新建库存行用商品档案的基础单位，不用单据行选的单位
  async function baseUnitOf(client, item) {
    const r = await client.query('SELECT unit_name FROM goods WHERE id=$1 LIMIT 1', [item.goods_id]).catch(() => ({ rows: [] }))
    if (r.rows[0]?.unit_name) return r.rows[0].unit_name
    const ratio = Number(item.unit_ratio)
    return ratio > 0 && ratio !== 1 ? '' : (item.unit_name || '')
  }
  async function stockDelta(client, shopId, warehouseId, warehouseName, item, delta) {
    // Also serializes creation when an inventory row does not exist yet.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stock:${shopId}:${warehouseId}:${item.goods_id}`])
    const { rows } = await client.query(`SELECT * FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2 AND shop_id=$3 FOR UPDATE`, [item.goods_id, warehouseId, shopId])
    if (rows.length > 1) throw new Error('同一商品仓库存在重复库存记录，请先核对')
    const before = Number(rows[0]?.qty || 0)
    const after = Math.round((before + delta) * 10000) / 10000
    if (rows[0]) {
      // 顺手把库存行单位校正成商品基础单位（历史上被单据单位覆盖过，如「箱」「捆」）
      const unit = await baseUnitOf(client, item)
      await client.query('UPDATE stock_inventory SET qty=$1, unit_name=COALESCE(NULLIF($4,\'\'),unit_name), update_time=NOW() WHERE id=$2 AND shop_id=$3', [after, rows[0].id, shopId, unit])
    } else {
      await client.query(`INSERT INTO stock_inventory (goods_id,goods_name,unit_name,warehouse_id,warehouse_name,qty,shop_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [item.goods_id, item.goods_name || '', await baseUnitOf(client, item), warehouseId, warehouseName, after, shopId])
    }
    return { before, after }
  }
  async function applyOutbound(client, order, shopId, type) {
    for (const item of itemsOf(order.goods_info).sort((a,b) => Number(a.goods_id)-Number(b.goods_id))) {
      // num 是所选单位的数量，换算成基础单位再扣（1 所选单位 = unit_ratio 基础单位）
      const ratio = Number(item.unit_ratio)
      const delta = -Math.round(Number(item.num) * (ratio > 0 ? ratio : 1) * 10000) / 10000
      const { before, after } = await stockDelta(client, shopId, order.warehouse_id || 0, order.warehouse_name || '', item, delta)
      await client.query(`INSERT INTO stock_flow (goods_id,goods_name,warehouse_id,warehouse_name,type,qty,before_qty,after_qty,order_no,remark,shop_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [item.goods_id,item.goods_name || '',order.warehouse_id || 0,order.warehouse_name || '',type,delta,before,after,order.order_no,`${type}#${order.id}`,shopId])
    }
  }
  async function reverseOutbound(client, order, shopId, type) {
    const { rows } = await client.query(`SELECT * FROM stock_flow
      WHERE shop_id=$1 AND type=$2 AND (order_no=$3 OR remark=$4)
      ORDER BY goods_id,id FOR UPDATE`, [shopId, type, order.order_no || '', `${type}#${order.id}`])
    if (!rows.length && itemsOf(order.goods_info).length) throw new Error('历史单据缺少库存流水，无法安全反审核，请先核对')
    for (const flow of rows) {
      // Historical rows may have clamped negative stock to zero: undo only
      // the recorded actual change, not the requested outbound quantity.
      const delta = Number(flow.before_qty) - Number(flow.after_qty)
      await stockDelta(client, shopId, flow.warehouse_id, flow.warehouse_name || '', flow, delta)
    }
    await client.query('DELETE FROM stock_flow WHERE id=ANY($1::int[]) AND shop_id=$2', [rows.map(r => r.id), shopId])
  }
  async function auditOutbound(id, status, shopId, table = 'sale_out_order') {
    if (!['sale_out_order','stock_other_out'].includes(table)) throw new Error('不支持的单据')
    status = statusValue(status)
    return transaction(async client => {
      const order = await lockOrder(client, table, id, shopId)
      if (Number(order.status) === status) return { changed: false }
      const type = table === 'sale_out_order' ? 'sale_out' : 'other_out'
      if (status === 1) await applyOutbound(client, order, shopId, type)
      else await reverseOutbound(client, order, shopId, type)
      await client.query(`UPDATE ${table} SET status=$1 WHERE id=$2 AND shop_id=$3`, [status,id,shopId])
      return { changed: true }
    })
  }
  async function annulOutbound(id, shopId) {
    return transaction(async client => {
      const order = await lockOrder(client, 'stock_other_out', id, shopId)
      if (Number(order.status) === 1) await reverseOutbound(client, order, shopId, 'other_out')
      await client.query('DELETE FROM stock_other_out WHERE id=$1 AND shop_id=$2', [id, shopId])
      return { changed: true }
    })
  }
  async function auditPurchase(id, status, shopId) {
    status = statusValue(status)
    return transaction(async client => {
      const po = await lockOrder(client, 'purchase_order', id, shopId)
      if (Number(po.status) === status) return { changed: false }
      const orderNo = po.order_no || po.order_sn || ''
      const amount = Number(po.pay_amount || 0)
      const marker = `(采购单(自动)?付款|Purchase Order Payment|采购单据支出|Purchase Document Expense|采购运费|Purchase Freight|采购附加费用|Purchase Addon Fee)[[:space:]]*#${Number(id)}([^0-9]|$)`
      const receipts = await client.query(`SELECT * FROM pay_receipt WHERE shop_id=$1 AND deleted_at IS NULL
        AND ((order_sn<>'' AND order_sn=ANY($2::text[])) OR remark ~ $3) ORDER BY id FOR UPDATE`,
      [shopId,[po.order_no,po.order_sn].filter(Boolean),marker])
      if (status === 1 && amount > 0) {
        if (!po.fund_id) throw new Error('请先在采购单中选择资金账户再审核')
        const main = receipts.rows.filter(r => !/(附加费用|Addon Fee|运费|Freight|单据支出|Document Expense)/.test(r.remark || ''))
        if (!main.length) {
          await fundDelta(client, po.fund_id, -amount, shopId)
          await client.query(`INSERT INTO pay_receipt (receipt_no,order_sn,contact_type,contact_name,amount,pay_date,fund_id,fund_name,remark,status,shop_id)
            VALUES ($1,$2,'supplier',$3,$4,$5,$6,$7,$8,1,$9)`,
          [`FK${Date.now()}${id}`,orderNo,po.supplier_name || '',amount,po.order_date || new Date(),po.fund_id,po.fund_name || '',`采购单付款 #${id}`,shopId])
        }
      } else if (status === 0) {
        // Refund the surviving receipts only. A receipt already reversed by
        // an older client must never cause a second refund from po.pay_amount.
        for (const receipt of receipts.rows) {
          if (receipt.fund_id && Number(receipt.status) === 1) await fundDelta(client, receipt.fund_id, Number(receipt.amount), shopId)
          await client.query('UPDATE pay_receipt SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2', [receipt.id,shopId])
        }
      }
      await client.query('UPDATE purchase_order SET status=$1 WHERE id=$2 AND shop_id=$3', [status,id,shopId])
      return { changed: true }
    })
  }
  async function retailInTransaction(client, order, status, shopId) {
    if (Number(order.status) === status) return { changed: false }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`retail-fund:${shopId}`])
    if (status === 1) {
      const funds = await client.query(`SELECT * FROM finance_funds WHERE shop_id=$1 AND name='零售收款账户' AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [shopId])
      if (funds.rows.length > 1) throw new Error('存在多个零售收款账户，请先核对')
      let fund = funds.rows[0]
      if (!fund) fund = (await client.query(`INSERT INTO finance_funds (name,fund_type,balance,shop_id) VALUES ('零售收款账户',2,0,$1) RETURNING *`, [shopId])).rows[0]
      const items = itemsOf(order.goods_info).map(i => ({...i,num:Math.round(Number(i.num)*(Number(i.unit_ratio)||1)*10000)/10000,unit_ratio:1}))
      let outId = 0
      if (items.length) {
        // 零售出库扣「仓库设置」里的默认仓库；没设或那个仓库已删，才退回第一个仓库
        const defParam = (await client.query(`SELECT value FROM sys_params WHERE key='default_warehouse_id' AND shop_id=$1 LIMIT 1`, [shopId])).rows[0]
        const defWhId = Number(defParam?.value || 0)
        const wh = (defWhId > 0 ? (await client.query('SELECT * FROM warehouses WHERE id=$1 AND shop_id=$2', [defWhId, shopId])).rows[0] : null)
          || (await client.query('SELECT * FROM warehouses WHERE shop_id=$1 AND COALESCE(status,1)<>0 ORDER BY id LIMIT 1', [shopId])).rows[0]
        if (!wh) throw new Error('找不到仓库')
        const out = (await client.query(`INSERT INTO stock_other_out (order_no,warehouse_id,warehouse_name,goods_info,remark,status,shop_id)
          VALUES ($1,$2,$3,$4,$5,1,$6) RETURNING *`, [`LSCK${order.id}`,wh.id,wh.name,JSON.stringify(items),`零售出库#${order.id}`,shopId])).rows[0]
        outId = out.id
        await applyOutbound(client, out, shopId, 'other_out')
      }
      const amount = Number(order.pay_amount || 0)
      if (!Number.isFinite(amount) || amount < 0) throw new Error('零售收款金额无效')
      await fundDelta(client, fund.id, amount, shopId)
      await client.query('INSERT INTO retail_audit_effects (order_id,shop_id,fund_id,amount,other_out_id) VALUES ($1,$2,$3,$4,$5)', [order.id,shopId,fund.id,amount,outId])
    } else {
      const effect = (await client.query('SELECT * FROM retail_audit_effects WHERE order_id=$1 AND shop_id=$2 FOR UPDATE', [order.id,shopId])).rows[0]
      const outs = await client.query(`SELECT * FROM stock_other_out WHERE shop_id=$1 AND
        (id=$2 OR remark=ANY($3::text[])) ORDER BY id FOR UPDATE`, [shopId,effect?.other_out_id || 0,[`零售出库#${order.id}`,`Retail Sale Out#${order.id}`,`Retail outbound #${order.id}`]])
      if (!effect && !outs.rows.length && itemsOf(order.goods_info).length) throw new Error('历史零售单缺少关联出库记录，请先核对后再反审核')
      for (const out of outs.rows) {
        if (Number(out.status) === 1) await reverseOutbound(client, out, shopId, 'other_out')
        await client.query('DELETE FROM stock_other_out WHERE id=$1 AND shop_id=$2', [out.id,shopId])
      }
      let fundId = effect?.fund_id
      if (!effect) {
        const funds = await client.query(`SELECT id FROM finance_funds WHERE shop_id=$1 AND name='零售收款账户' AND deleted_at IS NULL`, [shopId])
        if (funds.rows.length !== 1 && Number(order.pay_amount) > 0) throw new Error('无法确定历史零售收款账户')
        fundId = funds.rows[0]?.id
      }
      const amount = Number(effect?.amount ?? order.pay_amount ?? 0)
      if (amount) await fundDelta(client, fundId, -amount, shopId)
      await client.query('DELETE FROM retail_audit_effects WHERE order_id=$1 AND shop_id=$2', [order.id,shopId])
    }
    await client.query('UPDATE retail_orders SET status=$1 WHERE id=$2 AND shop_id=$3', [status,order.id,shopId])
    return { changed: true }
  }
  async function auditRetail(id, status, shopId) {
    status = statusValue(status)
    return transaction(async client => retailInTransaction(client, await lockOrder(client,'retail_orders',id,shopId),status,shopId))
  }
  // 盘点单：审核时按「审核那一刻」的账面数算差额（实盘 - 账面），差多少调多少，每个商品写一条 stock_check 流水；
  // 反审核按流水把调整原样撤回并删掉流水。账面数不用单据里存的 system_qty（开单后可能又卖了货）
  async function auditCheck(id, status, shopId) {
    status = statusValue(status)
    return transaction(async client => {
      const order = await lockOrder(client, 'stock_checks', id, shopId)
      if (Number(order.status) === status) return { changed: false }
      const orderNo = order.order_no || `PD${order.id}`
      if (status === 1) {
        const whId = Number(order.warehouse_id) || 0
        if (!whId) throw new Error('盘点单没有选仓库')
        const raw = typeof order.goods_info === 'string' ? JSON.parse(order.goods_info || '[]') : (order.goods_info || [])
        const items = (Array.isArray(raw) ? raw : []).filter(i => Number(i?.goods_id) > 0 && i?.check_qty !== '' && i?.check_qty != null)
        if (!items.length) throw new Error('盘点单里没有填实盘数量的商品')
        const seen = new Set()
        for (const it of items.sort((a, b) => Number(a.goods_id) - Number(b.goods_id))) {
          const gid = positiveInteger(it.goods_id)
          if (seen.has(gid)) throw new Error(`盘点单里「${it.goods_name || gid}」重复了，请合并成一行`)
          seen.add(gid)
          const actual = Number(it.check_qty)
          if (!Number.isFinite(actual) || actual < 0) throw new Error(`「${it.goods_name || gid}」实盘数量无效`)
          const cur = (await client.query('SELECT qty FROM stock_inventory WHERE goods_id=$1 AND warehouse_id=$2 AND shop_id=$3', [gid, whId, shopId])).rows[0]
          const delta = Math.round((actual - Number(cur?.qty || 0)) * 10000) / 10000
          if (delta === 0) continue
          const item = { goods_id: gid, goods_name: it.goods_name || '', unit_name: it.unit_name || '' }
          const { before, after } = await stockDelta(client, shopId, whId, order.warehouse_name || '', item, delta)
          await client.query(`INSERT INTO stock_flow (goods_id,goods_name,warehouse_id,warehouse_name,type,qty,before_qty,after_qty,order_no,remark,shop_id)
            VALUES ($1,$2,$3,$4,'stock_check',$5,$6,$7,$8,$9,$10)`,
          [gid, item.goods_name, whId, order.warehouse_name || '', delta, before, after, orderNo, `stock_check#${order.id}`, shopId])
        }
      } else {
        const { rows } = await client.query(`SELECT * FROM stock_flow WHERE shop_id=$1 AND type='stock_check' AND remark=$2 ORDER BY goods_id,id FOR UPDATE`, [shopId, `stock_check#${order.id}`])
        for (const flow of rows) {
          await stockDelta(client, shopId, flow.warehouse_id, flow.warehouse_name || '', flow, -(Number(flow.after_qty) - Number(flow.before_qty)))
        }
        if (rows.length) await client.query('DELETE FROM stock_flow WHERE id=ANY($1::int[]) AND shop_id=$2', [rows.map(r => r.id), shopId])
      }
      await client.query('UPDATE stock_checks SET status=$1 WHERE id=$2 AND shop_id=$3', [status, order.id, shopId])
      return { changed: true }
    })
  }
  return { transaction, auditPurchase, auditOutbound, annulOutbound, auditRetail, retailInTransaction, auditCheck }
}
module.exports = { createAuditService }
