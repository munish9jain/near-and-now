/**
 * Near & Now - Weekly Price Updater
 * Fetches flyer images from flyerca.com, resizes with sharp, Claude AI reads prices, saves to Supabase
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

// Exact DB item names — Claude AI must return these exact names
const DB_ITEM_NAMES = [
  'Eggs Large','Milk 2%','Bread White','Butter','Bananas','Chicken Breast',
  'Ground Beef','Potatoes','Onions','Rice','Pasta','Canned Tomatoes',
  'Cooking Oil','Cheese Cheddar','Yogurt','Orange Juice','Coffee','Cereal',
  'Apples','Carrots','Tomatoes','Cucumber','Peanut Butter','Jam',
  'Canned Beans','Tuna Canned','Frozen Vegetables','Laundry Detergent',
  'Dish Soap','Toilet Paper','Cream Cheese','Broccoli','Bell Peppers',
  'Garlic','Lemons','Pork Chops','Bacon','Frozen Pizza','Paper Towels'
];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.flyerca.com/',
};

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

async function sbDelete(table, filters) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?`;
  url += Object.entries(filters).map(([k,v]) => `${k}=eq.${v}`).join('&');
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) console.warn(`Delete warning: ${await r.text()}`);
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Insert failed (${r.status}): ${text}`);
  }
}

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

async function downloadAndResize(imageUrl) {
  try {
    const r = await fetch(imageUrl, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
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

async function readPricesFromImage(imageUrl, storeName) {
  try {
    const base64 = await downloadAndResize(imageUrl);
    if (!base64) return [];

    // Give Claude the EXACT item names to use — no guessing
    const prompt = `You are reading a Canadian grocery flyer page for ${storeName}.

Find prices for these exact grocery items if visible in this flyer page:
${DB_ITEM_NAMES.join(', ')}

IMPORTANT RULES:
- Use ONLY the exact item names listed above
- Use the flyer/sale price shown
- Only include items clearly visible with a price on THIS page
- Return ONLY raw JSON, no markdown, no explanation

Return this exact format:
{"prices": [{"item": "Eggs Large", "price": 3.97}, {"item": "Milk 2%", "price": 5.47}]}

If no matching items found on this page: {"prices": []}`;

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

export const handler = async () => {
  console.log('Near & Now price updater starting...');

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    console.error('Missing env vars');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const [dbItems, dbStores] = await Promise.all([
    sbSelect('nn_grocery_items', 'id,name'),
    sbSelect('nn_grocery_stores', 'id,name,banner,is_active', { is_active: true }),
  ]);
  console.log(`DB: ${dbItems.length} items, ${dbStores.length} stores`);

  // Map exact item name -> DB id
  const itemIdMap = {};
  dbItems.forEach(item => { itemIdMap[item.name] = item.id; });

  // Map banner -> store IDs
  const bannerStores = {};
  dbStores.forEach(store => {
    const banner = store.banner || store.name;
    if (!bannerStores[banner]) bannerStores[banner] = [];
    bannerStores[banner].push({ id: store.id, name: store.name });
  });

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allPriceRows = [];
  let totalStores = 0;

  for (const [bannerName, storeUrl] of Object.entries(FLYER_SOURCES)) {
    const stores = bannerStores[bannerName];
    if (!stores || !stores.length) {
      console.log(`Skipping ${bannerName} - not in DB`);
      continue;
    }

    console.log(`\n--- ${bannerName} ---`);
    const imageUrls = await getFlyerImageUrls(storeUrl);
    console.log(`Found ${imageUrls.length} flyer images`);
    if (!imageUrls.length) continue;

    const bestPrices = {};
    for (const imageUrl of imageUrls) {
      console.log(`  Image: ${imageUrl.split('/').pop()}`);
      const prices = await readPricesFromImage(imageUrl, bannerName);
      console.log(`  -> ${prices.length} prices found: ${prices.map(p=>p.item).join(', ')}`);

      for (const p of prices) {
        // Only accept exact DB item names
        if (!itemIdMap[p.item]) {
          console.log(`    Skipping unknown item: ${p.item}`);
          continue;
        }
        const key = p.item;
        if (!bestPrices[key] || p.price < bestPrices[key].price) {
          bestPrices[key] = p;
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const matched = Object.keys(bestPrices).length;
    console.log(`${bannerName}: ${matched} items matched to DB`);

    for (const [itemName, priceData] of Object.entries(bestPrices)) {
      const itemId = itemIdMap[itemName];
      if (!itemId) continue;

      for (const store of stores) {
        allPriceRows.push({
          store_id: store.id,
          item_id: itemId,
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

    totalStores++;
  }

  console.log(`\nTotal rows to save: ${allPriceRows.length}`);
  if (!allPriceRows.length) {
    return { statusCode: 200, body: 'No prices extracted' };
  }

  // Delete old prices then insert fresh
  const affectedStoreIds = [...new Set(allPriceRows.map(r => r.store_id))];
  for (const storeId of affectedStoreIds) {
    try {
      await sbDelete('nn_grocery_prices', { store_id: storeId, is_current: true });
    } catch(e) {
      console.warn(`Delete warning for store ${storeId}:`, e.message);
    }
  }

  let saved = 0;
  for (let i = 0; i < allPriceRows.length; i += 50) {
    try {
      await sbInsert('nn_grocery_prices', allPriceRows.slice(i, i + 50));
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
