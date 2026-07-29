import { h, render } from "https://esm.sh/preact@10.19.3";
import { useState, useEffect, useMemo } from "https://esm.sh/preact@10.19.3/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, writeBatch, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { shoppingListConfig, ALLOWED_EMAILS, WORKER_URL } from "./config.js";

const html = htm.bind(h);


const appFb = initializeApp(shoppingListConfig);
const auth = getAuth(appFb);
const db = initializeFirestore(appFb, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const CATS = ["Produce","Bakery","Dairy","Meat","Frozen","Spices","Staples","Household","Unsorted"];
const DEFAULT_STORES = [
  { id:"heb", name:"HEB", color:"#e01a2b" },
  { id:"walmart", name:"Walmart", color:"#0071dc" },
  { id:"indian", name:"Indian Store", color:"#cf7a1c" },
];
const STORE_SWATCHES = ["#e01a2b","#0071dc","#cf7a1c","#2f6b4f","#7a4fd0","#128a7c","#c0398b","#b06a12"];
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

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,120) || "x";
const todayISO = () => new Date().toISOString().slice(0,10);
const daysUntil = iso => Math.ceil((new Date(iso+"T00:00:00") - new Date(new Date().toDateString())) / 86400000);

function normalizeName(raw){
  let s = raw.toLowerCase().trim();
  s = s.replace(/^[-*\d\).\s]+/,"");
  s = s.replace(/\b(\d+(\.\d+)?)\s*(lbs?|lb|kg|g|oz|gallons?|gal|dozen|packs?|pkt|bunch(es)?|cans?|bottles?|boxes?|bags?)\b/gi,"");
  s = s.replace(/\b(a|an|some|few|couple of|one|two|three|four|five)\b/gi,"");
  return s.replace(/\s+/g," ").trim();
}
const splitBlob = t => t.split(/\r?\n|,|;|\u2022|\band\b/i).map(x=>x.trim()).filter(Boolean).map(normalizeName).filter(Boolean);
function lookup(dict, name){
  if(dict[name]) return dict[name];
  for(const k of Object.keys(dict)){
    if(name===k) return dict[k];
    if(name.length>3 && (name.includes(k)||k.includes(name))) return dict[k];
  }
  return null;
}
async function routeUnknowns(names, stores){
  const res = await fetch(WORKER_URL,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({items:names,stores})});
  if(!res.ok) throw new Error("worker "+res.status);
  const arr = await res.json();
  const out={}, ids=stores.map(s=>s.id);
  for(const r of (arr||[])){
    const nm=normalizeName(r.name||""); if(!nm) continue;
    out[nm]={stores:(r.stores||[]).filter(s=>ids.includes(s)),category:CATS.includes(r.category)?r.category:"Unsorted"};
  }
  return out;
}

function Panel({title, count, color, open, onToggle, children}){
  return html`
    <div class="panel">
      <button class="phead" onClick=${onToggle}>
        <span class="ptitle">${color?html`<i class="pdot" style=${"background:"+color}></i>`:null}${title}</span>
        <span class="pright"><span class="pcount">${count}</span><span class=${"caret"+(open?" up":"")}>\u25be</span></span>
      </button>
      ${open?html`<div class="pbody">${children}</div>`:null}
    </div>`;
}

function App(){
  const [user,setUser]=useState(undefined);
  const [stores,setStores]=useState(DEFAULT_STORES);
  const [dict,setDict]=useState({});
  const [list,setList]=useState([]);
  const [purch,setPurch]=useState([]);
  const [page,setPage]=useState("list");
  const [shopStore,setShopStore]=useState(null);
  const [draft,setDraft]=useState("");
  const [parsing,setParsing]=useState(false);
  const [review,setReview]=useState([]);
  const [collapsed,setCollapsed]=useState({});
  const [toast,setToast]=useState("");
  const [online,setOnline]=useState(navigator.onLine);
  const [showAdd,setShowAdd]=useState(false);
  const [storeModal,setStoreModal]=useState(false);
  const [newStore,setNewStore]=useState({name:"",color:STORE_SWATCHES[3]});
  const [retModal,setRetModal]=useState(null);
  const [retDate,setRetDate]=useState("");
  const [pendingOnly,setPendingOnly]=useState(false);
  const [pFilterStore,setPFilterStore]=useState("all");
  const [pFilterRange,setPFilterRange]=useState("30");

  const flash=m=>{setToast(m);setTimeout(()=>setToast(""),1800);};
  const scolor=id=>(stores.find(s=>s.id===id)||{}).color||"#ccc";
  const sname=id=>(stores.find(s=>s.id===id)||{}).name||id;
  const toggleCat=key=>setCollapsed(c=>({...c,[key]:!c[key]}));

  useEffect(()=>onAuthStateChanged(auth,u=>{
    if(u && !ALLOWED_EMAILS.includes((u.email||"").toLowerCase())){signOut(auth);setUser(null);return;}
    setUser(u||null);
  }),[]);
  useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false);
    addEventListener("online",on);addEventListener("offline",off);
    return()=>{removeEventListener("online",on);removeEventListener("offline",off);};},[]);

  useEffect(()=>{
    if(!user) return;
    (async()=>{
      const cfgRef=doc(db,"shoppinglist_config","app");
      const cfg=await getDoc(cfgRef);
      if(!cfg.exists()){
        await setDoc(cfgRef,{stores:DEFAULT_STORES,categories:CATS});
        const b=writeBatch(db);
        for(const [k,v] of Object.entries(SEED_DICT)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{name:k,...v});
        await b.commit();
      }
    })();
    const u1=onSnapshot(doc(db,"shoppinglist_config","app"),d=>{if(d.exists()&&d.data().stores){const s=d.data().stores;setStores(s);setShopStore(p=>p||(s[0]&&s[0].id)||null);}});
    const u2=onSnapshot(collection(db,"shoppinglist_dictionary"),snap=>{const m={};snap.forEach(d=>{const x=d.data();m[x.name||d.id]={stores:x.stores||[],category:x.category||"Unsorted"};});setDict(m);});
    const u3=onSnapshot(collection(db,"shoppinglist_list"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setList(a);});
    const u4=onSnapshot(collection(db,"shoppinglist_purchased"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setPurch(a);});
    return()=>{u1();u2();u3();u4();};
  },[user]);

  async function signIn(){try{await signInWithPopup(auth,new GoogleAuthProvider());}catch{flash("Sign-in failed");}}

  async function addItems(){
    const names=splitBlob(draft); if(!names.length) return;
    const unknown=names.filter(n=>!lookup(dict,n));
    let learned={};
    if(unknown.length){setParsing(true);
      try{learned=await routeUnknowns([...new Set(unknown)],stores);}
      catch{for(const n of unknown) learned[n]={stores:[],category:"Unsorted"};flash("Parser unreachable \u2014 assign new items below");}
      setParsing(false);}
    const merged={...dict,...learned};
    const existing=new Set(list.map(i=>i.key));
    const b=writeBatch(db); const reviewed=[];
    for(const [k,v] of Object.entries(learned)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{name:k,...v});
    for(const n of names){
      const meta=lookup(merged,n)||learned[n]; if(!meta||existing.has(n)) continue; existing.add(n);
      b.set(doc(collection(db,"shoppinglist_list")),{key:n,name:n,stores:[...(meta.stores||[])],category:meta.category||"Unsorted",checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
      if(learned[n]) reviewed.push(n);
    }
    await b.commit(); setReview(reviewed); setDraft(""); setShowAdd(false);
  }
  async function toggleReviewStore(key,sid){
    const cur=dict[key]||{stores:[],category:"Unsorted"};
    const st=cur.stores.includes(sid)?cur.stores.filter(x=>x!==sid):[...cur.stores,sid];
    await setDoc(doc(db,"shoppinglist_dictionary",slug(key)),{name:key,stores:st,category:cur.category},{merge:true});
    const b=writeBatch(db); list.filter(i=>i.key===key).forEach(i=>b.set(doc(db,"shoppinglist_list",i.id),{stores:st},{merge:true})); await b.commit();
  }
  const toggle=it=>setDoc(doc(db,"shoppinglist_list",it.id),{checked:!it.checked},{merge:true});

  async function markBought(){
    const done=list.filter(i=>i.stores.includes(shopStore)&&i.checked); if(!done.length) return;
    const b=writeBatch(db);
    for(const i of done){
      b.set(doc(collection(db,"shoppinglist_purchased")),{name:i.name,store:shopStore,date:todayISO(),status:"purchased",ts:serverTimestamp()});
      b.delete(doc(db,"shoppinglist_list",i.id));
    }
    await b.commit(); flash(done.length+" marked bought");
  }
  async function addStore(){
    const nm=newStore.name.trim(); if(!nm) return;
    const id=slug(nm); if(stores.some(s=>s.id===id)){flash("Store already exists");return;}
    await setDoc(doc(db,"shoppinglist_config","app"),{stores:[...stores,{id,name:nm,color:newStore.color}]},{merge:true});
    setStoreModal(false); setNewStore({name:"",color:STORE_SWATCHES[3]}); flash(nm+" added");
  }
  async function confirmReturn(){
    if(!retDate||!retModal) return;
    await setDoc(doc(db,"shoppinglist_purchased",retModal.id),{status:"returning",returnByDate:retDate},{merge:true});
    setRetModal(null); setRetDate("");
  }
  const resolveReturn=(id,status)=>setDoc(doc(db,"shoppinglist_purchased",id),{status},{merge:true});

  const returning=purch.filter(p=>p.status==="returning");
  const dueReturns=returning.filter(p=>p.returnByDate && daysUntil(p.returnByDate)<=5)
    .sort((a,b)=>daysUntil(a.returnByDate)-daysUntil(b.returnByDate));
  const overdue=dueReturns.some(p=>daysUntil(p.returnByDate)<0);

  function groupByCat(items, keyPrefix){
    const byCat={}; for(const it of items){(byCat[it.category]||=[]).push(it);}
    return CATS.filter(c=>byCat[c]).map(c=>{
      const key=keyPrefix+":"+c;
      const its=byCat[c].slice().sort((a,b)=>((a.checked?1:0)-(b.checked?1:0))||a.name.localeCompare(b.name));
      return {cat:c,key,items:its,open:!collapsed[key]};
    });
  }
  const listGroups=useMemo(()=>groupByCat(list,"list"),[list,collapsed]);
  const shopItems=useMemo(()=>list.filter(i=>i.stores.includes(shopStore)),[list,shopStore]);
  const shopGroups=useMemo(()=>groupByCat(shopItems,"shop:"+shopStore),[shopItems,collapsed,shopStore]);
  const shopChecked=shopItems.filter(i=>i.checked).length;

  const filteredPurch=useMemo(()=>{
    let ps=purch.slice();
    if(pendingOnly) ps=ps.filter(p=>p.status==="returning");
    if(pFilterStore!=="all") ps=ps.filter(p=>p.store===pFilterStore);
    if(pFilterRange!=="all"){const lim=parseInt(pFilterRange,10);
      ps=ps.filter(p=>{const d=(new Date()-new Date(p.date+"T00:00:00"))/86400000; return d<=lim;});}
    return ps.sort((a,b)=>{
      const ap=a.status==="returning"?daysUntil(a.returnByDate||"2999-01-01"):9e9;
      const bp=b.status==="returning"?daysUntil(b.returnByDate||"2999-01-01"):9e9;
      if(ap!==bp) return ap-bp;
      return (b.date||"").localeCompare(a.date||"");
    });
  },[purch,pendingOnly,pFilterStore,pFilterRange]);

  const check=html`<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  if(user===undefined) return html`<div class="gate"><div class="brand">Cartpath<span class="dot">.</span></div><p>Loading\u2026</p></div>`;
  if(user===null) return html`<div class="gate"><div class="brand">Cartpath<span class="dot">.</span></div>
    <p>Your shared grocery list. Sign in with the household Google account.</p>
    <button class="primary" onClick=${signIn}>Sign in with Google</button></div>`;

  return html`
    <div class="top">
      <div class="brand">Cartpath<span class="dot">.</span></div>
      <div class="who">${(user.email||"").split("@")[0]} <button onClick=${()=>signOut(auth)}>Sign out</button></div>
    </div>

    ${!online?html`<div class="banner offline">Offline \u2014 changes sync when you're back</div>`:null}
    ${dueReturns.length>0?html`
      <div class=${"banner ret"+(overdue?" over":"")}>
        <span>${overdue?"\u26a0 Return overdue":"\u23f3 "+dueReturns.length+" return"+(dueReturns.length>1?"s":"")+" due soon"}</span>
        <button onClick=${()=>{setPage("purchased");setPendingOnly(true);}}>Show</button>
      </div>`:null}

    <div class="tabs">
      <button class=${page==="list"?"on":""} onClick=${()=>setPage("list")}>List</button>
      <button class=${page==="shop"?"on":""} onClick=${()=>setPage("shop")}>Shop</button>
      <button class=${page==="purchased"?"on":""} onClick=${()=>setPage("purchased")}>Purchased</button>
    </div>

    ${page==="list"?html`
      <div class="pagehead">
        <button class="primary sm" onClick=${()=>setShowAdd(true)}>+ Add items</button>
        <button class="ghost" onClick=${()=>setStoreModal(true)}>Manage stores</button>
      </div>
      ${list.length===0
        ? html`<div class="empty"><div class="big">List is empty</div>Tap \u201cAdd items\u201d to paste your voice list.</div>`
        : listGroups.map(g=>html`
          <${Panel} title=${g.cat} count=${g.items.length} open=${g.open} onToggle=${()=>toggleCat(g.key)}>
            ${g.items.map(it=>html`
              <div class="lrow">
                <span class="lname">${it.name}</span>
                <span class="lstores">${it.stores.length
                  ? it.stores.map(s=>html`<i class="sq" style=${"background:"+scolor(s)} title=${sname(s)}></i>`)
                  : html`<em class="uns">unsorted</em>`}</span>
              </div>`)}
          <//>`)}`:null}

    ${page==="shop"?html`
      <div class="stores">
        ${stores.map(s=>html`
          <button class=${"chip"+(shopStore===s.id?" on":"")} style=${"--sc:"+s.color} onClick=${()=>setShopStore(s.id)}>
            <span class="sq" style=${"background:"+s.color}></span>${s.name}
            ${(list.filter(i=>i.stores.includes(s.id)&&!i.checked).length)>0?html`<span class="n">${list.filter(i=>i.stores.includes(s.id)&&!i.checked).length}</span>`:null}
          </button>`)}
      </div>
      ${shopGroups.length===0
        ? html`<div class="empty"><div class="big">Nothing for ${sname(shopStore)} yet</div>Add items on the List tab.</div>`
        : shopGroups.map(g=>{
            const allDone=g.items.every(i=>i.checked);
            const open=allDone?false:g.open;
            return html`
            <${Panel} title=${g.cat} count=${g.items.filter(i=>!i.checked).length+"/"+g.items.length} color=${scolor(shopStore)} open=${open} onToggle=${()=>toggleCat(g.key)}>
              ${g.items.map(it=>html`
                <div class=${"item"+(it.checked?" done":"")} style=${"--sc:"+scolor(shopStore)} onClick=${()=>toggle(it)}>
                  <div class="box">${check}</div>
                  <div class="label">${it.name}
                    ${it.stores.length>1?html`<div class="also">${it.stores.filter(x=>x!==shopStore).map(x=>html`<i style=${"background:"+scolor(x)}></i>`)}</div>`:null}
                  </div>
                </div>`)}
            <//>`;})}`:null}

    ${page==="purchased"?html`
      <div class="filters">
        <button class=${"fbtn"+(pendingOnly?" on":"")} onClick=${()=>setPendingOnly(p=>!p)}>Pending returns</button>
        <select value=${pFilterStore} onChange=${e=>setPFilterStore(e.target.value)}>
          <option value="all">All stores</option>
          ${stores.map(s=>html`<option value=${s.id}>${s.name}</option>`)}
        </select>
        <select value=${pFilterRange} onChange=${e=>setPFilterRange(e.target.value)}>
          <option value="7">7 days</option><option value="30">30 days</option>
          <option value="90">90 days</option><option value="all">All time</option>
        </select>
      </div>
      ${filteredPurch.length===0
        ? html`<div class="empty"><div class="big">No purchases</div>Items you mark bought show up here.</div>`
        : filteredPurch.map(p=>{
            const ret=p.status==="returning"; const d=ret?daysUntil(p.returnByDate):null;
            return html`
            <div class=${"prow"+(ret?(d<0?" over":d<=5?" due":""):"")}>
              <div class="pinfo">
                <span class="pname">${p.name}</span>
                <span class="pmeta"><i class="sq" style=${"background:"+scolor(p.store)}></i>${sname(p.store)} \u00b7 ${p.date}
                  ${ret?html`\u00b7 <b>${d<0?"overdue":"return in "+d+"d"}</b>`:null}</span>
              </div>
              <div class="pact">
                ${(!ret && p.status!=="returned" && p.status!=="kept")?html`<button class="ghost" onClick=${()=>{setRetModal(p);setRetDate("");}}>Return</button>`:null}
                ${ret?html`<button class="ghost" onClick=${()=>resolveReturn(p.id,"returned")}>Returned</button>
                              <button class="ghost mut" onClick=${()=>resolveReturn(p.id,"kept")}>Keeping</button>`:null}
                ${(p.status==="returned"||p.status==="kept")?html`<span class="tag">${p.status}</span>`:null}
              </div>
            </div>`;})}`:null}

    ${showAdd?html`
      <div class="scrim" onClick=${()=>setShowAdd(false)}></div>
      <div class="sheet">
        <div class="lead">Paste your voice list</div>
        <div class="hint">Alexa, WhatsApp, Notes \u2014 one line or comma-separated. Cartpath splits it and files each item to the right store.</div>
        <textarea placeholder=${"2 lbs onions\ncilantro\npaneer\nmilk\ntoor dal"} value=${draft} onInput=${e=>setDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${parsing||!draft.trim()} onClick=${addItems}>${parsing?html`<span class="spin"></span>Routing\u2026`:"Add to list"}</button>
      </div>`:null}
    ${review.length>0?html`
      <div class="scrim" onClick=${()=>setReview([])}></div>
      <div class="sheet">
        <div class="lead">New items \u2014 fix any store</div>
        ${review.map(k=>{const meta=dict[k]||{stores:[],category:"Unsorted"};return html`
          <div class="rrow"><span class="rname">${k}</span><span class="rcat">${meta.category}</span>
            ${stores.map(s=>html`<button class=${"chip mini"+(meta.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleReviewStore(k,s.id)}>
              <span class="sq" style=${"background:"+s.color}></span>${s.name}</button>`)}
          </div>`;})}
        <button class="primary" onClick=${()=>setReview([])}>Done</button>
      </div>`:null}

    ${storeModal?html`
      <div class="scrim" onClick=${()=>setStoreModal(false)}></div>
      <div class="sheet">
        <div class="lead">Stores</div>
        <div class="storelist">${stores.map(s=>html`<div class="srow"><i class="sq" style=${"background:"+s.color}></i>${s.name}</div>`)}</div>
        <div class="lead" style="margin-top:8px">Add a store</div>
        <input class="tin" placeholder="Store name" value=${newStore.name} onInput=${e=>setNewStore(n=>({...n,name:e.target.value}))} />
        <div class="swatches">${STORE_SWATCHES.map(c=>html`<button class=${"sw"+(newStore.color===c?" on":"")} style=${"background:"+c} onClick=${()=>setNewStore(n=>({...n,color:c}))}></button>`)}</div>
        <button class="primary" disabled=${!newStore.name.trim()} onClick=${addStore}>Add store</button>
      </div>`:null}

    ${retModal?html`
      <div class="scrim" onClick=${()=>setRetModal(null)}></div>
      <div class="sheet">
        <div class="lead">Return \u201c${retModal.name}\u201d</div>
        <div class="hint">Bought at ${sname(retModal.store)} on ${retModal.date}. Enter the return-by date \u2014 a red banner appears within 5 days of it.</div>
        <input class="tin" type="date" value=${retDate} min=${todayISO()} onInput=${e=>setRetDate(e.target.value)} />
        <button class="primary" disabled=${!retDate} onClick=${confirmReturn}>Mark for return</button>
      </div>`:null}

    ${(page==="shop" && shopChecked>0)?html`
      <div class="submitbar"><div class="inner"><button class="primary" style="width:100%" onClick=${markBought}>Mark ${shopChecked} bought at ${sname(shopStore)}</button></div></div>`:null}
    ${toast?html`<div class="toast">${toast}</div>`:null}
  `;
}
render(html`<${App}/>`, document.getElementById("app"));
if("serviceWorker" in navigator) addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
