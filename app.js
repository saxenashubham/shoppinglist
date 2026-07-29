import { h, render } from "https://esm.sh/preact@10.19.3";
import { useState, useEffect, useMemo } from "https://esm.sh/preact@10.19.3/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, addDoc, writeBatch,
  getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { shoppingListConfig, ALLOWED_EMAILS, EXTRACT_URL } from "./config.js";
const html = htm.bind(h);

/* ============================================================
   2) Firebase init (offline persistence on)
   ============================================================ */
const app = initializeApp(shoppingListConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const CATS = ["Produce","Bakery","Dairy","Meat","Frozen","Spices","Staples","Household","Unsorted"];
const DEFAULT_STORES = [
  { id:"heb", name:"HEB", color:"#e01a2b" },
  { id:"walmart", name:"Walmart", color:"#0071dc" },
  { id:"indian", name:"Indian Store", color:"#cf7a1c" },
];

// first-run seed so the app isn't empty on a fresh project
const SEED_DICT = {
  cilantro:{stores:["heb","walmart","indian"],category:"Produce"},
  onion:{stores:["heb","walmart","indian"],category:"Produce"},
  tomato:{stores:["heb","walmart"],category:"Produce"},
  spinach:{stores:["heb","walmart","indian"],category:"Produce"},
  ginger:{stores:["heb","walmart","indian"],category:"Produce"},
  garlic:{stores:["heb","walmart","indian"],category:"Produce"},
  milk:{stores:["heb","walmart"],category:"Dairy"},
  yogurt:{stores:["heb","walmart","indian"],category:"Dairy"},
  paneer:{stores:["indian"],category:"Dairy"},
  eggs:{stores:["heb","walmart"],category:"Dairy"},
  bread:{stores:["heb","walmart"],category:"Bakery"},
  chicken:{stores:["heb","walmart"],category:"Meat"},
  "basmati rice":{stores:["walmart","indian"],category:"Staples"},
  atta:{stores:["indian"],category:"Staples"},
  "toor dal":{stores:["indian"],category:"Staples"},
  "paper towels":{stores:["heb","walmart"],category:"Household"},
};

/* ============================================================
   3) Helpers
   ============================================================ */
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,120) || "x";

function normalizeName(raw){
  let s = raw.toLowerCase().trim();
  s = s.replace(/^[-*\d\).\s]+/,"");
  s = s.replace(/\b(\d+(\.\d+)?)\s*(lbs?|lb|kg|g|oz|gallons?|gal|dozen|packs?|pkt|bunch(es)?|cans?|bottles?|boxes?|bags?)\b/gi,"");
  s = s.replace(/\b(a|an|some|few|couple of|one|two|three|four|five)\b/gi,"");
  return s.replace(/\s+/g," ").trim();
}
function splitBlob(t){
  return t.split(/\r?\n|,|;|•|\u2022|\band\b/i).map(x=>x.trim()).filter(Boolean).map(normalizeName).filter(Boolean);
}
function lookup(dict, name){
  if(dict[name]) return dict[name];
  for(const k of Object.keys(dict)){
    if(name===k) return dict[k];
    if(name.length>3 && (name.includes(k)||k.includes(name))) return dict[k];
  }
  return null;
}
async function routeUnknowns(names, stores){
  const res = await fetch(WORKER_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ items:names, stores })
  });
  if(!res.ok) throw new Error("worker "+res.status);
  const arr = await res.json();
  const out = {};
  const ids = stores.map(s=>s.id);
  for(const r of (arr||[])){
    const nm = normalizeName(r.name||"");
    if(!nm) continue;
    out[nm] = {
      stores:(r.stores||[]).filter(s=>ids.includes(s)),
      category: CATS.includes(r.category)?r.category:"Unsorted"
    };
  }
  return out;
}

/* ============================================================
   4) App
   ============================================================ */
function App(){
  const [user,setUser] = useState(undefined);   // undefined=loading, null=signed out
  const [stores,setStores] = useState(DEFAULT_STORES);
  const [dict,setDict] = useState({});
  const [list,setList] = useState([]);
  const [tab,setTab] = useState("add");
  const [store,setStore] = useState("heb");
  const [draft,setDraft] = useState("");
  const [parsing,setParsing] = useState(false);
  const [review,setReview] = useState([]);
  const [toast,setToast] = useState("");
  const [online,setOnline] = useState(navigator.onLine);

  const flash = m => { setToast(m); setTimeout(()=>setToast(""),1800); };

  // auth
  useEffect(()=> onAuthStateChanged(auth, u=>{
    if(u && !ALLOWED_EMAILS.includes((u.email||"").toLowerCase())){ signOut(auth); setUser(null); return; }
    setUser(u||null);
  }),[]);

  // online status
  useEffect(()=>{
    const on=()=>setOnline(true), off=()=>setOnline(false);
    addEventListener("online",on); addEventListener("offline",off);
    return ()=>{ removeEventListener("online",on); removeEventListener("offline",off); };
  },[]);

  // subscriptions (only when signed in)
  useEffect(()=>{
    if(!user) return;
    (async()=>{
      // seed config + dictionary once
      const cfgRef = doc(db,"shoppinglist_config","app");
      const cfg = await getDoc(cfgRef);
      if(!cfg.exists()){
        await setDoc(cfgRef,{ stores:DEFAULT_STORES, categories:CATS });
        const b = writeBatch(db);
        for(const [k,v] of Object.entries(SEED_DICT)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{ name:k, ...v });
        await b.commit();
      }
    })();
    const u1 = onSnapshot(doc(db,"shoppinglist_config","app"), d=>{ if(d.exists()&&d.data().stores) setStores(d.data().stores); });
    const u2 = onSnapshot(collection(db,"shoppinglist_dictionary"), snap=>{
      const m={}; snap.forEach(d=>{ const x=d.data(); m[x.name||d.id]={stores:x.stores||[],category:x.category||"Unsorted"}; });
      setDict(m);
    });
    const u3 = onSnapshot(collection(db,"shoppinglist_list"), snap=>{
      const arr=[]; snap.forEach(d=>arr.push({ id:d.id, ...d.data() })); setList(arr);
    });
    return ()=>{ u1(); u2(); u3(); };
  },[user]);

  async function signIn(){
    try{ await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch(e){ flash("Sign-in failed"); }
  }

  async function addItems(){
    const names = splitBlob(draft);
    if(!names.length) return;
    const unknown = names.filter(n=>!lookup(dict,n));
    let learned = {};
    if(unknown.length){
      setParsing(true);
      try{ learned = await routeUnknowns([...new Set(unknown)], stores); }
      catch(e){ for(const n of unknown) learned[n]={stores:[],category:"Unsorted"}; flash("Couldn't reach parser — assign new items below"); }
      setParsing(false);
    }
    const merged = {...dict, ...learned};
    const existing = new Set(list.map(i=>i.key));
    const b = writeBatch(db);
    const reviewed = [];
    // persist newly learned dictionary entries
    for(const [k,v] of Object.entries(learned)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{ name:k, ...v });
    for(const n of names){
      const meta = lookup(merged,n) || learned[n];
      if(!meta || existing.has(n)) continue;
      existing.add(n);
      b.set(doc(collection(db,"shoppinglist_list")), {
        key:n, name:n, stores:[...(meta.stores||[])], category:meta.category||"Unsorted",
        checked:false, addedBy:(user.email||"").split("@")[0], ts:serverTimestamp()
      });
      if(learned[n]) reviewed.push(n);
    }
    await b.commit();
    setReview(reviewed); setDraft(""); setTab("shop");
  }

  async function toggleReviewStore(key, sid){
    const cur = dict[key] || {stores:[],category:"Unsorted"};
    const stores2 = cur.stores.includes(sid) ? cur.stores.filter(x=>x!==sid) : [...cur.stores,sid];
    await setDoc(doc(db,"shoppinglist_dictionary",slug(key)), { name:key, stores:stores2, category:cur.category }, {merge:true});
    // update any live list rows for this item
    const b = writeBatch(db);
    list.filter(i=>i.key===key).forEach(i=>b.set(doc(db,"shoppinglist_list",i.id), {stores:stores2}, {merge:true}));
    await b.commit();
  }

  async function toggle(it){
    await setDoc(doc(db,"shoppinglist_list",it.id), { checked:!it.checked }, {merge:true});
  }
  async function markBought(){
    const done = list.filter(i=>i.checked);
    if(!done.length) return;
    const b = writeBatch(db);
    done.forEach(i=>b.delete(doc(db,"shoppinglist_list",i.id)));  // one row, N stores -> clears everywhere
    await b.commit();
    flash(done.length+" marked bought");
  }

  const checkedCount = list.filter(i=>i.checked).length;
  const scolor = id => (stores.find(s=>s.id===id)||{}).color || "#ccc";
  const storeCounts = useMemo(()=>{
    const m={}; for(const s of stores) m[s.id]=list.filter(i=>i.stores.includes(s.id)&&!i.checked).length; return m;
  },[list,stores]);
  const grouped = useMemo(()=>{
    const items = list.filter(i=>i.stores.includes(store));
    const byCat={}; for(const it of items){ (byCat[it.category] ||= []).push(it); }
    return CATS.filter(c=>byCat[c]).map(c=>({ cat:c,
      items: byCat[c].slice().sort((a,b)=>(a.checked-b.checked)||a.name.localeCompare(b.name)) }));
  },[list,store]);

  const check = html`<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  if(user===undefined) return html`<div class="gate"><div class="brand">Cartpath<span class="dot">.</span></div><p>Loading…</p></div>`;
  if(user===null) return html`
    <div class="gate">
      <div class="brand">Cartpath<span class="dot">.</span></div>
      <p>Your shared grocery list. Sign in with the household Google account.</p>
      <button class="primary" onClick=${signIn}>Sign in with Google</button>
    </div>`;

  return html`
    <div class="top">
      <div class="brand">Cartpath<span class="dot">.</span></div>
      <div class="who">${(user.email||"").split("@")[0]} <button onClick=${()=>signOut(auth)}>Sign out</button></div>
    </div>

    ${!online && html`<div class="banner offline"><span>Offline — changes save and sync when you're back</span></div>`}
    ${online && checkedCount>0 && tab!=="shop" && html`
      <div class="banner"><span>${checkedCount} checked, not submitted</span>
        <button onClick=${()=>setTab("shop")}>Review</button></div>`}

    <div class="seg">
      <button class=${tab==="add"?"on":""} onClick=${()=>setTab("add")}>Add items</button>
      <button class=${tab==="shop"?"on":""} onClick=${()=>setTab("shop")}>Shop</button>
    </div>

    ${tab==="add" && html`
      <div class="addwrap">
        <div class="lead">Paste your voice list</div>
        <div class="hint">Dump whatever you dictated — Alexa, WhatsApp, Notes. One line or comma-separated, quantities are fine. Cartpath splits it and files each item to the right store.</div>
        <textarea placeholder=${"2 lbs onions\ncilantro\npaneer\nmilk\ntoor dal"} value=${draft} onInput=${e=>setDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${parsing||!draft.trim()} onClick=${addItems}>
          ${parsing ? html`<span class="spin"></span>Routing items…` : "Add to list"}
        </button>
        ${review.length>0 && html`
          <div class="review">
            <h4>New items learned — fix any store</h4>
            ${review.map(k=>{ const meta=dict[k]||{stores:[],category:"Unsorted"}; return html`
              <div class="rrow">
                <span class="rname">${k}</span><span class="rcat">${meta.category}</span>
                ${stores.map(s=>html`
                  <button class=${"chip mini"+(meta.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color}
                    onClick=${()=>toggleReviewStore(k,s.id)}>
                    <span class="swatch" style=${"background:"+s.color}></span>${s.name}
                  </button>`)}
              </div>`;})}
            <div style="padding:8px 0 2px"><button class="ghost" onClick=${()=>setReview([])}>Looks good</button></div>
          </div>`}
      </div>`}

    ${tab==="shop" && html`
      <div>
        <div class="stores">
          ${stores.map(s=>html`
            <button class=${"chip"+(store===s.id?" on":"")} style=${"--sc:"+s.color} onClick=${()=>setStore(s.id)}>
              <span class="swatch" style=${"background:"+s.color}></span>${s.name}
              ${storeCounts[s.id]>0 && html`<span class="n">${storeCounts[s.id]}</span>`}
            </button>`)}
        </div>
        ${grouped.length===0 ? html`
          <div class="empty"><div class="big">Nothing for ${(stores.find(s=>s.id===store)||{}).name} yet</div>Add items, or switch stores above.</div>`
        : grouped.map(g=>html`
          <div>
            <div class="cat">${g.cat}</div>
            ${g.items.map(it=>html`
              <div class=${"item"+(it.checked?" done":"")} style=${"--sc:"+scolor(store)} onClick=${()=>toggle(it)}>
                <div class="box">${check}</div>
                <div class="label">${it.name}
                  ${it.stores.length>1 && html`<div class="also">
                    ${it.stores.filter(x=>x!==store).map(x=>html`<i style=${"background:"+scolor(x)}></i>`)}</div>`}
                </div>
              </div>`)}
          </div>`)}
      </div>`}

    ${checkedCount>0 && html`
      <div class="submitbar"><div class="inner">
        <button class="primary" style="width:100%" onClick=${markBought}>Mark ${checkedCount} bought</button>
      </div></div>`}
    ${toast && html`<div class="toast">${toast}</div>`}
  `;
}

render(html`<${App}/>`, document.getElementById("app"));

// register service worker
if("serviceWorker" in navigator){
  addEventListener("load", ()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
