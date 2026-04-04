const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
})

// 初始化所有表
async function initDb() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL DEFAULT '',
        account VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        avatar VARCHAR(500) DEFAULT '',
        role_name VARCHAR(50) DEFAULT '管理员',
        role_id INT DEFAULT 0,
        dept_name VARCHAR(100) DEFAULT '',
        dept_id INT DEFAULT 0,
        mobile VARCHAR(20) DEFAULT '',
        email VARCHAR(100) DEFAULT '',
        status INT DEFAULT 1,
        remark TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS goods (
        id SERIAL PRIMARY KEY,
        goods_name VARCHAR(200) NOT NULL DEFAULT '',
        goods_sn VARCHAR(100) DEFAULT '',
        en_name VARCHAR(200) DEFAULT '',
        goods_memo VARCHAR(200) DEFAULT '',
        goods_type INT DEFAULT 1,
        cate_id INT DEFAULT 0, cate_name VARCHAR(100) DEFAULT '',
        unit_id INT DEFAULT 0, unit_name VARCHAR(50) DEFAULT '',
        brand_id INT DEFAULT 0, brand_name VARCHAR(100) DEFAULT '',
        spec TEXT DEFAULT '',
        sell_price DECIMAL(10,2) DEFAULT 0,
        cost_price DECIMAL(10,2) DEFAULT 0,
        barcode VARCHAR(100) DEFAULT '',
        safe_min INT DEFAULT 0, safe_max INT DEFAULT 0,
        sort INT DEFAULT 0, make_time INT DEFAULT 0,
        can_sale INT DEFAULT 1, can_buy INT DEFAULT 1, can_make INT DEFAULT 1, can_outsource INT DEFAULT 1,
        multi_unit BOOLEAN DEFAULT FALSE, multi_spec BOOLEAN DEFAULT FALSE,
        stock INT DEFAULT 0, min_stock INT DEFAULT 0, max_stock INT DEFAULT 0,
        remark TEXT DEFAULT '', status INT DEFAULT 1, images TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT NOW(), update_time TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS goods_cate (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, parent_id INT DEFAULT 0, sort INT DEFAULT 0, status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS goods_unit (id SERIAL PRIMARY KEY, name VARCHAR(50) NOT NULL, status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS goods_unit_convert (id SERIAL PRIMARY KEY, goods_id INT NOT NULL, unit_name VARCHAR(50) NOT NULL, ratio DECIMAL(10,4) NOT NULL DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS goods_brand (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS goods_spec (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, values TEXT DEFAULT '', status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS sale_customers (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL DEFAULT '', nickname VARCHAR(100) DEFAULT '',
        code VARCHAR(100) DEFAULT '', mobile VARCHAR(20) DEFAULT '', tel VARCHAR(20) DEFAULT '',
        email VARCHAR(100) DEFAULT '', address TEXT DEFAULT '', contact VARCHAR(100) DEFAULT '',
        level_name VARCHAR(50) DEFAULT '普通客户', source_name VARCHAR(50) DEFAULT '',
        level_id INT DEFAULT 0, source_id INT DEFAULT 0, follow_admin_id INT DEFAULT 0,
        follow_admin VARCHAR(50) DEFAULT '', balance DECIMAL(10,2) DEFAULT 0,
        is_sea INT DEFAULT 0, remark TEXT DEFAULT '', status INT DEFAULT 1,
        create_time TIMESTAMP DEFAULT NOW(), update_time TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS supplier (
        id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, contact VARCHAR(100) DEFAULT '',
        mobile VARCHAR(20) DEFAULT '', email VARCHAR(100) DEFAULT '', address TEXT DEFAULT '',
        bank VARCHAR(100) DEFAULT '', bank_account VARCHAR(100) DEFAULT '',
        remark TEXT DEFAULT '', status INT DEFAULT 1,
        create_time TIMESTAMP DEFAULT NOW(), update_time TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS purchase_order (
        id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '',
        supplier_id INT DEFAULT 0, supplier_name VARCHAR(200) DEFAULT '',
        admin_name VARCHAR(100) DEFAULT '', order_date DATE,
        total_amount DECIMAL(10,2) DEFAULT 0, pay_amount DECIMAL(10,2) DEFAULT 0,
        freight_amount DECIMAL(10,2) DEFAULT 0, goods_info JSONB DEFAULT '[]',
        remark TEXT DEFAULT '', status INT DEFAULT 0,
        warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '',
        fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS procure_inhouse (
        id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', purchase_order_id INT DEFAULT 0,
        supplier_id INT DEFAULT 0, supplier_name VARCHAR(200) DEFAULT '',
        admin_name VARCHAR(100) DEFAULT '', in_date DATE,
        goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0,
        warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS procure_plan (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', plan_date DATE, goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, admin_name VARCHAR(100) DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS procure_return (
        id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '',
        order_id INT DEFAULT 0, supplier_id INT DEFAULT 0, supplier_name VARCHAR(200) DEFAULT '',
        admin_name VARCHAR(100) DEFAULT '', return_date DATE,
        total_amount DECIMAL(10,2) DEFAULT 0,
        goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0,
        warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '',
        fund_id INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      -- 补已有数据库缺少的列（幂等）
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS order_sn VARCHAR(100) DEFAULT '';
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS order_id INT DEFAULT 0;
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100) DEFAULT '';
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS total_amount DECIMAL(10,2) DEFAULT 0;
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS warehouse_id INT DEFAULT 0;
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS warehouse_name VARCHAR(100) DEFAULT '';
      ALTER TABLE procure_return ADD COLUMN IF NOT EXISTS fund_id INT DEFAULT 0;

      CREATE TABLE IF NOT EXISTS sale_contracts (
        id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '',
        customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '',
        admin_name VARCHAR(100) DEFAULT '', order_date DATE,
        total_amount DECIMAL(10,2) DEFAULT 0, pay_amount DECIMAL(10,2) DEFAULT 0,
        goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sale_offers (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', admin_name VARCHAR(100) DEFAULT '', offer_date DATE, total_amount DECIMAL(10,2) DEFAULT 0, goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sale_out_order (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', admin_name VARCHAR(100) DEFAULT '', out_date DATE, total_amount DECIMAL(10,2) DEFAULT 0, goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sale_return_order (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', return_date DATE, goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);

      CREATE TABLE IF NOT EXISTS finance_funds (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, fund_type INT DEFAULT 1, balance DECIMAL(10,2) DEFAULT 0, bank_name VARCHAR(100) DEFAULT '', bank_account VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW(), update_time TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS collect_receipt (id SERIAL PRIMARY KEY, receipt_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', contact_name VARCHAR(100) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, receipt_date DATE, pay_type VARCHAR(50) DEFAULT 'customer', fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS pay_receipt (id SERIAL PRIMARY KEY, receipt_no VARCHAR(100) DEFAULT '', order_sn VARCHAR(100) DEFAULT '', contact_type VARCHAR(50) DEFAULT 'supplier', contact_name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, pay_date DATE, fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS finance_invoices (id SERIAL PRIMARY KEY, invoice_no VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, invoice_date DATE, type INT DEFAULT 1, remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS finance_statements (id SERIAL PRIMARY KEY, statement_no VARCHAR(100) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, start_date DATE, end_date DATE, remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS finance_expenses (id SERIAL PRIMARY KEY, expense_no VARCHAR(100) DEFAULT '', name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, expense_date DATE, fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS finance_costs (id SERIAL PRIMARY KEY, cost_no VARCHAR(100) DEFAULT '', name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, cost_date DATE, remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP);
      CREATE TABLE IF NOT EXISTS prepay_record (id SERIAL PRIMARY KEY, order_sn VARCHAR(100) DEFAULT '', pay_type VARCHAR(50) DEFAULT 'customer', supplier_id INT DEFAULT 0, supplier_name VARCHAR(200) DEFAULT '', customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, pay_date DATE, fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '', admin_name VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS finance_receivable (id SERIAL PRIMARY KEY, customer_id INT DEFAULT 0, customer_name VARCHAR(200) DEFAULT '', order_sn VARCHAR(100) DEFAULT '', total_amount DECIMAL(10,2) DEFAULT 0, paid_amount DECIMAL(10,2) DEFAULT 0, un_pay_amount DECIMAL(10,2) DEFAULT 0, due_date DATE, status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS finance_payable (id SERIAL PRIMARY KEY, supplier_id INT DEFAULT 0, supplier_name VARCHAR(200) DEFAULT '', order_sn VARCHAR(100) DEFAULT '', order_amount DECIMAL(10,2) DEFAULT 0, paid_amount DECIMAL(10,2) DEFAULT 0, un_pay_amount DECIMAL(10,2) DEFAULT 0, due_date DATE, status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS stock_inventory (id SERIAL PRIMARY KEY, goods_id INT DEFAULT 0, goods_name VARCHAR(200) DEFAULT '', goods_code VARCHAR(100) DEFAULT '', unit_name VARCHAR(50) DEFAULT '', warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', qty INT DEFAULT 0, cost DECIMAL(10,2) DEFAULT 0, update_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS warehouses (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, address TEXT DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, create_time TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS stock_flow (id SERIAL PRIMARY KEY, goods_id INT DEFAULT 0, goods_name VARCHAR(200) DEFAULT '', warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', type VARCHAR(50) DEFAULT '', qty INT DEFAULT 0, before_qty INT DEFAULT 0, after_qty INT DEFAULT 0, order_no VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS stock_checks (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, admin_name VARCHAR(100) DEFAULT '', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS stock_other_in (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS stock_other_out (id SERIAL PRIMARY KEY, order_no VARCHAR(100) DEFAULT '', warehouse_id INT DEFAULT 0, warehouse_name VARCHAR(100) DEFAULT '', goods_info JSONB DEFAULT '[]', remark TEXT DEFAULT '', status INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS retail_members (id SERIAL PRIMARY KEY, name VARCHAR(100) DEFAULT '', mobile VARCHAR(20) DEFAULT '', gender INT DEFAULT 0, birthday DATE, balance DECIMAL(10,2) DEFAULT 0, points INT DEFAULT 0, level VARCHAR(50) DEFAULT '普通会员', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS retail_orders (id SERIAL PRIMARY KEY, order_sn VARCHAR(100) DEFAULT '', member_id INT DEFAULT 0, member_name VARCHAR(100) DEFAULT '', goods_info JSONB DEFAULT '[]', total_amount DECIMAL(10,2) DEFAULT 0, pay_amount DECIMAL(10,2) DEFAULT 0, pay_type VARCHAR(50) DEFAULT '', order_date DATE, remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS retail_recharge (id SERIAL PRIMARY KEY, recharge_no VARCHAR(100) DEFAULT '', member_id INT DEFAULT 0, member_name VARCHAR(100) DEFAULT '', amount DECIMAL(10,2) DEFAULT 0, fund_id INT DEFAULT 0, fund_name VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS staff (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(50) DEFAULT '', mobile VARCHAR(20) DEFAULT '', email VARCHAR(100) DEFAULT '', dept_id INT DEFAULT 0, dept_name VARCHAR(100) DEFAULT '', job_id INT DEFAULT 0, job_name VARCHAR(100) DEFAULT '', entry_date DATE, gender INT DEFAULT 1, status INT DEFAULT 1, remark TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS depts (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, parent_id INT DEFAULT 0, sort INT DEFAULT 0, status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS roles (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, permissions TEXT DEFAULT '', status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS jobs (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, dept_id INT DEFAULT 0, status INT DEFAULT 1, created_at TIMESTAMP DEFAULT NOW());

      CREATE TABLE IF NOT EXISTS sys_params (id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE, value TEXT DEFAULT '', remark TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS operation_logs (id SERIAL PRIMARY KEY, admin_id INT DEFAULT 0, admin_name VARCHAR(100) DEFAULT '', action VARCHAR(200) DEFAULT '', ip VARCHAR(50) DEFAULT '', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS company_info (id SERIAL PRIMARY KEY, name VARCHAR(200) DEFAULT '', logo VARCHAR(500) DEFAULT '', address TEXT DEFAULT '', tel VARCHAR(50) DEFAULT '', email VARCHAR(100) DEFAULT '', remark TEXT DEFAULT '');

      INSERT INTO admins (name, account, password, role_name) VALUES ('管理员', 'admin', '123456', '超级管理员') ON CONFLICT (account) DO NOTHING;
      INSERT INTO warehouses (name) VALUES ('默认仓库') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS bom_order (
        id SERIAL PRIMARY KEY,
        bom_code VARCHAR(50) DEFAULT '',
        goods_id INT DEFAULT 0,
        goods_name VARCHAR(200) DEFAULT '',
        goods_sn VARCHAR(100) DEFAULT '',
        spec VARCHAR(200) DEFAULT '',
        unit_name VARCHAR(50) DEFAULT '',
        remark TEXT DEFAULT '',
        status INT DEFAULT 1,
        create_time TIMESTAMP DEFAULT NOW(),
        update_time TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bom_items (
        id SERIAL PRIMARY KEY,
        bom_id INT NOT NULL,
        goods_id INT DEFAULT 0,
        goods_name VARCHAR(200) DEFAULT '',
        goods_sn VARCHAR(100) DEFAULT '',
        num DECIMAL(10,4) DEFAULT 1,
        unit_name VARCHAR(50) DEFAULT '',
        price DECIMAL(10,5) DEFAULT 0,
        remark TEXT DEFAULT '',
        create_time TIMESTAMP DEFAULT NOW()
      );
    `)
    // 兼容旧数据库：补加 goods 表缺失列
    const goodsAlters = [
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS goods_name VARCHAR(200) NOT NULL DEFAULT ''",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS goods_sn VARCHAR(100) DEFAULT ''",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS en_name VARCHAR(200) DEFAULT ''",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS goods_memo VARCHAR(200) DEFAULT ''",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS goods_type INT DEFAULT 1",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS sell_price DECIMAL(10,2) DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2) DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS barcode VARCHAR(100) DEFAULT ''",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS safe_min INT DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS safe_max INT DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS sort INT DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS make_time INT DEFAULT 0",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS can_sale INT DEFAULT 1",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS can_buy INT DEFAULT 1",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS can_make INT DEFAULT 1",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS can_outsource INT DEFAULT 1",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS multi_unit BOOLEAN DEFAULT FALSE",
      "ALTER TABLE goods ADD COLUMN IF NOT EXISTS multi_spec BOOLEAN DEFAULT FALSE",
      // 旧表 name/code 列有 NOT NULL 约束，去掉以免 INSERT 报错
      "ALTER TABLE goods ALTER COLUMN name DROP NOT NULL",
      "ALTER TABLE goods ALTER COLUMN name SET DEFAULT ''",
    ]
    for (const sql of goodsAlters) {
      await client.query(sql).catch(() => {})
    }
    // 补加 category 字段（幂等）
    await client.query("ALTER TABLE pay_receipt ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT ''").catch(() => {})
    await client.query("ALTER TABLE collect_receipt ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT ''").catch(() => {})
    console.log('Database initialized successfully')
  } finally {
    client.release()
  }
}

module.exports = { pool, initDb }

