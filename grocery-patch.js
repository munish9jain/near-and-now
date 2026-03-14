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

// Override findBestPrices to add store scorecard
const _origFindBest = findBestPrices;
findBestPrices = async function() {
  const entries = Object.entries(APP.basket).filter(([,q])=>q>0);
  if(!entries.length){showToast('Add items first');return;}
  document.getElementById('basketView').style.display='none';
  document.getElementById('compareView').classList.add('active');
  document.getElementById('tab-grocery').scrollTop=0;
  document.getElementById('compareContent').innerHTML=`<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Checking all stores…</div></div>`;

  const prices={};
  APP.groceryStores.forEach(store=>{prices[store.name]={...(APP.storePrices[store.name]||{})};});
  const basketItems=entries.map(([id,qty])=>({id,qty,item:APP.groceryItems.find(i=>i.id===id)})).filter(e=>e.item);

  const storeTotals=Object.keys(prices).map(storeName=>{
    let total=0,covered=0,missing=[],wins=0;
    basketItems.forEach(({item,qty})=>{const p=prices[storeName][item.name];if(p!=null){total+=p*qty;covered++;}else missing.push(item.name);});
    return{storeName,total,covered,missing,itemCount:basketItems.length,wins};
  }).sort((a,b)=>b.covered!==a.covered?b.covered-a.covered:a.total-b.total);

  basketItems.forEach(({item})=>{
    const opts=storeTotals.map(s=>({store:s.storeName,price:(prices[s.storeName]||{})[item.name]})).filter(o=>o.price!=null);
    if(!opts.length)return;
    const min=Math.min(...opts.map(o=>o.price));
    opts.filter(o=>o.price===min).forEach(o=>{const s=storeTotals.find(s=>s.storeName===o.store);if(s)s.wins++;});
  });

  const best=storeTotals[0],second=storeTotals[1];
  const savings=second?Math.max(0,second.total-best.total):0;
  const totalUnits=basketItems.reduce((s,e)=>s+e.qty,0);
  document.getElementById('compareSub').textContent=`${basketItems.length} item types · ${totalUnits} units`;

  const pmData=buildPriceMatchList(best.storeName,basketItems,prices);
  APP.lastPmData=pmData;APP.lastComparePrices=prices;APP.lastCompareItems=basketItems;APP.lastStoreTotals=storeTotals;

  let html=`<div class="winner-card fade-in"><div class="winner-label">BEST PRICE FOR YOUR BASKET</div><div class="winner-store">${best.storeName}</div><div class="winner-total">$${best.total.toFixed(2)}</div><div class="winner-saving">${savings>0.01?`Save $${savings.toFixed(2)} vs ${second.storeName}`:`${best.covered} of ${best.itemCount} items found`}</div></div>`;

  // Store Scorecard
  const maxWins=Math.max(...storeTotals.map(s=>s.wins),1);
  html+=`<div style="padding:14px 16px 0"><div style="font-family:'Sora',sans-serif;font-weight:700;font-size:15px;margin-bottom:10px;">🏆 Store Scorecard</div><div style="display:flex;flex-direction:column;gap:6px;">`;
  storeTotals.forEach((s,i)=>{
    const isW=i===0,pct=Math.round(s.wins/basketItems.length*100),barW=Math.round(s.wins/maxWins*100);
    html+=`<div style="background:${isW?'var(--green-bg)':'var(--surface)'};border:1.5px solid ${isW?'var(--green)':'var(--border)'};border-radius:var(--radius);padding:11px 13px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-weight:700;font-size:13px;">${s.storeName}</div>
        <div style="font-size:12px;font-weight:700;color:${isW?'var(--green)':'var(--text3)'};">${s.wins} wins · $${s.total.toFixed(2)}</div>
      </div>
      <div style="height:5px;background:var(--border);border-radius:99px;overflow:hidden;"><div style="height:100%;width:${barW}%;background:${isW?'var(--green)':'var(--amber)'};border-radius:99px;"></div></div>
      <div style="font-size:10px;color:var(--text3);margin-top:4px;">${s.covered}/${s.itemCount} items · cheapest on ${pct}% of items</div>
    </div>`;
  });
  html+=`</div></div>`;

  // Store list
  html+=`<div class="store-list">`;
  storeTotals.forEach((s,i)=>{
    const diff=s.total-best.total,isW=i===0;
    html+=`<div class="store-row${isW?' winner-row':''}"><div class="store-num">${i+1}</div><div class="store-row-info"><div class="store-row-name">${s.storeName}</div><div class="store-row-coverage">${s.covered}/${s.itemCount} items · ${s.wins} cheapest${s.missing.length?` · missing: ${s.missing.slice(0,2).join(', ')}${s.missing.length>2?'…':''}`:''}</div></div><div class="store-row-price"><div class="store-row-total">$${s.total.toFixed(2)}</div><div class="store-row-diff${isW?'':' more'}">${isW?'✓ cheapest':`+$${diff.toFixed(2)}`}</div></div></div>`;
  });
  html+=`</div>`;

  if(pmData.length>0){
    const totalSav=pmData.reduce((s,g)=>s+g.totalSaving,0);
    html+=`<div class="pm-section"><div class="pm-section-title">🏷️ Price Match — Save $${totalSav.toFixed(2)} more</div><div class="pm-explainer"><div class="pm-explainer-icon">💡</div><div class="pm-explainer-text"><strong>Stay at ${best.storeName}</strong> — show the cashier these prices.</div></div>`;
    pmData.forEach(group=>{
      html+=`<div class="pm-card"><div class="pm-store-header"><div class="pm-store-header-left"><div class="pm-store-header-store">📋 Show ${group.competitor} prices</div><div class="pm-store-header-action">${group.items.length} item${group.items.length>1?'s':''}</div></div><div class="pm-store-header-saving">-$${group.totalSaving.toFixed(2)}</div></div>`;
      group.items.forEach(row=>{const sv=(row.regularPrice-row.matchPrice)*row.qty;html+=`<div class="pm-row"><div class="pm-item-name">${row.name}${row.qty>1?` ×${row.qty}`:''}</div><div class="pm-prices"><span class="pm-was">$${row.regularPrice.toFixed(2)}</span><span class="pm-match">$${row.matchPrice.toFixed(2)}</span></div><div class="pm-saving-pill">-$${sv.toFixed(2)}</div></div>`;});
      html+=`<div class="pm-cta-row"><button class="pm-cta-btn" onclick="showCashierView('${group.competitor}')">📱 Show these prices to cashier</button></div></div>`;
    });
    html+=`</div>`;
  } else {
    html+=`<div class="all-good-banner"><strong>Already the cheapest!</strong> ${best.storeName} beats every competitor — no price matching needed.</div>`;
  }

  const shareText=savings>0.01?`I saved $${savings.toFixed(2)} shopping at ${best.storeName} — Near & Now! 🛒`:`My basket at ${best.storeName} is $${best.total.toFixed(2)} — Near & Now! 🛒`;
  html+=`<button class="btn-share-savings" onclick="shareResult(${JSON.stringify(shareText)})">📤 Share My Savings</button><button class="btn-split-shop" onclick="showSplitShop()">🗺️ Split Shop — Buy cheapest from each store</button>`;

  document.getElementById('compareContent').innerHTML=html;
  document.getElementById('tab-grocery').scrollTop=0;

  if(savings>0.01){APP.savings=parseFloat((APP.savings+savings).toFixed(2));localStorage.setItem('nn_savings',APP.savings.toString());showSavingsBar();}
};

// Call button injection after grocery loads
const _origUseDemoGrocery = useDemoGrocery;
useDemoGrocery = function() { _origUseDemoGrocery(); setTimeout(injectGroceryButtons,100); };
const _origLoadGrocery = loadGroceryData;
loadGroceryData = async function() { await _origLoadGrocery(); setTimeout(injectGroceryButtons,100); };