-- 小程序用户表
CREATE TABLE IF NOT EXISTS mini_users (
  id SERIAL PRIMARY KEY,
  openid VARCHAR(64) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

-- 小程序订单表
CREATE TABLE IF NOT EXISTS mini_orders (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(32) UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES mini_users(id),
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  address JSONB,
  remark TEXT DEFAULT '',
  status SMALLINT DEFAULT 0,  -- 0待付款 1待发货 2已发货 3已完成 4已取消
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

-- 小程序订单商品表
CREATE TABLE IF NOT EXISTS mini_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES mini_orders(id),
  goods_id INTEGER,
  goods_name VARCHAR(128) NOT NULL,
  spec VARCHAR(64) DEFAULT '',
  price DECIMAL(10,2) NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_mini_orders_user ON mini_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_mini_order_items_order ON mini_order_items(order_id);
