/**
 * Near & Now — Weekly Price Updater
 * Netlify Scheduled Function — runs every Thursday at 8am ET
 * Scrapes Flipp for GTA flyer prices → pushes to Supabase
 */

import fetch from 'node-fetch';

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const POSTAL_CODE  = 'L6P';  // Brampton
const LOCALE       = 'en-ca';

const BANNER_MAP = {
  'No Frills':                  'No Frills',
  'FreshCo':                    'FreshCo',
  'Food Basics':                'Food Basics',
  'Walmart':                    'Walmart',
  'Real Canadian Superstore':   'Real Canadian Superstore',
  'Costco':                     'Costco',
  'Giant Tiger':                'Giant Tiger',
  'Metro':                      'Metro',
  'Sobeys':                     'Sobeys',
  'Loblaws':                    'Loblaws',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Referer': 'https://flipp.com/',
};

// ── Supabase helpers ──────────────────────────────────────────
async function sbSelect(table, query = '*', filters = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${query}`;
  for (const [k, v] of Object.entries(filters)) url += `&${k}=eq.${v}`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

async function sbInsert(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Insert failed: ${await r.text()}`);
}

async function sbUpdate(table, data, filters) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?`;
  url += Object.entries(filters).map(([k,v]) => `${k}=eq.${v}`).join('&');
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Update failed: ${await r.text()}`);
}

// ── Flipp scraper ─────────────────────────────────────────────
async function getFlyers(postalCode) {
  try {
    const url = `https://flipp.com/api/flyers?locale=${LOCALE}&postal_code=${postalCode}`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return [];
    return r.json();
  } catch { return []; }
}

async function getFlyerItems(flyerId) {
  try {
    const url = `https://flipp.com/api/flyers/${flyerId}/flyer_items`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return [];
    return r.json();
  } catch { return []; }
}

function extractPrice(item) {
  for (const field of ['current_price', 'sale_price', 'price']) {
    const val = item[field];
    if (val != null) {
      const p = parseFloat(String(val).replace('$', '').replace(',', ''));
      if (!isNaN(p) && p > 0) return p;
    }
  }
  const text = item.price_text || item.name || '';
  const m = text.match(/\$(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// ── Item matching ─────────────────────────────────────────────
function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.85;
  // Simple bigram similarity
  const bigrams = s => new Set([...s].map((c,i) => s.slice(i,i+2)).filter(x=>x.length===2));
  const ba = bigrams(a), bb = bigrams(b);
  const intersection = [...ba].filter(x => bb.has(x)).length;
  return (2 * intersection) / (ba.size + bb.size) || 0;
}

function matchItem(flippName, dbItems, threshold = 0.52) {
  let best = 0, match = null;
  for (const item of dbItems) {
    let score = similarity(flippName, item.name);
    for (const alias of (item.common_names || [])) {
      const s = similarity(flippName, alias);
      score = Math.max(score, s);
      if (alias.toLowerCase().split(' ').every(w => flippName.toLowerCase().includes(w))) {
        score = Math.max(score, 0.78);
      }
    }
    if (score > best) { best = score; match = item; }
  }
  return best >= threshold ? match : null;
}

// ── Main handler ──────────────────────────────────────────────
export const handler = async () => {
  console.log('🛒 Near & Now price updater starting...');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // Load items and stores from DB
  const [dbItems, dbStores] = await Promise.all([
    sbSelect('nn_grocery_items', 'id,name,common_names'),
    sbSelect('nn_grocery_stores', 'id,name,banner,is_active', { is_active: true }),
  ]);

  // Banner → store IDs map
  const bannerStores = {};
  for (const store of dbStores) {
    const banner = store.banner || store.name;
    if (!bannerStores[banner]) bannerStores[banner] = [];
    bannerStores[banner].push(store.id);
  }

  // Scrape Flipp
  console.log(`Fetching flyers for ${POSTAL_CODE}...`);
  const flyers = await getFlyers(POSTAL_CODE);
  console.log(`Found ${flyers.length} flyers`);

  const today = new Date().toISOString().slice(0, 10);
  const priceRows = [];
  const stats = { matched: 0, unmatched: 0, banners: new Set() };

  for (const flyer of flyers) {
    const merchantName = flyer.merchant?.name || String(flyer.merchant || '');
    let banner = null;
    for (const [flippName, ourName] of Object.entries(BANNER_MAP)) {
      if (merchantName.toLowerCase().includes(flippName.toLowerCase())) {
        banner = ourName; break;
      }
    }
    if (!banner || !bannerStores[banner]) continue;

    const storeIds = bannerStores[banner];
    const items    = await getFlyerItems(flyer.id);
    await new Promise(r => setTimeout(r, 400)); // polite delay

    const validFrom  = flyer.valid_from || today;
    const validUntil = flyer.valid_to   || today;

    for (const item of items) {
      const name  = (item.name || item.description || '').trim();
      const price = extractPrice(item);
      if (!name || !price) continue;

      const dbItem = matchItem(name, dbItems);
      if (!dbItem) { stats.unmatched++; continue; }

      stats.matched++;
      stats.banners.add(banner);

      for (const storeId of storeIds) {
        priceRows.push({
          store_id:         storeId,
          item_id:          dbItem.id,
          regular_price:    price,
          sale_price:       price,
          sale_valid_from:  validFrom,
          sale_valid_until: validUntil,
          source:           'flyer',
          confidence:       'high',
          is_current:       true,
          reported_at:      new Date().toISOString(),
        });
      }
    }

    console.log(`  ${banner}: ${items.length} items fetched`);
  }

  console.log(`Matched: ${stats.matched} | Unmatched: ${stats.unmatched}`);

  if (!priceRows.length) {
    console.warn('No price rows — Flipp may be blocking. Check manually.');
    return { statusCode: 200, body: 'No prices scraped' };
  }

  // Mark old prices as not current
  for (const storeIdList of Object.values(bannerStores)) {
    for (const storeId of storeIdList) {
      try { await sbUpdate('nn_grocery_prices', { is_current: false }, { store_id: storeId }); }
      catch(e) { console.warn(`Could not mark old prices for ${storeId}:`, e.message); }
    }
  }

  // Insert new prices in batches of 100
  let inserted = 0;
  for (let i = 0; i < priceRows.length; i += 100) {
    try {
      await sbInsert('nn_grocery_prices', priceRows.slice(i, i + 100));
      inserted += Math.min(100, priceRows.length - i);
    } catch(e) { console.error('Batch insert error:', e.message); }
  }

  const msg = `✅ Done! ${inserted} prices updated across ${[...stats.banners].join(', ')}`;
  console.log(msg);
  return { statusCode: 200, body: msg };
};

// Schedule: every Thursday at 8am ET
export const config = {
  schedule: '0 13 * * 4'  // UTC Thursday 1pm = ET Thursday 8am
};
