#!/usr/bin/env node
/**
 * Upload product images to Qiniu and update ERP brand data.
 * Uses only built-in Node.js modules (no external dependencies).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ─── Config ────────────────────────────────────────────────────────────────
const QINIU_AK = '5Y3KQi2xwmjZG339-mPFwsrSHm1e5e9nZkoW46Gl';
const QINIU_SK = 'y8BmL62oTxlZSl38IC3pJFyiBO_5g6l6gU7vroYk';
const QINIU_BUCKET = 'nomad-videos';
const QINIU_UPLOAD_URL = 'https://up-z2.qiniup.com/';
const QINIU_ACCESS_DOMAIN = 'https://nomaderp.pages.dev/media/';

const ERP_BASE = 'https://erp-server-xsji.onrender.com';
const ERP_ACCOUNT = '17747344571';
const ERP_PASSWORD = 'Oral6421';

// ─── Product → File mapping ─────────────────────────────────────────────────
const BASE = "/Users/oralagborjigin/Desktop/new work /电商/牧区纯坊头图详情";

const PRODUCTS = [
  {
    id: 996,
    name: '青砖奶茶',
    headerDir: `${BASE}/茶`,
    headerFiles: ['头图画板 10.jpg', '头图画板 12.jpg', '头图画板 13.jpg', '头图画板 14.jpg', '头图画板 9 拷贝.jpg'],
    detailDir: `${BASE}/茶/images`,
    detailFiles: ['砖茶详情页_01.jpg', '砖茶详情页_02.jpg', '砖茶详情页_03.jpg', '砖茶详情页_04.jpg', '砖茶详情页_05.jpg'],
  },
  {
    id: 994,
    name: '冻炒米',
    headerDir: `${BASE}/冻炒米`,
    headerFiles: ['头图画板 1.jpg', '头图画板 2.jpg', '头图画板 3.jpg', '头图画板 4.jpg', '头图画板 5.jpg'],
    detailDir: `${BASE}/冻炒米/详情图`,
    detailFiles: Array.from({ length: 10 }, (_, i) => `冻炒米详情页_${String(i + 1).padStart(2, '0')}.jpg`),
  },
  {
    id: 992,
    name: '牧区奶豆腐盒装',
    headerDir: `${BASE}/奶果子/头图`,
    headerFiles: ['头图画板 15.jpg', '头图画板 16.jpg', '头图画板 18.jpg', '头图画板 19.jpg', '头图画板 9.jpg'],
    detailDir: `${BASE}/奶果子/images`,
    detailFiles: Array.from({ length: 13 }, (_, i) => `牧区奶豆腐详情页更新_${String(i + 1).padStart(2, '0')}.jpg`),
  },
  {
    id: 989,
    name: '蒙古黄油',
    headerDir: `${BASE}/黄油`,
    headerFiles: ['黄油主图画板 1.jpg', '黄油主图画板 2.jpg', '黄油主图画板 3.jpg', '黄油主图画板 4.jpg'],
    detailDir: null,
    detailFiles: [],
  },
  {
    id: 988,
    name: '原味传统奶豆腐袋装',
    headerDir: `${BASE}/传统奶豆腐`,
    headerFiles: ['头图画板 1.jpg', '头图画板 2.jpg', '头图画板 3.jpg', '头图画板 4.jpg', '头图画板 5.jpg', '头图画板 6.jpg'],
    detailDir: `${BASE}/传统奶豆腐/images`,
    detailFiles: Array.from({ length: 11 }, (_, i) => `详情页1_${String(i + 2).padStart(2, '0')}.jpg`),
  },
  {
    id: 1008,
    name: '甜味奶条',
    headerDir: `${BASE}/奶渣条`,
    headerFiles: ['头图画板 1 拷贝.jpg', '头图画板 3 拷贝.jpg', '头图画板 6.jpg', '头图画板 8.jpg'],
    detailDir: `${BASE}/奶渣条/详情页/images`,
    detailFiles: Array.from({ length: 13 }, (_, i) => `奶条详情页更新_${String(i + 1).padStart(2, '0')}.jpg`),
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function urlSafeBase64(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest();
}

/** Generate Qiniu upload token for a specific key */
function generateQiniuToken(key) {
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const putPolicy = JSON.stringify({
    scope: `${QINIU_BUCKET}:${key}`,
    deadline,
  });
  const encodedPolicy = urlSafeBase64(Buffer.from(putPolicy));
  const sign = hmacSha1(QINIU_SK, encodedPolicy);
  const encodedSign = urlSafeBase64(sign);
  return `${QINIU_AK}:${encodedSign}:${encodedPolicy}`;
}

/** HTTP request helper returning a Promise<{status, body}> */
function request(urlStr, options = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);

    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

/** ERP login, returns token string */
async function erpLogin() {
  console.log('\n[ERP] Logging in...');
  const bodyStr = JSON.stringify({ account: ERP_ACCOUNT, password: ERP_PASSWORD });
  const res = await request(`${ERP_BASE}/adminapi/login/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  const data = JSON.parse(res.body);
  if (!data.data || !data.data.token) {
    throw new Error('Login failed: ' + res.body);
  }
  console.log('[ERP] Login successful, token:', data.data.token.substring(0, 20) + '...');
  return data.data.token;
}

/** GET current goods data (to read existing remark) */
async function getGoodsDetail(token, id) {
  const res = await request(
    `${ERP_BASE}/adminapi/goods/ShopGoods/index?page=1&limit=100`,
    { method: 'GET', headers: { token } }
  );
  const data = JSON.parse(res.body);
  const list = data.data && data.data.list ? data.data.list : [];
  const item = list.find(g => g.id === id || g.id === String(id));
  return item || null;
}

/** Upload a single file to Qiniu via multipart form upload */
function uploadToQiniu(filePath, key) {
  return new Promise((resolve, reject) => {
    const token = generateQiniuToken(key);
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----QiniuBoundary' + Date.now();

    const parts = [];
    // field: token
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n`
    );
    // field: key
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${key}\r\n`
    );
    // file
    const fileName = path.basename(filePath);
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(parts.join('') + fileHeader, 'utf8');
    const footerBuf = Buffer.from(fileFooter, 'utf8');
    const bodyBuf = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

    const parsed = new URL(QINIU_UPLOAD_URL);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          const data = JSON.parse(body);
          resolve(data.key || key);
        } else {
          reject(new Error(`Qiniu upload failed [${res.statusCode}]: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** Update ERP goods remark, merging brand data */
async function updateGoodsBrand(token, id, name, mergeData, existingGoods) {
  // Parse existing remark
  let existingRemark = {};
  try {
    if (existingGoods && existingGoods.remark) {
      existingRemark = JSON.parse(existingGoods.remark);
    }
  } catch (e) {
    console.warn(`[ERP] Could not parse existing remark for ID ${id}, starting fresh`);
  }

  // Merge __brand__ fields
  const existingBrand = existingRemark.__brand__ || {};
  const mergedBrand = {
    ...existingBrand,   // preserve: show, category, tags, etc.
    ...mergeData,       // add: image, headerImages, detailImages
  };

  const newRemark = JSON.stringify({
    ...existingRemark,
    __brand__: mergedBrand,
  });

  console.log(`[ERP] Updating ID ${id} (${name}) remark...`);

  const bodyStr = JSON.stringify({ id, remark: newRemark });
  const res = await request(`${ERP_BASE}/adminapi/goods/ShopGoods/edit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      token,
    },
  }, bodyStr);

  const data = JSON.parse(res.body);
  if (data.code === 1 || data.status === 1 || res.status === 200) {
    console.log(`[ERP] ID ${id} updated successfully`);
    return true;
  } else {
    console.error(`[ERP] ID ${id} update failed:`, res.body);
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const results = [];

  // 1. Login to ERP
  const erpToken = await erpLogin();

  for (const product of PRODUCTS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ID ${product.id} - ${product.name}`);
    console.log('='.repeat(60));

    const productResult = {
      id: product.id,
      name: product.name,
      headerUploaded: [],
      detailUploaded: [],
      erpUpdated: false,
      errors: [],
    };

    // 2. Get existing goods data
    let existingGoods = null;
    try {
      existingGoods = await getGoodsDetail(erpToken, product.id);
      if (existingGoods) {
        console.log(`[ERP] Found goods ID ${product.id}, current remark: ${existingGoods.remark}`);
      } else {
        console.warn(`[ERP] Goods ID ${product.id} not found in list, will still attempt update`);
      }
    } catch (e) {
      console.warn(`[ERP] Could not fetch goods list: ${e.message}`);
    }

    // 3. Upload header images
    console.log(`\n[Qiniu] Uploading ${product.headerFiles.length} header images...`);
    for (let i = 0; i < product.headerFiles.length; i++) {
      const fileName = product.headerFiles[i];
      const filePath = path.join(product.headerDir, fileName);
      const key = `goods/${product.id}/header_${i + 1}.jpg`;

      if (!fs.existsSync(filePath)) {
        const err = `File not found: ${filePath}`;
        console.error(`  [SKIP] ${err}`);
        productResult.errors.push(err);
        continue;
      }

      try {
        const uploadedKey = await uploadToQiniu(filePath, key);
        const url = `${QINIU_ACCESS_DOMAIN}${uploadedKey}`;
        productResult.headerUploaded.push(url);
        console.log(`  [OK] ${fileName} → ${url}`);
      } catch (e) {
        const err = `Upload failed for ${fileName}: ${e.message}`;
        console.error(`  [FAIL] ${err}`);
        productResult.errors.push(err);
      }
    }

    // 4. Upload detail images
    if (product.detailFiles.length > 0) {
      console.log(`\n[Qiniu] Uploading ${product.detailFiles.length} detail images...`);
      for (let i = 0; i < product.detailFiles.length; i++) {
        const fileName = product.detailFiles[i];
        const filePath = path.join(product.detailDir, fileName);
        const key = `goods/${product.id}/detail_${i + 1}.jpg`;

        if (!fs.existsSync(filePath)) {
          const err = `File not found: ${filePath}`;
          console.error(`  [SKIP] ${err}`);
          productResult.errors.push(err);
          continue;
        }

        try {
          const uploadedKey = await uploadToQiniu(filePath, key);
          const url = `${QINIU_ACCESS_DOMAIN}${uploadedKey}`;
          productResult.detailUploaded.push(url);
          console.log(`  [OK] ${fileName} → ${url}`);
        } catch (e) {
          const err = `Upload failed for ${fileName}: ${e.message}`;
          console.error(`  [FAIL] ${err}`);
          productResult.errors.push(err);
        }
      }
    }

    // 5. Merge and update ERP
    const mergeData = {};
    if (productResult.headerUploaded.length > 0) {
      mergeData.image = productResult.headerUploaded[0]; // first header = main image
      mergeData.headerImages = productResult.headerUploaded;
    }
    if (productResult.detailUploaded.length > 0) {
      mergeData.detailImages = productResult.detailUploaded;
    }

    if (Object.keys(mergeData).length > 0) {
      try {
        productResult.erpUpdated = await updateGoodsBrand(erpToken, product.id, product.name, mergeData, existingGoods);
      } catch (e) {
        const err = `ERP update failed: ${e.message}`;
        console.error(`[ERP] ${err}`);
        productResult.errors.push(err);
      }
    } else {
      console.warn(`[ERP] No images uploaded for ID ${product.id}, skipping ERP update`);
    }

    results.push(productResult);
  }

  // ─── Summary Report ────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('FINAL SUMMARY');
  console.log('='.repeat(60));

  for (const r of results) {
    const status = r.erpUpdated ? '✓' : '✗';
    console.log(`\n${status} ID ${r.id} - ${r.name}`);
    console.log(`  Header images uploaded : ${r.headerUploaded.length}`);
    console.log(`  Detail images uploaded : ${r.detailUploaded.length}`);
    console.log(`  ERP updated            : ${r.erpUpdated}`);
    if (r.headerUploaded.length > 0) {
      console.log(`  Main image URL         : ${r.headerUploaded[0]}`);
    }
    if (r.errors.length > 0) {
      console.log(`  Errors (${r.errors.length}):`);
      r.errors.forEach(e => console.log(`    - ${e}`));
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
