/**
 * Near & Now - Weekly Price Updater
 * Fetches flyer images from flyerca.com -> Claude AI reads prices -> saves to Supabase
 * Runs every Thursday at 8am ET
 */

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

// --- Supabase helpers ---
async function sbSelect(table, query = '*', filters = {}) {
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Upsert failed: ${text}`);
  }
}

// --- Fetch flyer image URLs from flyerca.com ---
async function getFlyerImageUrls(storeUrl) {
  try {
    const r = await fetch(storeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      }
    });
    if (!r.ok) return [];
    const html = await r.text();
    const matches = html.match(/https:\/\/www\.flyerca\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9]+-\d+\.jpg/g);
    if (!matches) return [];
    // Return first 4 pages only (enough for prices, keeps cost low)
    return [...new Set(matches)].slice(0, 4);
  } catch (e) {
    console.error('Failed to fetch flyer URLs:', e.message);
    return [];
  }
}

// --- Ask Claude AI to read prices from flyer image ---
async function readPricesFromImage(imageUrl, storeName) {
  try {
    const prompt = `You are reading a Canadian grocery store flyer image for ${storeName}.

Extract prices for these common grocery items if they appear in the flyer:
${BASKET_ITEMS.join(', ')}

Rules:
- Only extract items that clearly show a price
- Use the sale/flyer price (not regular price)
- If an item appears multiple times, use the lowest price
- Return ONLY valid JSON, no other text

Return this exact format:
{"prices": [{"item": "milk", "price": 4.99, "size": "4L"}, ...]}

If no matching items found, return: {"prices": []}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: imageUrl }
            },
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
    const text = data.content?.[0]?.text || '{"prices":[]}';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed.prices || [];
  } catch (e) {
    console.error('Vision read error:', e.message);
    return [];
  }
}

// --- Main handler ---
export const handler = async () => {
  console.log('Near & Now price updater starting (flyerca.com + AI vision)...');

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    console.error('Missing env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, ANTHROPIC_API_KEY');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // Load DB items and stores
  const [dbItems, dbStores] = await Promise.all([
    sbSelect('nn_grocery_items', 'id,name,common_names'),
    sbSelect('nn_grocery_stores', 'id,name,banner,is_active', { is_active: true }),
  ]);

  console.log(`Loaded ${dbItems.length} items, ${dbStores.length} stores from DB`);

  // Build banner -> store IDs map
  const bannerStores = {};
  for (const store of dbStores) {
    const banner = store.banner || store.name;
    if (!bannerStores[banner]) bannerStores[banner] = [];
    bannerStores[banner].push(store.id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allPriceRows = [];
  const stats = { stores: 0, images: 0, prices: 0 };

  for (const [storeName, storeUrl] of Object.entries(FLYER_SOURCES)) {
    const storeIds = bannerStores[storeName];
    if (!storeIds?.length) {
      console.log(`No DB stores found for ${storeName}, skipping`);
      continue;
    }

    console.log(`\nProcessing ${storeName}...`);
    const imageUrls = await getFlyerImageUrls(storeUrl);
    console.log(`  Found ${imageUrls.length} flyer images`);

    if (!imageUrls.length) continue;

    const allPrices = {};

    for (const imageUrl of imageUrls) {
      stats.images++;
      console.log(`  Reading image: ${imageUrl.split('/').pop()}`);
      const prices = await readPricesFromImage(imageUrl, storeName);
      console.log(`  -> Found ${prices.length} prices`);

      for (const p of prices) {
        const key = p.item.toLowerCase();
        // Keep lowest price if duplicate
        if (!allPrices[key] || p.price < allPrices[key].price) {
          allPrices[key] = p;
        }
      }

      // Small delay between API calls
      await new Promise(r => setTimeout(r, 500));
    }

    // Match extracted prices to DB items
    for (const [itemKey, priceData] of Object.entries(allPrices)) {
      // Find matching DB item
      let dbItem = null;
      let bestScore = 0;

      for (const item of dbItems) {
        const names = [item.name, ...(item.common_names || [])].map(n => n.toLowerCase());
        for (const name of names) {
          if (name.includes(itemKey) || itemKey.includes(name)) {
            const score = Math.max(name.length, itemKey.length);
            if (score > bestScore) {
              bestScore = score;
              dbItem = item;
            }
          }
        }
      }

      if (!dbItem) continue;

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
        stats.prices++;
      }
    }

    stats.stores++;
    console.log(`  ${storeName}: ${Object.keys(allPrices).length} unique prices extracted`);
  }

  console.log(`\nTotal: ${stats.prices} price rows from ${stats.stores} stores, ${stats.images} images`);

  if (!allPriceRows.length) {
    console.warn('No prices extracted - check if flyerca.com is accessible');
    return { statusCode: 200, body: 'No prices extracted' };
  }

  // Save to Supabase in batches
  let saved = 0;
  for (let i = 0; i < allPriceRows.length; i += 50) {
    try {
      await sbUpsert('nn_grocery_prices', allPriceRows.slice(i, i + 50));
      saved += Math.min(50, allPriceRows.length - i);
    } catch (e) {
      console.error('Batch save error:', e.message);
    }
  }

  const msg = `Done! ${saved} prices saved from ${stats.stores} stores`;
  console.log(msg);
  return { statusCode: 200, body: msg };
};

// Schedule: every Thursday at 8am ET (1pm UTC)
export const config = {
  schedule: '0 13 * * 4'
};
