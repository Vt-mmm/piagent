// Tables of the storefront-admin router (moved out of the legacy router as JSON).
import { readFileSync } from 'node:fs';

const table = name => JSON.parse(readFileSync(new URL(`./data/${name}.json`, import.meta.url), 'utf8'));

export const LEGACY_VERSION = '1.9.3-legacy';
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 50;
export const MAX_NOTE_LENGTH = 500;
export const MAX_CART_LINES = 30;
export const MAX_QTY_PER_LINE = 99;
export const FREE_SHIPPING_THRESHOLD_VND = 1000000;
export const FREE_SHIPPING_THRESHOLD_USD = 5000;
export const USD_RATE_VND = 25000; // 1 USD = 25 000 VND (1 cent = 250 VND)
export const REMOTE_SURCHARGE_VND = 15000;
export const WEIGHT_STEP_GRAMS = 500;

export const CATEGORIES = table('categories');
export const PRODUCTS = table('products');
export const PROVINCES = table('provinces');
export const PROMOS = table('promos');
export const DIACRITICS = table('diacritics');
export const SALES = table('sales');

export const TAX_RATES = { tea: 8, teaware: 10, snack: 8, gift: 10, merch: 10, subscription: 5 };

export const ZONES = {
  A: { base: 18000, step: 4000, days: 1 },
  B: { base: 25000, step: 5000, days: 2 },
  C: { base: 32000, step: 6500, days: 3 },
  D: { base: 41000, step: 8000, days: 5 },
};
