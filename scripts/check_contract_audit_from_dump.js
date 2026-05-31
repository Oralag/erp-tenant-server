const fs = require('fs')
const readline = require('readline')

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

async function parseDump(filePath, tables) {
  const rowsByTable = Object.fromEntries(tables.map((t) => [t, []]))
  let current = null
  let cols = []

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!current) {
      const m = line.match(/^COPY public\.([a-zA-Z0-9_]+) \((.+)\) FROM stdin;$/)
      if (m) {
        const table = m[1]
        if (tables.includes(table)) {
          current = table
          cols = m[2].split(',').map((s) => s.trim())
        } else {
          current = '__skip__'
          cols = []
        }
      }
      continue
    }

    if (line === '\\.') {
      current = null
      cols = []
      continue
    }

    if (current === '__skip__') continue
    const vals = line.split('\t')
    const row = {}
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]] = vals[i] === '\\N' ? null : vals[i]
    }
    rowsByTable[current].push(row)
  }

  return rowsByTable
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node scripts/check_contract_audit_from_dump.js /path/to/neon_backup_xxx.sql')
    process.exit(1)
  }
  if (!fs.existsSync(filePath)) {
    console.error(`Dump file not found: ${filePath}`)
    process.exit(1)
  }

  const needTables = ['sale_contracts', 'collect_receipt', 'sale_out_order', 'stock_flow', 'stock_other_out']
  const data = await parseDump(filePath, needTables)

  const contracts = (data.sale_contracts || []).filter((r) => !r.deleted_at && (String(r.status) === '1' || String(r.status) === '4'))
  const receipts = (data.collect_receipt || []).filter((r) => !r.deleted_at)
  const saleOutRows = (data.sale_out_order || []).filter((r) => !r.deleted_at && String(r.status) === '1')
  const stockFlows = (data.stock_flow || [])
  const otherOutRows = (data.stock_other_out || []).filter((r) => !r.deleted_at && String(r.status) === '1')

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
        contract_id: Number(c.id),
        order_sn: sn,
        customer_name: c.customer_name || '',
        expected_receive_amount: Number(expectedReceive.toFixed(2)),
        auto_receipt_amount: Number(autoAmount.toFixed(2)),
        auto_receipt_count: autoRows.length,
      })
    }
    if (autoAmount > expectedReceive + 0.01) {
      financeIssues.push({
        type: 'AUTO_RECEIPT_EXCEEDS_RECEIVE_AMOUNT',
        contract_id: Number(c.id),
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
        contract_id: Number(c.id),
        order_sn: sn,
        customer_name: c.customer_name || '',
        expected_receive_amount: Number(expectedReceive.toFixed(2)),
        auto_receipt_amount: Number(autoAmount.toFixed(2)),
        auto_receipt_count: autoRows.length,
      })
    }
  }

  const saleOutFlowByOrderNo = new Map()
  for (const f of stockFlows) {
    const key = String(f.order_no || '').trim()
    if (!key) continue
    const type = String(f.type || '')
    if (type !== 'sale_out' && type !== 'sale_out_reverse') continue
    const cur = saleOutFlowByOrderNo.get(key) || { out: 0, reverse: 0 }
    if (type === 'sale_out') cur.out += Math.abs(n(f.qty))
    if (type === 'sale_out_reverse') cur.reverse += Math.abs(n(f.qty))
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
        sale_out_id: Number(out.id),
        order_no: key,
        sale_out_qty: Number(outQty.toFixed(4)),
        stock_flow_sale_out_qty: Number(flow.out.toFixed(4)),
        diff: Number((flow.out - outQty).toFixed(4)),
        remark: out.remark || '',
      })
    }
  }

  const suspiciousOtherOut = otherOutRows
    .filter((r) => String(r.remark || '') === '销售出库')
    .slice(0, 200)
    .map((r) => ({
      id: Number(r.id),
      order_no: r.order_no || '',
      remark: r.remark || '',
      create_time: r.create_time || '',
    }))

  const report = {
    mode: 'offline_dump',
    dump_file: filePath,
    generated_at: new Date().toISOString(),
    audited_contract_count: contracts.length,
    finance_issue_count: financeIssues.length,
    stock_issue_count: stockIssues.length,
    suspicious_other_out_count: suspiciousOtherOut.length,
    finance_issues: financeIssues.slice(0, 1000),
    stock_issues: stockIssues.slice(0, 1000),
    suspicious_other_out_sample: suspiciousOtherOut.slice(0, 100),
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error('[check_contract_audit_from_dump] failed:', e?.message || e)
  process.exit(1)
})

