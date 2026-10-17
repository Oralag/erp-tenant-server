const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { canAccess } = require('../src/adminPermissions')

const employee = { id: 638, shop_id: 1, is_owner: false, permissions: ['goods-info'] }
const source = fs.readFileSync(require.resolve('../src/index'), 'utf8')
const start = source.indexOf("app.use('/adminapi', async (req, res, next) => {")
assert.ok(start >= 0)
const end = source.indexOf('\n})', start) + 3
const scopeStart = source.indexOf('const ADMIN_SCOPED_TABLES =')
const scopeEnd = source.indexOf('\nfunction ok(', scopeStart)

async function checkDataAccess({ path = '/goods/ShopGoods/patchBrand', method = 'POST', body, row = {}, user = employee }) {
  let middleware
  let passed = false
  let error
  const record = { id: 10, shop_id: 1, admin_id: 999, deleted_at: null, ...row }
  const pool = { async query(sql, args) {
    assert.match(sql, /WHERE id=ANY\(\$1::int\[\]\) AND shop_id=\$2/)
    const [ids, shopId, adminId] = args
    const matched = ids.includes(record.id) && shopId === record.shop_id
      && (!sql.includes('admin_id=$3') || adminId === record.admin_id)
      && (!sql.includes('deleted_at IS NULL') || record.deleted_at === null)
    return { rows: [{ count: matched ? 1 : 0 }] }
  } }
  const context = vm.createContext({
    app: { use(_path, fn) { middleware = fn } }, pool,
    ensureAdminCols: async () => {},
    fail(_res, message, status) { error = { message, status } },
  })
  vm.runInContext(source.slice(scopeStart, scopeEnd) + '\n' + source.slice(start, end), context)
  await middleware({ path, method, body, admin: user, query: {} }, {}, () => { passed = true })
  return { passed, error }
}

test('商品资料权限可读取品牌、单位、换算和 BOM 依赖，但不能修改这些档案', () => {
  for (const resource of ['ShopBrand', 'ShopUnit', 'GoodsUnitConvert', 'BomGoods']) {
    assert.equal(canAccess(employee, 'GET', `/goods/${resource}/index`), true, resource)
    assert.equal(canAccess(employee, 'POST', `/goods/${resource}/edit`), false, resource)
  }
  assert.equal(canAccess({ ...employee, permissions: ['goods-bom'] }, 'POST', '/goods/BomGoods/edit'), true)
})

test('只有商品管理角色能保存展示开关，销售只读角色不能写', () => {
  assert.equal(canAccess(employee, 'POST', '/goods/ShopGoods/patchBrand'), true)
  for (const permissions of [[], ['sale-contract'], ['procure-order']]) {
    assert.equal(canAccess({ ...employee, permissions }, 'POST', '/goods/ShopGoods/patchBrand'), false)
  }
})

test('同店其他员工创建的商品允许开关品牌/外卖', async () => {
  for (const brand_fields of [{ show: true }, { show: false }, { delivery: true, deliveryOff: false }, { delivery: false, deliveryOff: true }]) {
    assert.equal((await checkDataAccess({ body: { id: 10, brand_fields } })).passed, true)
  }
})

test('跨店、已删除、不存在商品仍拒绝', async () => {
  for (const row of [{ shop_id: 2 }, { deleted_at: '2026-10-17' }, { id: 11 }]) {
    const result = await checkDataAccess({ body: { id: 10, brand_fields: { show: true } }, row })
    assert.equal(result.passed, false)
    assert.equal(result.error.status, 403)
  }
})

test('不能借展示接口修改他人图片、价格、其他品牌字段或伪造归属', async () => {
  for (const brand_fields of [{ image: 'changed' }, { show: true, wholesalePrice: 1 }, { show: 'true' }, {}, []]) {
    assert.equal((await checkDataAccess({ body: { id: 10, brand_fields } })).passed, false)
  }
  assert.equal((await checkDataAccess({ body: { id: 10, shop_id: 2, brand_fields: { show: true } } })).passed, false)
})

test('其他商品编辑、删除和业务记录仍按录入人隔离', async () => {
  for (const path of ['/goods/ShopGoods/edit', '/goods/ShopGoods/del', '/shop/ContractOrder/edit']) {
    assert.equal((await checkDataAccess({ path, body: { id: 10, brand_fields: { show: true } } })).passed, false)
  }
  assert.equal((await checkDataAccess({ body: { id: 10, brand_fields: { image: 'own-image' } }, row: { admin_id: 638 } })).passed, true)
})

test('共享客户、供应商、资金和商品的详情仍可读取', async () => {
  for (const path of ['/goods/ShopGoods/detail', '/shop/ShopCustomer/detail', '/procure/supplier/detail', '/finance/Fund/detail']) {
    assert.equal((await checkDataAccess({ path, method: 'GET' })).passed, true)
  }
})
