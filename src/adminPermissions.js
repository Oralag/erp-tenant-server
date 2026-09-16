const PERM_PREFIX = '__perm__:'
const OWNER_ACCOUNT = process.env.ERP_SUPER_ADMIN_ACCOUNT || '17747344571'

function parsePermissions(value) {
  try {
    if (typeof value === 'string') value = JSON.parse(value.startsWith(PERM_PREFIX) ? value.slice(PERM_PREFIX.length) : value)
    const keys = Array.isArray(value) ? value : value?.menus
    return Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : []
  } catch { return [] }
}

async function loadAccess(pool, id) {
  const { rows } = await pool.query(`SELECT id,account,name,avatar,role_id,role_name,dept_name,mobile,shop_id,status,remark
    FROM admins WHERE id=$1 AND deleted_at IS NULL`, [id])
  const user = rows[0]
  if (!user || Number(user.status) !== 1) return null
  const owner = user.account === OWNER_ACCOUNT || (Number(user.role_id || 0) === 0 && user.role_name === '超级管理员')
  let permissions = []
  if (owner) permissions = ['*']
  else if (Number(user.role_id) > 0) {
    const role = await pool.query('SELECT permissions,status FROM roles WHERE id=$1 AND shop_id=$2', [user.role_id,user.shop_id])
    if (Number(role.rows[0]?.status) === 1) permissions = parsePermissions(role.rows[0].permissions)
  } else if (user.role_name) {
    const role = await pool.query('SELECT permissions,status FROM roles WHERE name=$1 AND shop_id=$2 ORDER BY id LIMIT 1', [user.role_name,user.shop_id])
    if (role.rows[0]) {
      if (Number(role.rows[0].status) === 1) permissions = parsePermissions(role.rows[0].permissions)
    } else permissions = parsePermissions(user.remark)
  } else permissions = parsePermissions(user.remark)
  return { ...user, permissions, is_owner: owner, remark: PERM_PREFIX + JSON.stringify({ menus: permissions }) }
}

// Resource -> existing menu keys. Unknown endpoints fail closed for employees.
const resources = {
  '/goods/ShopGoods': ['goods-info'], '/goods/ShopGoodsCate': ['goods-info'],
  '/goods/ShopUnit': ['goods-unit'], '/goods/GoodsUnitConvert': ['goods-unit'],
  '/goods/ShopBrand': ['goods-brand'], '/goods/ShopSpec': ['goods-info'], '/goods/Bom': ['goods-bom'],
  '/shop/ShopCustomer': ['sale-client'], '/shop/ContractOrder': ['sale-contract'],
  '/shop/offerOrder': ['sale-offer'], '/shop/SampleOrder': ['sale-sample'],
  '/stock/PurchaseOrder': ['procure-order'], '/stock/SaleOutOrder': ['sale-out'], '/stock/SaleReturnOrder': ['sale-return'],
  '/stock/StockAll': ['warehouse-stock'], '/stock/InOutFlow': ['warehouse-flow'], '/stock/StockWarning': ['warehouse-warning'],
  '/stock/WarehouseName': ['warehouse-name'], '/stock/OtherOut': ['warehouse-other-out'], '/stock/OtherIn': ['warehouse-other-in'],
  '/stock/Allocation': ['warehouse-transfer'], '/stock/StockCheck': ['warehouse-check'],
  '/procure/supplier': ['procure-supplier'], '/procure/ProcurePlan': ['procure-plan'],
  '/procure/ProcureInhouse': ['procure-inhouse'], '/procure/ProcureReturn': ['procure-return'],
  '/finance/CollectAccounts': ['finance-receivable'], '/finance/PayAccounts': ['finance-payable'],
  '/finance/CollectReceipt': ['finance-collect-receipt'], '/finance/PayReceipt': ['finance-pay-receipt'],
  '/finance/Invoice': ['finance-invoice'], '/finance/Statement': ['finance-statement'],
  '/finance/Expense': ['finance-expense','finance-other-expense'], '/finance/Fund': ['finance-fund'],
  '/finance/FundFlow': ['finance-fund-flow','finance-income-expense-flow'], '/finance/Cost': ['finance-cost'],
  '/finance/Prepay': ['finance-prepay','finance-supplier-prepay'],
  '/retail/order': ['retail-order'], '/retail/member': ['retail-customer'], '/retail/store': ['retail-store'],
  '/retail/recharge': ['retail-recharge'], '/retail/return': ['retail-return'], '/retail/points': ['retail-points'],
  '/retail/coupon': ['retail-coupon'], '/retail/exhibition': ['retail-exhibition'],
  '/customer-level': ['sale-level'], '/distributor/withdraw': ['distributor-withdraw'], '/distributor': ['distributor'],
  '/mini/service': ['mini-service'], '/mini/orders': ['mini-orders'], '/mini/order': ['mini-orders'],
  '/mini/ship': ['mini-orders'], '/mini/coupons': ['retail-coupon'], '/mini/videos': ['mini-videos'],
  '/mini/video-token': ['mini-videos'], '/mini/qrcode': ['mini-qrcode'], '/refund': ['refund'],
}
const extraReads = {
  '/goods/ShopGoods': ['sale','procure','retail','warehouse','production'],
  '/goods/ShopGoodsCate': ['sale','procure','retail','warehouse'],
  '/goods/ShopUnit': ['sale','procure','retail','warehouse'],
  '/goods/GoodsUnitConvert': ['sale','procure','retail','warehouse'],
  '/stock/WarehouseName': ['sale','procure','retail','warehouse','production'],
  '/shop/ShopCustomer': ['sale','finance'], '/procure/supplier': ['procure','finance'],
  '/retail/store': ['retail'], '/retail/member': ['retail'],
  '/finance/Fund': ['finance','procure','sale','retail'],
  '/finance/PayReceipt': ['procure','finance-payable','retail-order','retail-exhibition'],
  '/finance/CollectReceipt': ['sale','finance-receivable'],
  '/shop/ContractOrder': ['finance-receivable'], '/stock/PurchaseOrder': ['finance-payable'],
}
function hasMenu(permissions, key) {
  const legacyGroup = key.startsWith('sale-client') ? 'customer' : key.startsWith('mini-') ? 'miniapp' : key.split('-')[0]
  return permissions.includes('*') || permissions.includes(key) || permissions.includes(legacyGroup)
}
function hasModule(permissions, module) {
  return permissions.some(p => p === module || p.startsWith(module + '-'))
}
function canAccess(user, method, rawPath) {
  if (user.is_owner) return true
  const path = rawPath.replace(/^\/adminapi(?=\/)/, '').replace(/\/+$/, '')
  if (['/auth/getUserInfo','/login/info','/login/logout'].includes(path)) return true
  // Role definitions are readable so an existing session can refresh its
  // permissions; all other settings and every mutation stay owner-only.
  if ((path === '/setting/role/index' || path === '/setting/admin/index') && (method === 'GET' || method === 'HEAD')) return true
  if (path.startsWith('/setting/')) return false
  const resource = Object.keys(resources).sort((a,b) => b.length-a.length).find(p => path === p || path.startsWith(p + '/'))
  if (!resource) return false
  const permissions = user.permissions || []
  if (resources[resource].some(key => hasMenu(permissions,key))) return true
  if (method === 'GET' || method === 'HEAD') {
    // These overview pages intentionally aggregate the business tables.
    if (['finance-overview','finance-profit','reports-overview','reports-profit','reports-finance'].some(k => hasMenu(permissions,k)) &&
      /^\/(finance|shop|stock|procure|retail)\//.test(resource)) return true
    if ((extraReads[resource] || []).some(key => key.includes('-') ? hasMenu(permissions,key) : hasModule(permissions,key))) return true
  }
  return false
}

module.exports = { loadAccess, canAccess, parsePermissions }
