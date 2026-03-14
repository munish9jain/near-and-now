/**
 * Near & Now - Weekly Price Updater
 * Fetches flyer images from flyerca.com, resizes with sharp, Claude AI reads prices, saves to Supabase
 * Runs every Thursday at 8am ET
 */

import sharp from 'sharp';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const FLYER_SOURCES = {
  'No Frills':   'https://www.flyerca.com/no-frills-flyer-sales/',
  'Food Basics': 'https://www.flyerca.com/food-basics/',
  'FreshCo':     'https://www.flyerca.com/freshco/',
  'Walmart':     'https://www.flyerca.com/walmart-canada/',
  'Metro':       'https://www.flyerca.com/metro/',
};

const BASKET_ITEMS = [
  'milk', 'bread', 'eggs', 'butter', 'chicken breast',
  'ground beef', 'bananas', 'apples', 'orange juice', 'cheddar cheese',
  'yogurt', 'pasta', 'rice', 'tomatoes', 'potatoes',
  'onions', 'carrots', 'lettuce', 'cereal', 'coffee'
];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.flyerca.com/',
};

// --- Supabase helpers ---
async function sbSelect(table, query, filters) {
  query = query || '*';
  filters = filters || {};
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${query}`;
  for (const [k, v] of Object.entries(filters)) url += `&${k}=eq.${v}`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

async function sbUpsert(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Upsert failed: ${await r.text()}`);
}

// --- Get flyer image URLs from flyerca.com ---
async function getFlyerImageUrls(storeUrl) {
  try {
    const r = await fetch(storeUrl, { headers: FETCH_HEADERS });
    if (!r.ok) return [];
    const html = await r.text();
    const matches = html.match(/https:\/\/www\.flyerca\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9]+-\d+\.jpg/g);
    if (!matches) return [];
    return [...new Set(matches)].slice(0, 4);
  } catch (e) {
    console.error('getFlyerImageUrls error:', e.message);
    return [];
  }
}

// --- Download image, resize to safe dimensions, return base64 ---
async function downloadAndResize(imageUrl) {
  try {
    const r = await fetch(imageUrl, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    // Resize: max 1200px wide, max 3500px tall - well under Claude's 8000px limit
    const resized = await sharp(buffer)
      .resize(1200, 3500, { fit: 'inside', withoutEnlargement: false })
      .jpeg({ quality: 82 })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    console.log(`    Resized to ${meta.width}x${meta.height}, ${Math.round(resized.length/1024)}KB`);
    return resized.toString('base64');
  } catch (e) {
    console.error('downloadAndResize error:', e.message);
    return null;
  }
}

// --- Ask Claude to extract grocery prices from flyer image ---
async function readPricesFromImage(imageUrl, storeName) {
  try {
    const base64 = await downloadAndResize(imageUrl);
    if (!base64) return [];

    const prompt = `You are reading a Canadian grocery store flyer page for ${storeName}.

Find prices for any of these items if visible:
${BASKET_ITEMS.join(', ')}

Return ONLY this JSON format, nothing else:
{"prices": [{"item": "milk", "price": 4.99, "size": "4L"}]}

Rules:
- Use flyer/sale price only
- Lowest price if item appears multiple times
- Skip items without a clear price
- Return {"prices": []} if nothing found`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      console.error('Claude API error:', await response.text());
      return [];
    }

    const data = await response.json();
    const text = data.content && data.content[0] ? data.content[0].text : '{"prices":[]}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return parsed.prices || [];
  } catch (e) {
    console.error('readPricesFromImage error:', e.message);
    return [];
  }
}

// --- Match extracted item name to DB item ---
function matchToDbItem(itemKey, dbItems) {
  let dbItem = null;
  let bestScore = 0;
  for (const item of dbItems) {
    const names = [item.name].concat(item.common_names || []).map(n => n.toLowerCase());
    for (const name of names) {
      if (name.includes(itemKey) || itemKey.includes(name)) {
        const score = Math.max(name.length, itemKey.length);
        if (score > bestScore) { bestScore = score; dbItem = item; }
      }
    }
  }
  return dbItem;
}

// --- Main handler ---
export const handler = async () => {
  console.log('Near & Now price updater starting...');

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    console.error('Missing env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, ANTHROPIC_API_KEY');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const [dbItems, dbStores] = await Promise.all([
    sbSelect('nn_grocery_items', 'id,name,common_names'),
    sbSelect('nn_grocery_stores', 'id,name,banner,is_active', { is_active: true }),
  ]);
  console.log(`DB: ${dbItems.length} items, ${dbStores.length} stores`);

  const bannerStores = {};
  for (const store of dbStores) {
    const banner = store.banner || store.name;
    if (!bannerStores[banner]) bannerStores[banner] = [];
    bannerStores[banner].push(store.id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allPriceRows = [];
  let totalStores = 0;

  for (const [storeName, storeUrl] of Object.entries(FLYER_SOURCES)) {
    const storeIds = bannerStores[storeName];
    if (!storeIds || !storeIds.length) {
      console.log(`Skipping ${storeName} - not in DB`);
      continue;
    }

    console.log(`\n--- ${storeName} ---`);
    const imageUrls = await getFlyerImageUrls(storeUrl);
    console.log(`Found ${imageUrls.length} flyer images`);
    if (!imageUrls.length) continue;

    const bestPrices = {};

    for (const imageUrl of imageUrls) {
      console.log(`  Image: ${imageUrl.split('/').pop()}`);
      const prices = await readPricesFromImage(imageUrl, storeName);
      console.log(`  -> ${prices.length} prices found`);
      for (const p of prices) {
        const key = p.item.toLowerCase();
        if (!bestPrices[key] || p.price < bestPrices[key].price) bestPrices[key] = p;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    let matched = 0;
    for (const [itemKey, priceData] of Object.entries(bestPrices)) {
      const dbItem = matchToDbItem(itemKey, dbItems);
      if (!dbItem) continue;
      matched++;
      for (const storeId of storeIds) {
        allPriceRows.push({
          store_id: storeId,
          item_id: dbItem.id,
          regular_price: priceData.price,
          sale_price: priceData.price,
          sale_valid_from: today,
          sale_valid_until: nextWeek,
          source: 'flyer_ai',
          confidence: 'high',
          is_current: true,
          reported_at: new Date().toISOString(),
        });
      }
    }

    console.log(`${storeName}: ${Object.keys(bestPrices).length} prices extracted, ${matched} matched to DB`);
    totalStores++;
  }

  if (!allPriceRows.length) {
    return { statusCode: 200, body: 'No prices extracted' };
  }

  let saved = 0;
  for (let i = 0; i < allPriceRows.length; i += 50) {
    try {
      await sbUpsert('nn_grocery_prices', allPriceRows.slice(i, i + 50));
      saved += Math.min(50, allPriceRows.length - i);
    } catch (e) {
      console.error('Save error:', e.message);
    }
  }

  const msg = `Done! ${saved} prices saved from ${totalStores} stores`;
  console.log(msg);
  return { statusCode: 200, body: msg };
};

export const config = { schedule: '0 13 * * 4' };
