// ════════════════════════════════════════════
// NEAR & NOW — GROCERY ENHANCEMENTS v2
// Fixed Basket + Flyer Mode + Store Scorecard
// ════════════════════════════════════════════

const FIXED_BASKET_ITEMS = [
  'Eggs Large','Milk 2%','Bread White','Butter','Bananas',
  'Chicken Breast','Ground Beef','Potatoes','Onions','Rice',
  'Pasta','Canned Tomatoes','Cheese Cheddar','Yogurt','Orange Juice',
  'Coffee','Cereal','Apples','Carrots','Tomatoes'
];

function loadFixedBasket() {
  APP.basket = {};
  APP.groceryItems.forEach(item => {
    if (FIXED_BASKET_ITEMS.includes(item.name)) APP.basket[item.id] = 1;
  });
  localStorage.setItem('nn_basket', JSON.stringify(APP.basket));
  renderItems();
  updateBasketUI();
  showToast('✓ Standard household basket loaded!');
}

function injectGroceryButtons() {
  const sub = document.getElementById('groceryStoresBadge');
  if (!sub || document.getElementById('flyerModeBtn')) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;margin:10px 16px 0;';
  wrap.innerHTML = `
    <button id="flyerModeBtn" onclick="flyerModeCompare()" style="
      flex:1;padding:11px;border-radius:50px;border:1.5px solid var(--amber);
      background:var(--amber-bg);color:var(--amber);
      font-family:'Sora',sans-serif;font-weight:700;font-size:12px;cursor:pointer;
      transition:all 0.12s;">
      🏷️ Flyer Mode
    </button>
    <button onclick="loadFixedBasket()" style="
      flex:1;padding:11px;border-radius:50px;border:1.5px solid var(--border2);
      background:var(--bg2);color:var(--text2);
      font-family:'Sora',sans-serif;font-weight:700;font-size:12px;cursor:pointer;
      transition:all 0.12s;">
      📦 Standard Basket
    </button>`;
  sub.parentNode.insertBefore(wrap, sub.nextSibling);
}

// Patch renderNearbyStoresBadge to also inject buttons
const _origRenderBadge = typeof renderNearbyStoresBadge === 'function' ? renderNearbyStoresBadge : null;
function renderNearbyStoresBadge() {
  if (_origRenderBadge) _origRenderBadge();
  setTimeout(injectGroceryButtons, 50);
}

// ── FLYER MODE ──
async function flyerModeCompare() {
  document.getElementById('basketView').style.display = 'none';
  document.getElementById('compareView').classList.add('active');
  document.getElementById('tab-grocery').scrollTop = 0;
  document.getElementById('compareSub').textContent = "This week's flyer prices";
  document.getElementById('compareContent').innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">Scanning this week's flyers…</div>
    </div>`;
  await new Promise(r => setTimeout(r, 50));

  const itemStoreMap = {};
  APP.groceryStores.forEach(store => {
    const sp = APP.storePrices[store.name] || {};
    Object.entries(sp).forEach(([name, price]) => {
      if (!itemStoreMap[name]) itemStoreMap[name] = [];
      itemStoreMap[name].push({ store: store.name, price });
    });
  });

  const comparableItems = Object.entries(itemStoreMap)
    .filter(([, s]) => s.length >= 2)
    .map(([itemName, stores]) => {
      const sorted = [...stores].sort((a,b) => a.price - b.price);
      return {
        itemName, stores: sorted, storeCount: stores.length,
        savings: sorted[sorted.length-1].price - sorted[0].price,
      };
    })
    .sort((a,b) => b.storeCount !== a.storeCount ? b.storeCount - a.storeCount : b.savings - a.savings);

  const storeWins = {};
  APP.groceryStores.forEach(s => { storeWins[s.name] = 0; });
  comparableItems.forEach(({ stores }) => {
    const min = stores[0].price;
    stores.filter(s => s.price === min).forEach(s => { storeWins[s.store] = (storeWins[s.store]||0) + 1; });
  });

  const storeRanking = APP.groceryStores
    .map(s => ({ store: s.name, wins: storeWins[s.name]||0 }))
    .filter(s => s.wins > 0).sort((a,b) => b.wins - a.wins);

  const numStores = APP.groceryStores.length;
  const total = comparableItems.length;
  let html = '';

  if (storeRanking.length) {
    const top = storeRanking[0];
    html += `<div class="winner-card fade-in" style="margin-top:14px;">
      <div class="winner-label">BEST OVERALL STORE THIS WEEK</div>
      <div class="winner-store">${top.store}</div>
      <div class="winner-total">${top.wins} cheapest items</div>
      <div class="winner-saving">Out of ${total} items compared this week</div>
    </div>
    <div style="padding:14px 16px 0">
      <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:15px;margin-bottom:10px;">🏆 Store Rankings</div>
      <div style="display:flex;flex-direction:column;gap:6px;">`;
    storeRanking.forEach((s,i) => {
      const isW = i===0, pct = total>0?Math.round(s.wins/total*100):0;
      html += `<div style="background:${isW?'var(--green-bg)':'var(--surface)'};border:1.5px solid ${isW?'var(--green)':'var(--border)'};border-radius:var(--radius);padding:11px 13px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
          <div style="font-weight:700;font-size:13px;">${i+1}. ${s.store}</div>
          <div style="font-size:12px;font-weight:700;color:${isW?'var(--green)':'var(--text3)'};">${s.wins} wins (${pct}%)</div>
        </div>
        <div style="height:5px;background:var(--border);border-radius:99px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${isW?'var(--green)':'var(--amber)'};border-radius:99px;"></div>
        </div>
      </div>`;
    });
    html += `</div></div>`;
  }

  const groups = {};
  comparableItems.forEach(i => { if(!groups[i.storeCount]) groups[i.storeCount]=[]; groups[i.storeCount].push(i); });

  html += `<div style="padding:14px 16px 0">
    <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:15px;margin-bottom:4px;">📊 This Week's Flyer Prices</div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:12px;">${total} items compared — only items in 2+ stores shown</div>`;

  Object.keys(groups).map(Number).sort((a,b)=>b-a).forEach(count => {
    const items = groups[count];
    const label = count>=numStores ? `✅ All ${count} stores` : `${count} of ${numStores} stores`;
    const color = count>=numStores?'var(--green)':count>=3?'var(--blue)':'var(--amber)';
    html += `<div style="margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:7px;">
        <div style="font-size:12px;font-weight:700;color:${color};">${label}</div>
        <div style="height:1px;flex:1;background:var(--border);"></div>
        <div style="font-size:11px;color:var(--text3);">${items.length} items</div>
      </div>`;
    items.forEach(({ itemName, stores, savings }) => {
      const emoji = (typeof EMOJI_MAP !== 'undefined' && EMOJI_MAP[itemName]) || '🛒';
      const sn = n => n.replace(/Brampton|Supercentre/g,'').trim();
      html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:18px;">${emoji}</span>
          <div style="flex:1;"><div style="font-weight:600;font-size:13px;">${itemName}</div>
            ${savings>0.01?`<div style="font-size:10px;color:var(--green);">Save $${savings.toFixed(2)} by choosing right store</div>`:`<div style="font-size:10px;color:var(--text3);">Same price everywhere</div>`}
          </div>
          <div style="text-align:right;">
            <div style="font-family:'Sora',sans-serif;font-weight:800;font-size:14px;color:var(--green);">$${stores[0].price.toFixed(2)}</div>
            <div style="font-size:10px;color:var(--text3);">best price</div>
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${stores.map((o,idx)=>`<div style="font-size:10px;padding:2px 7px;border-radius:20px;background:${idx===0?'var(--green-bg)':'var(--bg2)'};color:${idx===0?'var(--green)':'var(--text3)'};border:1px solid ${idx===0?'var(--green-soft)':'var(--border)'};font-weight:${idx===0?700:500};">${sn(o.store)}: $${o.price.toFixed(2)}</div>`).join('')}
        </div>
      </div>`;
    });
    html += `</div>`;
  });
  if(!total) html += `<div class="empty-msg">No items found in 2+ stores yet.<br>Prices update every Thursday.</div>`;
  html += `</div>`;
  document.getElementById('compareContent').innerHTML = html;
  document.getElementById('tab-grocery').scrollTop = 0;
}

// Inject buttons after grocery data loads - retry every second until found
setInterval(function() {
  if (!document.getElementById('flyerModeBtn')) injectGroceryButtons();
}, 1000);
