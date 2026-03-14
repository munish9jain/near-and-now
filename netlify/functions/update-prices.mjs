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

async function sbRequest(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (method === 'GET') {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET ${path} failed (${r.status}): ${text}`);
    return JSON.parse(text);
  }
  const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} failed (${r.status}): ${text}`);
  return text ? JSON.parse(text) : null;
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

    const prompt = `You are reading a Canadian grocery flyer page for ${storeName}.

Find prices for these exact grocery items if visible:
${DB_ITEM_NAMES.join(', ')}

Use ONLY the exact item names above. Return ONLY raw JSON:
{"prices": [{"item": "Eggs Large", "price": 3.97}]}
If nothing found: {"prices": []}`;

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

    if (!response.ok) { console.error('Claude API error:', await response.text()); return []; }
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
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // Load DB data
  const dbItems  = await sbRequest('GET', 'nn_grocery_items?select=id,name');
  const dbStores = await sbRequest('GET', 'nn_grocery_stores?select=id,name,banner&is_active=eq.true');
  console.log(`DB: ${dbItems.length} items, ${dbStores.length} stores`);

  const itemIdMap = {};
  dbItems.forEach(item => { itemIdMap[item.name] = item.id; });

  const bannerStores = {};
  dbStores.forEach(store => {
    const banner = store.banner || store.name;
    if (!bannerStores[banner]) bannerStores[banner] = [];
    bannerStores[banner].push(store.id);
  });

  const today    = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allRows  = [];
  let totalStores = 0;

  for (const [bannerName, storeUrl] of Object.entries(FLYER_SOURCES)) {
    const storeIds = bannerStores[bannerName];
    if (!storeIds || !storeIds.length) { console.log(`Skipping ${bannerName}`); continue; }

    console.log(`\n--- ${bannerName} ---`);
    const imageUrls = await getFlyerImageUrls(storeUrl);
    console.log(`Found ${imageUrls.length} images`);
    if (!imageUrls.length) continue;

    const bestPrices = {};
    for (const imageUrl of imageUrls) {
      const prices = await readPricesFromImage(imageUrl, bannerName);
      console.log(`  ${imageUrl.split('/').pop()} -> ${prices.length} prices: ${prices.map(p=>p.item).join(', ')}`);
      for (const p of prices) {
        if (!itemIdMap[p.item]) continue;
        if (!bestPrices[p.item] || p.price < bestPrices[p.item]) bestPrices[p.item] = p.price;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`${bannerName}: ${Object.keys(bestPrices).length} items`);

    for (const [itemName, price] of Object.entries(bestPrices)) {
      for (const storeId of storeIds) {
        allRows.push({
          store_id:        storeId,
          item_id:         itemIdMap[itemName],
          regular_price:   price,
          sale_price:      price,
          sale_valid_from: today,
          sale_valid_until: nextWeek,
          source:          'flyer_ai',
          confidence:      'high',
          is_current:      true,
          reported_at:     new Date().toISOString(),
        });
      }
    }
    totalStores++;
  }

  console.log(`\nTotal rows to save: ${allRows.length}`);
  if (!allRows.length) return { statusCode: 200, body: 'No prices extracted' };

  // Try inserting one row first to catch any schema issues
  console.log('Testing insert with 1 row...');
  console.log('Sample row:', JSON.stringify(allRows[0]));
  try {
    await sbRequest('POST', 'nn_grocery_prices', [allRows[0]]);
    console.log('Test insert OK');
  } catch(e) {
    console.error('TEST INSERT FAILED:', e.message);
    return { statusCode: 500, body: `Insert test failed: ${e.message}` };
  }

  // Now insert the rest
  let saved = 1;
  for (let i = 1; i < allRows.length; i += 50) {
    try {
      await sbRequest('POST', 'nn_grocery_prices', allRows.slice(i, i + 50));
      saved += Math.min(50, allRows.length - i);
    } catch (e) {
      console.error(`Batch ${i} error:`, e.message);
    }
  }

  const msg = `Done! ${saved} prices saved from ${totalStores} stores`;
  console.log(msg);
  return { statusCode: 200, body: msg };
};

export const config = { schedule: '0 13 * * 4' };
