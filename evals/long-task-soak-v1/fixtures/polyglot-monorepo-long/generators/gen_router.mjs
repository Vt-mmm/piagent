#!/usr/bin/env node
// Deterministic generator for services/web-js/src/legacy/router-old.js (p5) and
// its hidden golden request/response file. Not part of the member's repo.
//
//   node gen_router.mjs <fixture dir>
//
// Writes project/services/web-js/src/legacy/router-old.js, then imports it and
// records hidden-p5/.soak/p5/golden.json from a fixed request list.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const here = import.meta.dirname;

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20251021);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = list => list[Math.floor(rand() * list.length)];
const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ---- categories
const CATEGORIES = [
  ['tea', 'Trà', 'Tea'], ['teaware', 'Ấm chén', 'Teaware'], ['snack', 'Bánh mứt', 'Snacks'],
  ['gift', 'Quà tặng', 'Gift sets'], ['merch', 'Đồ lưu niệm', 'Merchandise'], ['subscription', 'Gói định kỳ', 'Subscriptions'],
];

// ---- products
const WORDS = {
  tea: [['Trà xanh Thái Nguyên', 'Thai Nguyen green tea'], ['Trà Shan tuyết Hà Giang', 'Ha Giang Shan tuyet tea'], ['Trà ô long Lâm Đồng', 'Lam Dong oolong'], ['Trà sen Tây Hồ', 'West Lake lotus tea'], ['Trà nhài', 'Jasmine tea'], ['Trà atisô Đà Lạt', 'Da Lat artichoke tea'], ['Hồng trà Mộc Châu', 'Moc Chau black tea'], ['Trà gạo lứt', 'Brown rice tea'], ['Trà lài thượng hạng', 'Premium jasmine'], ['Bạch trà Suối Giàng', 'Suoi Giang white tea']],
  teaware: [['Ấm tử sa', 'Yixing clay teapot'], ['Bộ chén Bát Tràng', 'Bat Trang cup set'], ['Khay trà gỗ', 'Wooden tea tray'], ['Bình giữ nhiệt', 'Thermos'], ['Lọc trà inox', 'Steel tea strainer'], ['Chén tống thủy tinh', 'Glass pitcher']],
  snack: [['Mứt gừng', 'Ginger candy'], ['Bánh đậu xanh Hải Dương', 'Hai Duong mung bean cake'], ['Hạt sen sấy', 'Dried lotus seeds'], ['Ô mai mơ', 'Apricot o mai'], ['Kẹo lạc', 'Peanut brittle'], ['Bánh cốm', 'Green rice cake']],
  gift: [['Hộp quà Tết', 'Tet gift box'], ['Giỏ quà doanh nghiệp', 'Corporate hamper'], ['Hộp quà Trung thu', 'Mid-autumn box'], ['Set trà và bánh', 'Tea and cake set']],
  merch: [['Túi vải shopflow', 'shopflow tote'], ['Áo thun Trà Quán', 'Tea house T-shirt'], ['Sổ tay thưởng trà', 'Tea tasting notebook'], ['Móc khóa ấm trà', 'Teapot keychain']],
  subscription: [['Gói trà hằng tháng', 'Monthly tea box'], ['Gói trà quý', 'Quarterly tea box'], ['Gói khám phá', 'Discovery plan']],
};
const SIZES = ['50g', '100g', '200g', '500g', 'hộp nhỏ', 'hộp lớn', 'bản đặc biệt', 'loại 1', 'loại 2'];
const TAGS = ['organic', 'bestseller', 'new', 'gift', 'north', 'south', 'central', 'premium', 'budget', 'seasonal', 'limited', 'handmade'];
const PREFIX = { tea: 'TEA', teaware: 'WAR', snack: 'SNK', gift: 'GFT', merch: 'MER', subscription: 'SUB' };
const products = [];
const counter = {};
for (let i = 0; i < 180; i++) {
  const category = i < 70 ? 'tea' : i < 100 ? 'teaware' : i < 130 ? 'snack' : i < 150 ? 'gift' : i < 168 ? 'merch' : 'subscription';
  counter[category] = (counter[category] ?? 0) + 1;
  const [vi, en] = pick(WORDS[category]);
  const size = pick(SIZES);
  const tags = [...new Set(Array.from({ length: int(1, 3) }, () => pick(TAGS)))].sort();
  products.push({
    sku: `${PREFIX[category]}-${String(counter[category]).padStart(3, '0')}`,
    name: `${vi} ${size}`,
    name_en: rand() < 0.7 ? `${en} ${size.replace('hộp nhỏ', 'small box').replace('hộp lớn', 'large box').replace('bản đặc biệt', 'special edition').replace('loại', 'grade')}` : null,
    category,
    price: int(3, 450) * 1000 + (rand() < 0.15 ? 500 : 0),
    stock: rand() < 0.1 ? 0 : int(1, 140),
    active: rand() < 0.9,
    weight: int(1, 50) * 50,
    tags,
  });
}
// a few names starting lowercase/uppercase to exercise sort=name case sensitivity
products[5].name = 'trà mạn hảo hạng 100g';
products[77].name = 'ấm đất nung 1 lít';
products[120].name = 'BÁNH PÍA SÓC TRĂNG hộp lớn';

// ---- provinces
const PROVINCE_NAMES = ['Hà Nội', 'Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'An Giang', 'Bà Rịa - Vũng Tàu', 'Bắc Giang', 'Bắc Kạn', 'Bạc Liêu', 'Bắc Ninh', 'Bến Tre', 'Bình Định', 'Bình Dương', 'Bình Phước', 'Bình Thuận', 'Cà Mau', 'Cao Bằng', 'Đắk Lắk', 'Đắk Nông', 'Điện Biên', 'Đồng Nai', 'Đồng Tháp', 'Gia Lai', 'Hà Giang', 'Hà Nam', 'Hà Tĩnh', 'Hải Dương', 'Hậu Giang', 'Hòa Bình', 'Hưng Yên', 'Khánh Hòa', 'Kiên Giang', 'Kon Tum', 'Lai Châu', 'Lâm Đồng', 'Lạng Sơn', 'Lào Cai', 'Long An', 'Nam Định', 'Nghệ An', 'Ninh Bình', 'Ninh Thuận', 'Phú Thọ', 'Phú Yên', 'Quảng Bình', 'Quảng Nam', 'Quảng Ngãi', 'Quảng Ninh', 'Quảng Trị', 'Sóc Trăng', 'Sơn La', 'Tây Ninh', 'Thái Bình', 'Thái Nguyên', 'Thanh Hóa', 'Thừa Thiên Huế', 'Tiền Giang', 'Trà Vinh', 'Tuyên Quang', 'Vĩnh Long', 'Vĩnh Phúc', 'Yên Bái'];
const REMOTE = new Set(['Hà Giang', 'Cao Bằng', 'Điện Biên', 'Lai Châu', 'Kon Tum', 'Cà Mau', 'Bắc Kạn', 'Sơn La']);
const ZONE_A = new Set(['Hà Nội', 'Hồ Chí Minh']);
const ZONE_B = new Set(['Hải Phòng', 'Bắc Ninh', 'Hưng Yên', 'Hải Dương', 'Vĩnh Phúc', 'Bình Dương', 'Đồng Nai', 'Long An', 'Bà Rịa - Vũng Tàu', 'Tây Ninh', 'Hà Nam', 'Thái Nguyên', 'Bắc Giang', 'Phú Thọ', 'Tiền Giang', 'Cần Thơ', 'Đà Nẵng']);
const CITY_CODES = { 'Hà Nội': 'HN', 'Hồ Chí Minh': 'SG', 'Đà Nẵng': 'DN', 'Hải Phòng': 'HP', 'Cần Thơ': 'CT' };
let provinceNo = 0;
const provinces = PROVINCE_NAMES.map(name => {
  const code = CITY_CODES[name] ?? String(++provinceNo).padStart(2, '0');
  const zone = ZONE_A.has(name) ? 'A' : ZONE_B.has(name) ? 'B' : REMOTE.has(name) ? 'D' : rand() < 0.6 ? 'C' : 'B';
  return { code: `VN-${code}`, name, zone, remote: REMOTE.has(name) };
});

// ---- promos
const promos = [
  { code: 'WELCOME50K', kind: 'fixed', value: 50000, min_subtotal: 300000, max_discount: 0, category: null, expired: false },
  { code: 'TET2025', kind: 'percent', value: 12, min_subtotal: 500000, max_discount: 150000, category: null, expired: true },
  { code: 'TET2026', kind: 'percent', value: 12, min_subtotal: 500000, max_discount: 150000, category: null, expired: false },
  { code: 'FREESHIP', kind: 'freeship', value: 0, min_subtotal: 200000, max_discount: 0, category: null, expired: false },
  { code: 'TEAONLY15', kind: 'percent', value: 15, min_subtotal: 0, max_discount: 80000, category: 'tea', expired: false },
  { code: 'GIFT100K', kind: 'fixed', value: 100000, min_subtotal: 800000, max_discount: 0, category: 'gift', expired: false },
  { code: 'SNACK5', kind: 'percent', value: 5, min_subtotal: 0, max_discount: 0, category: 'snack', expired: false },
  { code: 'BIGSALE30', kind: 'percent', value: 30, min_subtotal: 2000000, max_discount: 500000, category: null, expired: false },
];
for (let i = 0; i < 30; i++) {
  const kind = pick(['percent', 'fixed', 'freeship']);
  promos.push({
    code: `${pick(['SUMMER', 'AUTUMN', 'VIP', 'APP', 'MAIL', 'SHOP'])}${String(i + 10).padStart(2, '0')}${pick(['', 'X', 'K'])}`,
    kind,
    value: kind === 'percent' ? int(3, 25) : kind === 'fixed' ? int(1, 20) * 10000 : 0,
    min_subtotal: int(0, 10) * 100000,
    max_discount: kind === 'percent' && rand() < 0.6 ? int(5, 30) * 10000 : 0,
    category: rand() < 0.3 ? pick(CATEGORIES)[0] : null,
    expired: rand() < 0.25,
  });
}

// ---- diacritics
const GROUPS = { a: 'àáảãạăằắẳẵặâầấẩẫậ', d: 'đ', e: 'èéẻẽẹêềếểễệ', i: 'ìíỉĩị', o: 'òóỏõọôồốổỗộơờớởỡợ', u: 'ùúủũụưừứửữự', y: 'ỳýỷỹỵ' };
const diacritics = [];
for (const [base, chars] of Object.entries(GROUPS)) for (const ch of chars) { diacritics.push([ch, base]); diacritics.push([ch.toUpperCase(), base.toUpperCase()]); }

// ---- sales
const sales = [];
const start = Date.UTC(2025, 0, 1) / 86400000;
for (let i = 0; i < 1640; i++) {
  const day = start + int(0, 303);
  const d = new Date(day * 86400000);
  const p = products[Math.floor(Math.pow(rand(), 1.6) * products.length)];
  sales.push({
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    sku: p.sku,
    qty: int(1, 12),
    province: pick(provinces).code,
    unit_price: rand() < 0.2 ? Math.round(p.price * 0.9 / 1000) * 1000 : p.price,
  });
}
sales.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// ---- render (old style, one row per line)
const obj = o => '{ ' + Object.entries(o).map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'string' ? q(v) : Array.isArray(v) ? '[' + v.map(q).join(', ') + ']' : String(v)}`).join(', ') + ' }';
const arr = rows => '[\n' + rows.map(r => '  ' + obj(r)).join(',\n') + '\n]';
let source = fs.readFileSync(path.join(here, 'router-old.template.js'), 'utf8');
source = source
  .replace('__CATEGORIES__', arr(CATEGORIES.map(([id, name, name_en]) => ({ id, name, name_en }))))
  .replace('__PRODUCTS__', arr(products))
  .replace('__PROVINCES__', arr(provinces))
  .replace('__PROMOS__', arr(promos))
  .replace('__DIACRITICS__', '{\n' + diacritics.map(([k, v]) => `  ${q(k)}: ${q(v)}`).join(',\n') + '\n}')
  .replace('__SALES__', arr(sales));
if (/customer/i.test(source)) throw new Error('router-old.js must not say customer');
const out = path.join(fixture, 'project/services/web-js/src/legacy/router-old.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, source);
console.log(`${out}: ${source.split('\n').length} lines`);

// The p5 reference keeps the same tables as JSON next to the split modules.
const dataDir = path.join(fixture, 'reference-p5/services/web-js/src/router/data');
fs.mkdirSync(dataDir, { recursive: true });
const rows = list => '[\n' + list.map(r => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n';
fs.writeFileSync(path.join(dataDir, 'categories.json'), rows(CATEGORIES.map(([id, name, name_en]) => ({ id, name, name_en }))));
fs.writeFileSync(path.join(dataDir, 'products.json'), rows(products));
fs.writeFileSync(path.join(dataDir, 'provinces.json'), rows(provinces));
fs.writeFileSync(path.join(dataDir, 'promos.json'), rows(promos));
fs.writeFileSync(path.join(dataDir, 'diacritics.json'), JSON.stringify(Object.fromEntries(diacritics), null, 1) + '\n');
fs.writeFileSync(path.join(dataDir, 'sales.json'), rows(sales));

// ---- golden requests
const { route } = await import(pathToFileURL(out).href + `?t=${Date.now()}`);
const requests = [];
const add = (method, url, extra = {}) => requests.push({ method, url, ...extra });
const EN = { headers: { 'accept-language': 'en-US,en;q=0.8' } };
add('GET', '/health'); add('HEAD', '/health'); add('GET', '/health/'); add('POST', '/health'); add('GET', '/nope'); add('GET', '/v1/catalog/');
for (const qs of ['', '?page=2', '?page=2abc', '?page=0', '?page=-1', '?page=x', '?per_page=0', '?per_page=5', '?per_page=500', '?per_page=7&page=3',
  '?category=tea', '?category=teaware&sort=-price', '?category=coffee', '?sort=name&per_page=10', '?sort=price&per_page=10', '?sort=stock&per_page=10', '?sort=rating',
  '?q=tra+xanh', '?q=Tr%C3%A0%20sen', '?q=%E0%A4%A', '?q=am', '?q=ZZZ', '?tag=organic&per_page=50', '?tag=limited&category=snack', '?include_inactive=1&per_page=50&page=4',
  '?include_inactive=true&sort=name&per_page=50', '?currency=usd&per_page=5', '?currency=EUR', '?currency=USD&sort=-price&per_page=3', '?q=&page=1&page=2', '?flag&per_page=3', '?q=b%C3%A1nh&currency=USD']) {
  add('GET', '/v1/catalog' + qs);
}
add('GET', '/v1/catalog?per_page=4', EN); add('GET', '/v1/catalog?category=nope', EN);
add('GET', '/v1/categories'); add('GET', '/v1/categories', EN); add('DELETE', '/v1/categories');
const someSkus = [products[0].sku, products[5].sku, products[71].sku, products[120].sku, products[150].sku, products[175].sku, products[99].sku];
for (const sku of someSkus) { add('GET', `/v1/catalog/${sku}`); add('GET', `/v1/catalog/${sku}?currency=USD`, EN); add('GET', `/v1/catalog/${sku}/related`); }
add('GET', `/v1/catalog/${someSkus[0].toLowerCase()}`); add('GET', `/v1/catalog/${someSkus[0].toLowerCase()}/related`); add('GET', '/v1/catalog/TEA-999'); add('GET', '/v1/catalog/TEA-999', EN);
add('GET', `/v1/catalog/${someSkus[1]}/related?limit=2`); add('GET', `/v1/catalog/${someSkus[2]}/related?limit=50&currency=USD`); add('GET', '/v1/catalog/TEA-001?currency=JPY');
const activeInStock = products.filter(p => p.active && p.stock > 5);
const inactive = products.find(p => !p.active);
const lowStock = products.find(p => p.active && p.stock > 0 && p.stock < 4);
const sku = i => activeInStock[i % activeInStock.length].sku;
const tea = activeInStock.filter(p => p.category === 'tea'); const gift = activeInStock.filter(p => p.category === 'gift');
const carts = [
  { items: [{ sku: sku(0), qty: 1 }] },
  { items: [{ sku: sku(1), qty: 2 }, { sku: sku(2), qty: 1 }], province: 'VN-HN' },
  { items: [{ sku: sku(1), qty: 2 }, { sku: sku(1), qty: '3' }], province: 'vn-sg', currency: 'USD' },
  { items: [{ sku: tea[0].sku, qty: 3 }, { sku: tea[1].sku, qty: 2 }], promo: 'teaonly15', province: 'VN-DN' },
  { items: [{ sku: tea[0].sku, qty: 3 }], promo: 'TEAONLY15 ', province: 'VN-DN' },
  { items: [{ sku: gift[0].sku, qty: 4 }], promo: 'GIFT100K', province: 'VN-01' },
  { items: [{ sku: sku(3), qty: 1 }], promo: 'GIFT100K' },
  { items: [{ sku: sku(4), qty: 5 }, { sku: sku(5), qty: 5 }], promo: 'FREESHIP', province: 'VN-HP' },
  { items: [{ sku: sku(4), qty: 5 }], promo: 'FREESHIP', province: provinces.find(p => p.remote).code },
  { items: [{ sku: sku(6), qty: 9 }, { sku: sku(7), qty: 9 }, { sku: sku(8), qty: 9 }], promo: 'BIGSALE30', province: 'VN-SG' },
  { items: [{ sku: sku(9), qty: 1 }], promo: 'TET2025' },
  { items: [{ sku: sku(9), qty: 1 }], promo: 'TET2026', province: 'VN-CT', currency: 'usd' },
  { items: [{ sku: sku(10), qty: 1 }], promo: 'NOPE' },
  { items: [{ sku: sku(10), qty: 1 }], promo: '' },
  { items: [{ sku: sku(10), qty: 0 }] },
  { items: [{ sku: sku(10), qty: '0' }] },
  { items: [{ sku: sku(10), qty: 1.5 }] },
  { items: [{ sku: sku(10), qty: -1 }] },
  { items: [{ sku: sku(10), qty: 100 }] },
  { items: [{ sku: sku(10), qty: '2x' }] },
  { items: [{ sku: sku(10) }] },
  { items: [{ sku: 'NOPE-1', qty: 1 }] },
  { items: [{ sku: inactive.sku, qty: 1 }] },
  { items: [{ sku: lowStock.sku, qty: 3 }, { sku: lowStock.sku, qty: 3 }] },
  { items: [] },
  { items: Array.from({ length: 31 }, (_, i) => ({ sku: sku(i), qty: 1 })) },
  { items: Array.from({ length: 30 }, (_, i) => ({ sku: sku(i), qty: 1 })), province: 'VN-05' },
  { items: [{ sku: sku(11), qty: 2 }], province: 'XX' },
  { items: [{ sku: sku(12), qty: 2 }], currency: 'EUR' },
  { items: [null, { sku: sku(12), qty: 1 }] },
  { items: [{ sku: sku(13), qty: 99 }] },
];
for (const cart of carts) add('POST', '/v1/cart/preview', { body: cart });
add('POST', '/v1/cart/preview', { body: carts[3], ...EN }); add('POST', '/v1/cart/preview', { body: carts[12], ...EN });
add('POST', '/v1/cart/preview', { body: JSON.stringify(carts[1]) }); add('POST', '/v1/cart/preview', { body: '{not json' }); add('POST', '/v1/cart/preview', { body: '' });
add('POST', '/v1/cart/preview', { body: [1, 2] }); add('POST', '/v1/cart/preview'); add('GET', '/v1/cart/preview');
for (const qs of ['?province=VN-HN', '?province=vn-sg&weight=1200', '?province=VN-HN&weight=0', '?province=VN-HN&weight=500', '?province=VN-HN&weight=501', '?province=VN-HN&weight=30000',
  '?province=VN-HN&weight=30001', '?province=VN-HN&weight=-5', '?province=VN-HN&weight=abc', '?province=VN-HN&weight=', `?province=${provinces.find(p => p.remote).code}&weight=2500`,
  '?province=VN-40&weight=900&currency=USD', '?province=', '', '?province=VN-99', '?province=VN-07&weight=12.5', '?province=VN-HN&currency=GBP']) {
  add('GET', '/v1/shipping/quote' + qs);
}
add('GET', '/v1/shipping/quote?province=VN-99', EN);
for (const qs of ['', '?zone=a', '?zone=D', '?remote=1', '?sort=name', '?zone=C&sort=name', '?zone=Z']) add('GET', '/v1/shipping/provinces' + qs);
const promoBodies = [
  { code: 'WELCOME50K', subtotal: 300000 }, { code: 'welcome50k', subtotal: 299999 }, { code: 'WELCOME50K', subtotal: 20000 }, { code: 'TET2026', subtotal: 5000000 },
  { code: 'TET2026', subtotal: 600000 }, { code: 'TET2025', subtotal: 600000 }, { code: 'TEAONLY15', subtotal: 100000, category: 'tea' }, { code: 'TEAONLY15', subtotal: 100000, categories: ['snack', 'tea'] },
  { code: 'TEAONLY15', subtotal: 100000, categories: ['snack'] }, { code: 'FREESHIP', subtotal: '250000' }, { code: 'FREESHIP', subtotal: 'abc' }, { code: ' FREESHIP', subtotal: 250000 },
  { code: 'BIGSALE30', subtotal: 9000000 }, { subtotal: 1 }, { code: 'GIFT100K', subtotal: 800000, category: 'gift' }, { code: 'SNACK5', subtotal: 123457, category: 'snack' },
  ...promos.slice(8, 20).map((p, i) => ({ code: p.code, subtotal: (i + 1) * 150000, category: p.category ?? 'tea' })),
];
for (const body of promoBodies) add('POST', '/v1/promo/validate', { body });
add('POST', '/v1/promo/validate', { body: { code: 'TET2025', subtotal: 600000 }, ...EN }); add('POST', '/v1/promo/validate', { body: 'null' }); add('PUT', '/v1/promo/validate', { body: {} });
for (const qs of ['?q=tr', '?q=tra', '?q=Tr%C3%A0%20xanh', '?q=a', '?q=', '', '?q=am&limit=3', '?q=hop&limit=50', '?q=banh', '?q=xyzxyz', '?q=%C4%91en', '?q=SHAN']) add('GET', '/v1/search/suggest' + qs);
const notes = [
  ['A-1001', { text: '  Gọi lại sau 5 giờ chiều  ', tags: ['VIP', 'call', 'vip', ' call '] }], ['A-1001', { text: 'x' }], ['A-12', { text: 'short id' }], ['B-1001', { text: 'bad id' }],
  ['A-1001', { text: '   ' }], ['A-1001', { text: 'y'.repeat(501) }], ['A-1001', { text: 'y'.repeat(500), pinned: 'true' }], ['A-1001', { text: 'tags', tags: 'vip' }], ['A-1001', { text: 'tags', tags: ['ok', 3] }],
  ['A-2002', { text: 'Account muốn xuất hóa đơn VAT cho mọi đơn từ tháng 11, gửi email kế toán', pinned: true, tags: [] }], ['A-1001', null], ['A%2D1001', { text: 'encoded' }],
];
for (const [id, body] of notes) add('POST', `/v1/accounts/${id}/notes`, body === null ? {} : { body });
add('POST', '/v1/accounts/A-1/notes', { body: { text: 'x' }, ...EN }); add('GET', '/v1/accounts/A-1001/notes');
for (const qs of ['', '?group=day&from=2025-03-01&to=2025-03-07', '?group=week&from=2025-02-01&to=2025-03-31', '?group=month', '?group=category', '?group=province&from=2025-06-01&to=2025-06-30',
  '?group=zone', '?group=zone&format=csv', '?group=month&format=csv&category=tea', '?group=category&format=xml', '?group=year', '?from=2025-13-01', '?from=2025-02-31&to=2025-03-02&group=day',
  '?from=2025-05-01&to=2025-04-01', '?from=20250101', '?category=gift&group=week&from=2025-09-01', '?group=day&from=2025-10-30&format=csv', '?from=2026-01-01&to=2026-12-31']) {
  add('GET', '/v1/reports/sales' + qs);
}
add('GET', '/v1/reports/sales?group=year', EN);
for (const qs of ['', '?n=3', '?n=3&by=revenue', '?n=0', '?n=51', '?n=50&by=revenue&from=2025-07-01&to=2025-07-31', '?n=5&by=price', '?n=abc', '?n=4&from=2025-01-01&to=2025-01-31', '?n=2x']) add('GET', '/v1/reports/top-products' + qs);
for (const qs of ['', '?threshold=0', '?threshold=5', '?threshold=25', '?threshold=-1', '?threshold=2.5', '?threshold=abc', '?threshold=']) add('GET', '/v1/reports/stock-alerts' + qs);
for (const qs of ['?from=2025-02-24', '?from=2025-12-29&days=10', '?from=2025-02-27&days=3', '?from=2025-02-31&days=2', '?days=3', '?from=2025-01-01&days=0', '?from=2025-01-01&days=99', '?from=bad']) add('GET', '/v1/reports/calendar' + qs);
add('GET', '/v1/reports/calendar?from=bad', EN); add('POST', '/v1/reports/calendar'); add('PATCH', '/v1/catalog/TEA-001'); add('get', '/v1/categories'); add(undefined, '/health');
add('GET', '/v1/catalog?per_page=3#frag'); add('GET', '/v1/catalog?q=tra&q=banh&per_page=3'); add('GET', '/v1/catalog?per_page=3', { headers: { 'Accept-Language': 'en' } });
add('GET', '/v1/catalog?per_page=3', { headers: { 'ACCEPT-LANGUAGE': 'en' } }); add('GET', '/v1/catalog?per_page=3', { headers: { 'accept-language': 'vi-VN, en' } });

const golden = requests.map(request => ({ request, response: route(structuredClone(request)) }));
const out2 = path.join(fixture, 'hidden-p5/.soak/p5/golden.json');
fs.mkdirSync(path.dirname(out2), { recursive: true });
fs.writeFileSync(out2, JSON.stringify(golden, null, 1) + '\n');
const statuses = {};
for (const g of golden) statuses[g.response.status] = (statuses[g.response.status] ?? 0) + 1;
console.log(`${out2}: ${golden.length} cases`, statuses);
// The p5 reference's own golden fixture (what the member's agent records before refactoring).
const own = path.join(fixture, 'reference-p5/services/web-js/test/fixtures/router-golden.json');
fs.mkdirSync(path.dirname(own), { recursive: true });
fs.writeFileSync(own, JSON.stringify(golden.filter((_, i) => i % 2 === 0), null, 1) + '\n');
