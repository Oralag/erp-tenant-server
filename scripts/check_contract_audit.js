const { pool } = require('../src/db')

function n(v) {
  const x = Number(v || 0)
  return Number.isFinite(x) ? x : 0
}

function isAutoReceipt(remark) {
  const s = String(remark || '')
  return s.includes('审核自动生成')
    || s.includes('合同自动收款')
    || s.includes('预付款核销')
    || s.includes('一键销售收款')
}

function parseGoodsInfo(v) {
  if (Array.isArray(v)) return v
  try { return JSON.parse(v || '[]') } catch { return [] }
}

async function main() {
  const client = await pool.connect()
  try {
    const contractsRes = await client.query(`
      SELECT id, order_sn, order_no, customer_name, status, receive_amount, create_time, sign_date
      FROM sale_contracts
      WHERE deleted_at IS NULL AND status IN (1,4)
      ORDER BY id DESC
    `)
    const contracts = contractsRes.rows || []

    const receiptsRes = await client.query(`
      SELECT id, order_sn, amount, remark, receipt_date, fund_id, fund_name
      FROM collect_receipt
      WHERE deleted_at IS NULL
    `)
    const receipts = receiptsRes.rows || []

    const byOrderSn = new Map()
    for (const r of receipts) {
      const sn = String(r.order_sn || '').trim()
      if (!sn) continue
      if (!byOrderSn.has(sn)) byOrderSn.set(sn, [])
      byOrderSn.get(sn).push(r)
    }

    const financeIssues = []
    for (const c of contracts) {
      const sn = String(c.order_sn || c.order_no || '').trim()
      if (!sn) continue
      const rows = byOrderSn.get(sn) || []
      const autoRows = rows.filter((r) => isAutoReceipt(r.remark))
      const autoAmount = autoRows.reduce((s, r) => s + n(r.amount), 0)
      const expectedReceive = Math.max(0, n(c.receive_amount))

      if (expectedReceive <= 0.0001 && autoAmount > 0.0001) {
        financeIssues.push({
          type: 'NO_RECEIVE_BUT_AUTO_RECEIPT',
          contract_id: c.id,
          order_sn: sn,
          customer_name: c.customer_name || '',
          expected_receive_amount: expectedReceive,
          auto_receipt_amount: Number(autoAmount.toFixed(2)),
          auto_receipt_count: autoRows.length,
        })
      }

      if (autoAmount > expectedReceive + 0.01) {
        financeIssues.push({
          type: 'AUTO_RECEIPT_EXCEEDS_RECEIVE_AMOUNT',
          contract_id: c.id,
          order_sn: sn,
          customer_name: c.customer_name || '',
          expected_receive_amount: Number(expectedReceive.toFixed(2)),
          auto_receipt_amount: Number(autoAmount.toFixed(2)),
          auto_receipt_count: autoRows.length,
        })
      }

      if (autoRows.length > 1) {
        financeIssues.push({
          type: 'MULTIPLE_AUTO_RECEIPTS',
          contract_id: c.id,
          order_sn: sn,
          customer_name: c.customer_name || '',
          expected_receive_amount: Number(expectedReceive.toFixed(2)),
          auto_receipt_amount: Number(autoAmount.toFixed(2)),
          auto_receipt_count: autoRows.length,
        })
      }
    }

    const outRes = await client.query(`
      SELECT id, order_no, remark, status, goods_info, warehouse_id, warehouse_name
      FROM sale_out_order
      WHERE deleted_at IS NULL AND status=1
      ORDER BY id DESC
    `)
    const saleOutRows = outRes.rows || []

    const flowRes = await client.query(`
      SELECT order_no, type, qty
      FROM stock_flow
      WHERE type IN ('sale_out', 'sale_out_reverse')
    `)
    const flowRows = flowRes.rows || []
    const saleOutFlowByOrderNo = new Map()
    for (const f of flowRows) {
      const key = String(f.order_no || '').trim()
      if (!key) continue
      const cur = saleOutFlowByOrderNo.get(key) || { out: 0, reverse: 0 }
      if (String(f.type) === 'sale_out') cur.out += Math.abs(n(f.qty))
      if (String(f.type) === 'sale_out_reverse') cur.reverse += Math.abs(n(f.qty))
      saleOutFlowByOrderNo.set(key, cur)
    }

    const stockIssues = []
    for (const out of saleOutRows) {
      const goods = parseGoodsInfo(out.goods_info)
      const outQty = goods.reduce((s, i) => s + Math.abs(n(i.num)), 0)
      const key = String(out.order_no || '').trim()
      const flow = saleOutFlowByOrderNo.get(key) || { out: 0, reverse: 0 }
      if (Math.abs(flow.out - outQty) > 0.01) {
        stockIssues.push({
          type: 'SALE_OUT_FLOW_MISMATCH',
          sale_out_id: out.id,
          order_no: key,
          sale_out_qty: Number(outQty.toFixed(4)),
          stock_flow_sale_out_qty: Number(flow.out.toFixed(4)),
          diff: Number((flow.out - outQty).toFixed(4)),
          remark: out.remark || '',
        })
      }
    }

    const suspiciousOtherOut = await client.query(`
      SELECT id, order_no, remark, status, create_time
      FROM stock_other_out
      WHERE deleted_at IS NULL AND remark='销售出库' AND status=1
      ORDER BY id DESC
      LIMIT 200
    `)

    const report = {
      generated_at: new Date().toISOString(),
      audited_contract_count: contracts.length,
      finance_issue_count: financeIssues.length,
      stock_issue_count: stockIssues.length,
      suspicious_other_out_count: suspiciousOtherOut.rows.length,
      finance_issues: financeIssues.slice(0, 500),
      stock_issues: stockIssues.slice(0, 500),
      suspicious_other_out_sample: suspiciousOtherOut.rows.slice(0, 50),
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[check_contract_audit] failed:', e?.message || e)
  process.exit(1)
})

