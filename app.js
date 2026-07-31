import { h, render } from "https://esm.sh/preact@10.19.3";
import { useState, useEffect, useMemo } from "https://esm.sh/preact@10.19.3/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref as sref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { shoppingListConfig, ALLOWED_EMAILS, WORKER_URL } from "./config.js";

const html = htm.bind(h);

const appFb = initializeApp(shoppingListConfig);
const auth = getAuth(appFb);
const db = initializeFirestore(appFb, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const storage = getStorage(appFb);
const RETURNS_DIR = "basketly/returns";  // own folder, separate from the finance app's receipts

const CATS = ["Produce","Bakery","Dairy","Meat","Frozen","Spices","Staples","Household","Unsorted"];
const DEFAULT_STORES = [
  { id:"heb", name:"HEB", color:"#f2a7a1" },
  { id:"walmart", name:"Walmart", color:"#a8c8ec" },
  { id:"indian", name:"Indian Store", color:"#f2c79b" },
];
const STORE_SWATCHES = ["#f2a7a1","#a8c8ec","#f2c79b","#a9d8b8","#c9b8e8","#9ad9d2","#f0b6d3","#e0cfa0"];
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
const cfgDoc = () => doc(db,"shoppinglist_config","app");

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
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(), 20000);
  try{
    const res = await fetch(WORKER_URL,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({items:names,stores}),signal:ctrl.signal});
    if(!res.ok) throw new Error("worker "+res.status);
    const arr = await res.json();
    const out={}, ids=stores.map(s=>s.id);
    for(const r of (arr||[])){
      const nm=normalizeName(r.name||""); if(!nm) continue;
      out[nm]={stores:(r.stores||[]).filter(s=>ids.includes(s)),category:CATS.includes(r.category)?r.category:"Unsorted"};
    }
    return out;
  } finally { clearTimeout(t); }
}

function Spin({g}){ return html`<span class=${"spin"+(g?" g":"")}></span>`; }
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
function Loader({label}){
  return html`<div class="loader"><span class="spin g big"></span><span>${label||"Loading\u2026"}</span></div>`;
}

function App(){
  const [user,setUser]=useState(undefined);
  const [loading,setLoading]=useState(true);
  const [stores,setStores]=useState(DEFAULT_STORES);
  const [dict,setDict]=useState({});
  const [list,setList]=useState([]);
  const [purch,setPurch]=useState([]);
  const [page,setPage]=useState("list");
  const [checkedIn,setCheckedIn]=useState(null);
  const [draft,setDraft]=useState("");
  const [parsing,setParsing]=useState(false);
  const [review,setReview]=useState([]);
  const [assignList,setAssignList]=useState([]);
  const [collapsed,setCollapsed]=useState({});
  const [toast,setToast]=useState("");
  const [online,setOnline]=useState(navigator.onLine);
  const [busy,setBusy]=useState({});
  const [showAdd,setShowAdd]=useState(false);
  const [storeModal,setStoreModal]=useState(false);
  const [storeDraft,setStoreDraft]=useState([]);
  const [newStore,setNewStore]=useState({name:"",color:STORE_SWATCHES[3]});
  const [delStore,setDelStore]=useState(null);
  const [reassign,setReassign]=useState({});
  const [itemModal,setItemModal]=useState(null);
  const [editCat,setEditCat]=useState("Unsorted");
  const [editStores,setEditStores]=useState([]);
  const [retModal,setRetModal]=useState(null);
  const [retDate,setRetDate]=useState("");
  const [retFile,setRetFile]=useState(null);
  const [viewImg,setViewImg]=useState(null);
  const [pendingOnly,setPendingOnly]=useState(false);
  const [pFilterStore,setPFilterStore]=useState("all");
  const [pFilterRange,setPFilterRange]=useState("30");
  const [sortBy,setSortBy]=useState("date");
  const [cats,setCats]=useState(CATS);
  const [catModal,setCatModal]=useState(false);
  const [catDraft,setCatDraft]=useState([]);
  const [newCat,setNewCat]=useState("");
  const [staples,setStaples]=useState([]);
  const [staplesModal,setStaplesModal]=useState(false);
  const [stapleSel,setStapleSel]=useState({});
  const [newStaple,setNewStaple]=useState("");
  const [menu,setMenu]=useState(false);

  const flash=m=>{setToast(m);setTimeout(()=>setToast(""),1800);};
  const scolor=id=>(stores.find(s=>s.id===id)||{}).color||"#ccc";
  const sname=id=>(stores.find(s=>s.id===id)||{}).name||id;
  const toggleCat=key=>setCollapsed(c=>({...c,[key]:!c[key]}));
  const isBusy=k=>!!busy[k];
  async function run(key, fn){ setBusy(b=>({...b,[key]:true}));
    try{ await fn(); } catch(e){ flash("Something went wrong"); }
    finally{ setBusy(b=>{const n={...b}; delete n[key]; return n;}); } }

  useEffect(()=>onAuthStateChanged(auth,u=>{
    if(u && !ALLOWED_EMAILS.includes((u.email||"").toLowerCase())){signOut(auth);setUser(null);return;}
    setUser(u||null); if(!u) setLoading(true);
  }),[]);
  useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false);
    addEventListener("online",on);addEventListener("offline",off);
    return()=>{removeEventListener("online",on);removeEventListener("offline",off);};},[]);

  useEffect(()=>{
    if(!user) return;
    (async()=>{
      const cfg=await getDoc(cfgDoc());
      if(!cfg.exists()){
        await setDoc(cfgDoc(),{stores:DEFAULT_STORES,categories:CATS});
        const b=writeBatch(db);
        for(const [k,v] of Object.entries(SEED_DICT)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{name:k,...v});
        await b.commit();
      }
    })();
    const u1=onSnapshot(cfgDoc(),d=>{if(d.exists()){const dd=d.data();
      if(dd.stores){setStores(dd.stores);}
      if(dd.categories&&dd.categories.length) setCats(dd.categories.includes("Unsorted")?dd.categories:[...dd.categories,"Unsorted"]);}});
    const u2=onSnapshot(collection(db,"shoppinglist_dictionary"),snap=>{const m={};snap.forEach(d=>{const x=d.data();m[x.name||d.id]={stores:x.stores||[],category:x.category||"Unsorted"};});setDict(m);});
    const u3=onSnapshot(collection(db,"shoppinglist_list"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setList(a);setLoading(false);});
    const u4=onSnapshot(collection(db,"shoppinglist_purchased"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setPurch(a);});
    const u5=onSnapshot(collection(db,"shoppinglist_staples"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setStaples(a);});
    return()=>{u1();u2();u3();u4();u5();};
  },[user]);

  async function signIn(){try{await signInWithPopup(auth,new GoogleAuthProvider());}catch{flash("Sign-in failed");}}

  async function addItems(){
    const names=splitBlob(draft); if(!names.length) return;
    const unknown=names.filter(n=>!lookup(dict,n));
    let learned={};
    if(unknown.length){
      setParsing(true);
      try{ learned=await routeUnknowns([...new Set(unknown)],stores); }
      catch{ learned={}; flash("Couldn't reach the parser \u2014 pick a store"); }
      setParsing(false);
    }
    const merged={...dict,...learned};
    const existing=new Set(list.map(i=>i.key));
    const toAdd=[], needAssign=[];
    for(const n of names){
      if(existing.has(n)) continue; existing.add(n);
      const meta=lookup(merged,n)||learned[n]||{stores:[],category:"Unsorted"};
      if((meta.stores||[]).length) toAdd.push({name:n,stores:meta.stores,category:meta.category||"Unsorted"});
      else needAssign.push({name:n,stores:[],category:meta.category||"Unsorted"});
    }
    if(toAdd.length){
      await run("additems", async ()=>{
        const b=writeBatch(db);
        for(const it of toAdd){
          b.set(doc(db,"shoppinglist_dictionary",slug(it.name)),{name:it.name,stores:it.stores,category:it.category});
          b.set(doc(collection(db,"shoppinglist_list")),{key:it.name,name:it.name,stores:[...it.stores],category:it.category,checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
        }
        await b.commit();
      });
      flash(toAdd.length===1 ? `"${toAdd[0].name}" added to ${toAdd[0].category}` : `${toAdd.length} items added`);
    }
    setDraft(""); setShowAdd(false);
    if(needAssign.length) setAssignList(needAssign);
  }
  const updateAssign=(idx,patch)=>setAssignList(a=>a.map((x,i)=>i===idx?{...x,...patch}:x));
  const toggleAssignStore=(idx,sid)=>setAssignList(a=>a.map((x,i)=>i===idx?{...x,stores:x.stores.includes(sid)?x.stores.filter(y=>y!==sid):[...x.stores,sid]}:x));
  async function commitAssign(){
    const items=assignList; if(!items.length){ setAssignList([]); return; }
    await run("assign", async ()=>{
      const b=writeBatch(db);
      for(const it of items){
        const st=it.stores||[];
        b.set(doc(db,"shoppinglist_dictionary",slug(it.name)),{name:it.name,stores:st,category:it.category||"Unsorted"});
        b.set(doc(collection(db,"shoppinglist_list")),{key:it.name,name:it.name,stores:[...st],category:it.category||"Unsorted",checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
      }
      await b.commit();
    });
    flash(items.length===1 ? `"${items[0].name}" added to ${items[0].category}` : `${items.length} items added`);
    setAssignList([]);
  }
  async function toggleReviewStore(key,sid){
    const cur=dict[key]||{stores:[],category:"Unsorted"};
    const st=cur.stores.includes(sid)?cur.stores.filter(x=>x!==sid):[...cur.stores,sid];
    await setDoc(doc(db,"shoppinglist_dictionary",slug(key)),{name:key,stores:st,category:cur.category},{merge:true});
    const b=writeBatch(db); list.filter(i=>i.key===key).forEach(i=>b.set(doc(db,"shoppinglist_list",i.id),{stores:st},{merge:true})); await b.commit();
  }
  const toggle=it=>setDoc(doc(db,"shoppinglist_list",it.id),{checked:!it.checked},{merge:true});

  // ---- item editor: remove, category (remembered), store mapping ----
  function openItem(it){ setItemModal(it); setEditCat(it.category||"Unsorted"); setEditStores([...(it.stores||[])]); }
  const toggleEditStore=sid=>setEditStores(es=>es.includes(sid)?es.filter(x=>x!==sid):[...es,sid]);
  async function saveItem(){
    await run("saveitem", async ()=>{
      const b=writeBatch(db);
      b.set(doc(db,"shoppinglist_list",itemModal.id),{category:editCat,stores:editStores},{merge:true});
      b.set(doc(db,"shoppinglist_dictionary",slug(itemModal.key)),{name:itemModal.key,category:editCat,stores:editStores},{merge:true});
      await b.commit();
    });
    setItemModal(null);
  }
  async function removeCurrentItem(){ await run("removeitem", ()=>deleteDoc(doc(db,"shoppinglist_list",itemModal.id))); setItemModal(null); }
  const removeRow=it=>run("rm_"+it.id, ()=>deleteDoc(doc(db,"shoppinglist_list",it.id)));

  async function checkOut(){
    const store=checkedIn;
    const done=list.filter(i=>i.stores.includes(store)&&i.checked);
    if(done.length){
      await run("checkout", async ()=>{
        const b=writeBatch(db);
        for(const i of done){
          b.set(doc(collection(db,"shoppinglist_purchased")),{name:i.name,store,date:todayISO(),status:"purchased",ts:serverTimestamp()});
          b.delete(doc(db,"shoppinglist_list",i.id));
        }
        await b.commit();
      });
      flash(done.length+" bought at "+sname(store));
    }
    setCheckedIn(null);
  }

  // ---- stores: add / rename / recolor / delete ----
  function openStores(){ setStoreDraft(stores.map(s=>({...s}))); setStoreModal(true); }
  const editDraft=(id,patch)=>setStoreDraft(d=>d.map(s=>s.id===id?{...s,...patch}:s));
  const serStore=s=>({id:s.id,name:(s.name||"").trim()||s.id,color:s.color});
  async function saveStores(){
    await run("savestores", ()=>setDoc(cfgDoc(),{stores:storeDraft.map(serStore)},{merge:true}));
    flash("Stores updated");
  }
  async function addStore(){
    const nm=newStore.name.trim(); if(!nm) return;
    const id=slug(nm); if(storeDraft.some(s=>s.id===id)||stores.some(s=>s.id===id)){flash("Store already exists");return;}
    const next=[...storeDraft,{id,name:nm,color:newStore.color}];
    setStoreDraft(next);
    await run("addstore", ()=>setDoc(cfgDoc(),{stores:next.map(serStore)},{merge:true}));
    setNewStore({name:"",color:STORE_SWATCHES[3]}); flash(nm+" added");
  }
  function orphansOf(sid){ return list.filter(i=>i.stores.includes(sid) && i.stores.filter(x=>x!==sid).length===0); }
  function deleteStore(s){
    if(orphansOf(s.id).length){ setDelStore(s); setReassign({}); return; }
    if(!confirm(`Delete ${s.name}?`)) return;
    commitDelete(s,{});
  }
  async function commitDelete(s, assign){
    await run("delstore_"+s.id, async ()=>{
      const b=writeBatch(db);
      b.set(cfgDoc(),{stores:storeDraft.filter(x=>x.id!==s.id).map(serStore)},{merge:true});
      list.filter(i=>i.stores.includes(s.id)).forEach(i=>{
        let ns=i.stores.filter(x=>x!==s.id);
        if(ns.length===0 && assign[i.id]) ns=[assign[i.id]];
        b.set(doc(db,"shoppinglist_list",i.id),{stores:ns},{merge:true});
        b.set(doc(db,"shoppinglist_dictionary",slug(i.key)),{name:i.key,stores:ns,category:i.category||"Unsorted"},{merge:true});
      });
      Object.entries(dict).forEach(([k,v])=>{ if((v.stores||[]).includes(s.id) && !list.some(i=>i.key===k)) b.set(doc(db,"shoppinglist_dictionary",slug(k)),{stores:v.stores.filter(x=>x!==s.id)},{merge:true}); });
      await b.commit();
    });
    setStoreDraft(d=>d.filter(x=>x.id!==s.id));
    if(checkedIn===s.id) setCheckedIn(null);
    setDelStore(null); setReassign({});
  }

  // ---- categories ----
  function openCats(){ setCatDraft(cats.filter(c=>c!=="Unsorted")); setNewCat(""); setCatModal(true); }
  async function addCat(){
    const c=newCat.trim(); if(!c) return;
    if(cats.some(x=>x.toLowerCase()===c.toLowerCase())){flash("Category exists");return;}
    const next=[...cats.filter(x=>x!=="Unsorted"),c,"Unsorted"];
    await run("addcat", ()=>setDoc(cfgDoc(),{categories:next},{merge:true}));
    setNewCat(""); flash(c+" added");
  }
  async function deleteCat(c){
    const affected=list.filter(i=>(i.category||"Unsorted")===c);
    if(!confirm(`Delete category "${c}"? ${affected.length} item(s) move to Unsorted.`)) return;
    await run("delcat_"+c, async ()=>{
      const b=writeBatch(db);
      b.set(cfgDoc(),{categories:[...cats.filter(x=>x!==c&&x!=="Unsorted"),"Unsorted"]},{merge:true});
      affected.forEach(i=>{ b.set(doc(db,"shoppinglist_list",i.id),{category:"Unsorted"},{merge:true}); b.set(doc(db,"shoppinglist_dictionary",slug(i.key)),{name:i.key,category:"Unsorted"},{merge:true}); });
      await b.commit();
    });
    setCatDraft(d=>d.filter(x=>x!==c));
  }

  // ---- staples ----
  const isStaple=name=>staples.some(s=>s.name===name);
  function toggleStaple(name,st,cat){
    const ref=doc(db,"shoppinglist_staples",slug(name));
    return run("star_"+slug(name), ()=> isStaple(name) ? deleteDoc(ref) : setDoc(ref,{name,stores:st||[],category:cat||"Unsorted"}));
  }
  async function addNewStaple(){
    const nm=normalizeName(newStaple); if(!nm) return;
    const meta=lookup(dict,nm)||{stores:[],category:"Unsorted"};
    await run("addstaple", ()=>setDoc(doc(db,"shoppinglist_staples",slug(nm)),{name:nm,stores:meta.stores||[],category:meta.category||"Unsorted"}));
    setNewStaple("");
  }
  async function addStaplesToList(){
    const existing=new Set(list.map(i=>i.key));
    const add=staples.filter(s=>stapleSel[s.id] && !existing.has(s.name));
    if(!add.length){ setStaplesModal(false); setStapleSel({}); return; }
    await run("addstaples", async ()=>{
      const b=writeBatch(db);
      add.forEach(s=>b.set(doc(collection(db,"shoppinglist_list")),{key:s.name,name:s.name,stores:[...(s.stores||[])],category:s.category||"Unsorted",checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()}));
      await b.commit();
    });
    setStaplesModal(false); setStapleSel({}); flash(add.length+" added to list");
  }

  async function uploadAttach(purchaseId, file){
    if(!file) return;
    const ok = (file.type||"").startsWith("image/") || file.type==="application/pdf";
    if(!ok){ flash("Only image or PDF"); return; }
    if(file.size > 15*1024*1024){ flash("File too large (max 15MB)"); return; }
    await run("attach_"+purchaseId, async ()=>{
      const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-60);
      const path=`${RETURNS_DIR}/${purchaseId}/${Date.now()}_${safe}`;
      const r=sref(storage,path);
      await uploadBytes(r,file);
      const url=await getDownloadURL(r);
      await setDoc(doc(db,"shoppinglist_purchased",purchaseId),{attachUrl:url,attachType:file.type,attachPath:path},{merge:true});
    });
    flash("Attached");
  }
  function openAttachment(p){
    if(!p.attachUrl) return;
    if((p.attachType||"").startsWith("image/")) setViewImg(p.attachUrl);
    else window.open(p.attachUrl,"_blank");
  }
  async function confirmReturn(){
    if(!retDate||!retModal) return;
    const id=retModal.id, file=retFile;
    await run("confirmret", ()=>setDoc(doc(db,"shoppinglist_purchased",id),{status:"returning",returnByDate:retDate},{merge:true}));
    setRetModal(null); setRetDate("");
    if(file){ await uploadAttach(id,file); setRetFile(null); }
  }
  const resolveReturn=(id,status,key)=>run(key, ()=>setDoc(doc(db,"shoppinglist_purchased",id),{status},{merge:true}));

  const returning=purch.filter(p=>p.status==="returning");
  const dueReturns=returning.filter(p=>p.returnByDate && daysUntil(p.returnByDate)<=5).sort((a,b)=>daysUntil(a.returnByDate)-daysUntil(b.returnByDate));
  const overdue=dueReturns.some(p=>daysUntil(p.returnByDate)<0);

  function groupByCat(items, keyPrefix){
    const byCat={}; for(const it of items){(byCat[it.category||"Unsorted"]||=[]).push(it);}
    const order=[...cats.filter(c=>byCat[c]), ...Object.keys(byCat).filter(c=>!cats.includes(c))];
    return order.map(c=>{
      const key=keyPrefix+":"+c;
      const its=byCat[c].slice().sort((a,b)=>((a.checked?1:0)-(b.checked?1:0))||a.name.localeCompare(b.name));
      return {cat:c,key,items:its,open:!collapsed[key]};
    });
  }
  const listGroups=useMemo(()=>groupByCat(list,"list"),[list,collapsed,cats]);
  const shopItems=useMemo(()=>list.filter(i=>i.stores.includes(checkedIn)),[list,checkedIn]);
  const shopGroups=useMemo(()=>groupByCat(shopItems,"shop:"+checkedIn),[shopItems,collapsed,checkedIn,cats]);
  const shopChecked=shopItems.filter(i=>i.checked).length;

  const filteredPurch=useMemo(()=>{
    let ps=purch.slice();
    if(pendingOnly) ps=ps.filter(p=>p.status==="returning");
    if(pFilterStore!=="all") ps=ps.filter(p=>p.store===pFilterStore);
    if(pFilterRange!=="all"){const lim=parseInt(pFilterRange,10);
      ps=ps.filter(p=>{const d=(new Date()-new Date(p.date+"T00:00:00"))/86400000; return d<=lim;});}
    return ps.sort((a,b)=>{
      if(sortBy==="store"){const c=sname(a.store).localeCompare(sname(b.store)); if(c) return c;}
      return (b.date||"").localeCompare(a.date||"");
    });
  },[purch,pendingOnly,pFilterStore,pFilterRange,sortBy,stores]);

  const check=html`<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  if(user===undefined) return html`<div class="gate"><div class="brand">Basketly<span class="dot">.</span></div><${Loader} label="Starting\u2026"/></div>`;
  if(user===null) return html`<div class="gate">
    <img class="gatelogo" src="./icon-512.png" alt="Basketly" />
    <div class="brand">Basketly<span class="dot">.</span></div>
    <p>Your shared grocery list. Sign in with the household Google account.</p>
    <button class="primary" onClick=${signIn}>Sign in with Google</button></div>`;

  return html`
    <div class="top">
      <div class="brand"><img class="brandicon" src="./icon-192.png" alt="" />Basketly<span class="dot">.</span></div>
      <button class="hbtn" onClick=${()=>setMenu(true)} aria-label="Menu">\u2630</button>
    </div>

    ${!online?html`<div class="banner offline">Offline \u2014 changes sync when you're back</div>`:null}
    ${dueReturns.length>0?html`
      <div class=${"banner ret"+(overdue?" over":"")}>
        <span>${overdue?"\u26a0 Return overdue":"\u23f3 "+dueReturns.length+" return"+(dueReturns.length>1?"s":"")+" due soon"}</span>
        <button onClick=${()=>{setPage("history");setPendingOnly(true);}}>Show</button>
      </div>`:null}

    <div class="tabs">
      <button class=${page==="list"?"on":""} onClick=${()=>setPage("list")}>List</button>
      <button class=${page==="shop"?"on":""} onClick=${()=>setPage("shop")}>Shop</button>
      <button class=${page==="history"?"on":""} onClick=${()=>setPage("history")}>History</button>
    </div>

    ${loading?html`<${Loader} label="Loading your list\u2026"/>`:html`
    ${page==="list"?html`
      <div class="pagehead">
        <button class="primary sm" style="flex:1" onClick=${()=>setShowAdd(true)}>+ Add items</button>
      </div>
      ${list.length===0
        ? html`<div class="empty"><div class="big">List is empty</div>Tap \u201cAdd items\u201d or pull from \u2605 Staples.</div>`
        : listGroups.map(g=>html`
          <${Panel} title=${g.cat} count=${g.items.length} open=${g.open} onToggle=${()=>toggleCat(g.key)}>
            ${g.items.map(it=>html`
              <div class="lrow">
                <button class=${"rowstar lead-star"+(isStaple(it.name)?" on":"")} onClick=${()=>toggleStaple(it.name,it.stores,it.category)}>${isBusy("star_"+slug(it.name))?html`<${Spin} g=${true}/>`:(isStaple(it.name)?"\u2605":"\u2606")}</button>
                <button class="lmain" onClick=${()=>openItem(it)}>
                  <span class="lname">${it.name}</span>
                  <span class="lstores">${it.stores.length
                    ? it.stores.map(s=>html`<i class="sq" style=${"background:"+scolor(s)} title=${sname(s)}></i>`)
                    : html`<em class="uns">unsorted</em>`}</span>
                </button>
                <button class="rowx" onClick=${()=>removeRow(it)}>${isBusy("rm_"+it.id)?html`<${Spin} g=${true}/>`:"\u00d7"}</button>
              </div>`)}
          <//>`)}`:null}

    ${page==="shop"?( !checkedIn ? html`
      <div class="pickhead">Which store are you at?</div>
      <div class="picker">
        ${stores.map(s=>{const n=list.filter(i=>i.stores.includes(s.id)&&!i.checked).length;
          return html`<button class="storecard" style=${"--sc:"+s.color} onClick=${()=>setCheckedIn(s.id)}>
            <span class="scname">${s.name}</span>
            <span class="sccount">${n} item${n===1?"":"s"}</span>
          </button>`;})}
        <button class="storecard addtile" onClick=${openStores}><span class="addplus">+</span><span class="sccount">Add store</span></button>
      </div>`
    : html`
      <div class="checkin" style=${"--sc:"+scolor(checkedIn)}>
        <span class="cistore"><span class="scdot" style=${"background:"+scolor(checkedIn)}></span>At ${sname(checkedIn)}</span>
        <button class="ghost ciout" onClick=${checkOut}>Check out</button>
      </div>
      ${shopGroups.length===0
        ? html`<div class="empty"><div class="big">Nothing left for ${sname(checkedIn)}</div>You're all done here \u2014 check out.</div>`
        : shopGroups.map(g=>{
            const allDone=g.items.every(i=>i.checked); const open=allDone?false:g.open;
            return html`
            <${Panel} title=${g.cat} count=${g.items.filter(i=>!i.checked).length+"/"+g.items.length} color=${scolor(checkedIn)} open=${open} onToggle=${()=>toggleCat(g.key)}>
              ${g.items.map(it=>html`
                <div class=${"item"+(it.checked?" done":"")} style=${"--sc:"+scolor(checkedIn)} onClick=${()=>toggle(it)}>
                  <div class="box">${check}</div>
                  <div class="label">${it.name}
                    ${it.stores.length>1?html`<div class="also">${it.stores.filter(x=>x!==checkedIn).map(x=>html`<i style=${"background:"+scolor(x)}></i>`)}</div>`:null}
                  </div>
                </div>`)}
            <//>`;})}` ):null}

    ${page==="history"?html`
      <div class="pagetitle">Purchase History</div>
      <div class="filters">
        <button class=${"fbtn"+(pendingOnly?" on":"")} onClick=${()=>setPendingOnly(p=>!p)}>Pending returns</button>
        <select class="sel sm" value=${sortBy} onChange=${e=>setSortBy(e.target.value)}>
          <option value="date">Sort: Date</option><option value="store">Sort: Store</option>
        </select>
        <select class="sel sm" value=${pFilterStore} onChange=${e=>setPFilterStore(e.target.value)}>
          <option value="all">All stores</option>
          ${stores.map(s=>html`<option value=${s.id}>${s.name}</option>`)}
        </select>
        <select class="sel sm" value=${pFilterRange} onChange=${e=>setPFilterRange(e.target.value)}>
          <option value="7">7 days</option><option value="30">30 days</option>
          <option value="90">90 days</option><option value="all">All time</option>
        </select>
      </div>
      ${filteredPurch.length===0
        ? html`<div class="empty"><div class="big">No purchases</div>Items you mark bought show up here.</div>`
        : filteredPurch.map(p=>{
            const ret=p.status==="returning"; const d=ret?daysUntil(p.returnByDate):null;
            const rk="ret_"+p.id, kk="keep_"+p.id;
            return html`
            <div class=${"prow"+(ret?(d<0?" over":d<=5?" due":""):"")}>
              <button class=${"rowstar lead-star"+(isStaple(p.name)?" on":"")} onClick=${()=>toggleStaple(p.name,(dict[p.name]&&dict[p.name].stores)||[p.store],(dict[p.name]&&dict[p.name].category)||"Unsorted")}>${isStaple(p.name)?"\u2605":"\u2606"}</button>
              <div class="pinfo">
                <span class="pname">${p.name}</span>
                <span class="pmeta"><i class="sq" style=${"background:"+scolor(p.store)}></i>${sname(p.store)} \u00b7 ${p.date}
                  ${ret?html`\u00b7 <b>${d<0?"overdue":"return in "+d+"d"}</b>`:null}</span>
              </div>
              <div class="pact">
                ${(!ret && p.status!=="returned" && p.status!=="kept")?html`<button class="ghost" onClick=${()=>{setRetModal(p);setRetDate("");setRetFile(null);}}>Return</button>`:null}
                ${ret?html`
                  ${p.attachUrl?html`<button class="ghost" onClick=${()=>openAttachment(p)}>View</button>`
                    :html`<label class="ghost attachrow">${isBusy("attach_"+p.id)?html`<${Spin} g=${true}/>`:"Attach"}<input type="file" accept="image/*,application/pdf" onChange=${e=>{const f=e.target.files[0]; if(f) uploadAttach(p.id,f);}} /></label>`}
                  <button class="ghost" disabled=${isBusy(rk)} onClick=${()=>resolveReturn(p.id,"returned",rk)}>${isBusy(rk)?html`<${Spin} g=${true}/>`:"Returned"}</button>
                  <button class="ghost mut" disabled=${isBusy(kk)} onClick=${()=>resolveReturn(p.id,"kept",kk)}>${isBusy(kk)?html`<${Spin} g=${true}/>`:"Keeping"}</button>`:null}
                ${(p.status==="returned"||p.status==="kept")?html`<span class="tag">${p.status}</span>`:null}
              </div>
            </div>`;})}`:null}
    `}

    <!-- add items -->
    ${showAdd?html`
      <div class="scrim" onClick=${()=>setShowAdd(false)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">Paste your voice list</div><button class="sheetx" onClick=${()=>setShowAdd(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Alexa, WhatsApp, Notes \u2014 one line or comma-separated. Basketly splits it and files each item to the right store.</div>
        <textarea placeholder=${"2 lbs onions\ncilantro\npaneer\nmilk\ntoor dal"} value=${draft} onInput=${e=>setDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${parsing||!draft.trim()} onClick=${addItems}>${parsing?html`<${Spin}/>Routing\u2026`:"Add to list"}</button>
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

    <!-- item editor -->
    ${itemModal?html`
      <div class="scrim" onClick=${()=>setItemModal(null)}></div>
      <div class="sheet">
        <div class="lead">${itemModal.name}</div>
        <div class="hint">Category</div>
        <select class="sel" value=${editCat} onChange=${e=>setEditCat(e.target.value)}>
          ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
        </select>
        <div class="hint">Stores</div>
        <div class="chiprow">${stores.map(s=>html`<button class=${"chip mini"+(editStores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleEditStore(s.id)}>
          <span class="sq" style=${"background:"+s.color}></span>${s.name}</button>`)}</div>
        <button class="primary" disabled=${isBusy("saveitem")} onClick=${saveItem}>${isBusy("saveitem")?html`<${Spin}/>Saving\u2026`:"Save (remembers for next time)"}</button>
        <button class="danger" disabled=${isBusy("removeitem")} onClick=${removeCurrentItem}>${isBusy("removeitem")?html`<${Spin} g=${true}/>`:"Remove from list"}</button>
      </div>`:null}

    <!-- manage stores -->
    ${storeModal?html`
      <div class="scrim" onClick=${()=>setStoreModal(false)}></div>
      <div class="sheet tall">
        <div class="sheethead"><div class="lead">Stores</div><button class="sheetx" onClick=${()=>setStoreModal(false)} aria-label="Close">\u00d7</button></div>
        ${storeDraft.map(s=>html`
          <div class="serow">
            <input class="tin flex" value=${s.name} onInput=${e=>editDraft(s.id,{name:e.target.value})} />
            <input class="colorin" type="color" value=${s.color} onInput=${e=>editDraft(s.id,{color:e.target.value})} />
            <button class="rowx" disabled=${isBusy("delstore_"+s.id)} onClick=${()=>deleteStore(s)}>${isBusy("delstore_"+s.id)?html`<${Spin} g=${true}/>`:"\ud83d\uddd1"}</button>
          </div>`)}
        <button class="primary sm" disabled=${isBusy("savestores")} onClick=${saveStores}>${isBusy("savestores")?html`<${Spin}/>Saving\u2026`:"Save names & colors"}</button>
        <div class="lead" style="margin-top:10px">Add a store</div>
        <input class="tin" placeholder="Store name" value=${newStore.name} onInput=${e=>setNewStore(n=>({...n,name:e.target.value}))} />
        <div class="pickrow">
          <div class="swatches">${STORE_SWATCHES.map(c=>html`<button class=${"sw"+(newStore.color===c?" on":"")} style=${"background:"+c} onClick=${()=>setNewStore(n=>({...n,color:c}))}></button>`)}</div>
          <input class="colorin" type="color" value=${newStore.color} onInput=${e=>setNewStore(n=>({...n,color:e.target.value}))} />
        </div>
        <button class="primary" disabled=${!newStore.name.trim()||isBusy("addstore")} onClick=${addStore}>${isBusy("addstore")?html`<${Spin}/>Adding\u2026`:"Add store"}</button>
      </div>`:null}

    <!-- delete store: reassign orphans -->
    ${delStore?html`
      <div class="scrim" onClick=${()=>setDelStore(null)}></div>
      <div class="sheet tall">
        <div class="lead">Deleting ${delStore.name}</div>
        <div class="hint">These items are only at ${delStore.name}. Pick a new store for each, or leave blank to move it to Unsorted.</div>
        ${orphansOf(delStore.id).map(it=>html`
          <div class="orow">
            <span class="rname">${it.name}</span>
            <div class="chiprow">
              ${stores.filter(s=>s.id!==delStore.id).map(s=>html`
                <button class=${"chip mini"+((reassign[it.id]===s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>setReassign(r=>({...r,[it.id]:r[it.id]===s.id?undefined:s.id}))}>
                  <span class="sq" style=${"background:"+s.color}></span>${s.name}</button>`)}
            </div>
          </div>`)}
        <button class="danger" disabled=${isBusy("delstore_"+delStore.id)} onClick=${()=>commitDelete(delStore,reassign)}>${isBusy("delstore_"+delStore.id)?html`<${Spin} g=${true}/>`:"Delete store & apply"}</button>
        <button class="ghost" onClick=${()=>setDelStore(null)}>Cancel</button>
      </div>`:null}

    <!-- dropdown menu (anchored under the hamburger) -->
    ${menu?html`
      <div class="menuscrim" onClick=${()=>setMenu(false)}></div>
      <div class="dropdown">
        <div class="ddemail">${user.email}</div>
        <button class="ddm" onClick=${()=>{setMenu(false);setStapleSel({});setStaplesModal(true);}}>Staples</button>
        <button class="ddm" onClick=${()=>{setMenu(false);openStores();}}>Manage stores</button>
        <button class="ddm" onClick=${()=>{setMenu(false);openCats();}}>Manage categories</button>
        <div class="ddsep"></div>
        <button class="ddm ddout" onClick=${()=>signOut(auth)}>Sign out</button>
      </div>`:null}

    <!-- categories -->
    ${catModal?html`
      <div class="scrim" onClick=${()=>setCatModal(false)}></div>
      <div class="sheet tall">
        <div class="lead">Categories</div>
        <div class="hint">This order is how items group on the List and Shop pages. \u201cUnsorted\u201d always stays last.</div>
        ${catDraft.map(c=>html`
          <div class="serow"><span class="flex">${c}</span>
            <button class="rowx" disabled=${isBusy("delcat_"+c)} onClick=${()=>deleteCat(c)}>${isBusy("delcat_"+c)?html`<${Spin} g=${true}/>`:"\ud83d\uddd1"}</button>
          </div>`)}
        <div class="lead" style="margin-top:10px">Add a category</div>
        <input class="tin" placeholder="e.g. Clothes" value=${newCat} onInput=${e=>setNewCat(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter")addCat();}} />
        <button class="primary" disabled=${!newCat.trim()||isBusy("addcat")} onClick=${addCat}>${isBusy("addcat")?html`<${Spin}/>Adding\u2026`:"Add category"}</button>
      </div>`:null}

    <!-- staples palette -->
    ${staplesModal?html`
      <div class="scrim" onClick=${()=>setStaplesModal(false)}></div>
      <div class="sheet tall">
        <div class="lead">Staples</div>
        <div class="hint">Your regulars. Tick what you need this week and add them all at once. Items already on the list are greyed out.</div>
        <input class="tin" placeholder="Add a staple (e.g. milk)" value=${newStaple} onInput=${e=>setNewStaple(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter")addNewStaple();}} />
        ${staples.length===0?html`<div class="hint">No staples yet \u2014 star items on the List or in Purchase History to keep them here.</div>`:null}
        ${staples.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(s=>{
          const onList=list.some(i=>i.key===s.name);
          return html`<div class=${"strow"+(onList?" off":"")} onClick=${()=>{ if(!onList) setStapleSel(v=>({...v,[s.id]:!v[s.id]})); }}>
            <div class=${"box sm"+((stapleSel[s.id]&&!onList)?" on":"")}>${(stapleSel[s.id]&&!onList)?check:null}</div>
            <span class="sname2">${s.name}</span>
            <span class="lstores">${(s.stores||[]).map(x=>html`<i class="sq" style=${"background:"+scolor(x)}></i>`)}</span>
            ${onList?html`<span class="tag">on list</span>`:null}
            <button class="rowx" onClick=${e=>{e.stopPropagation();toggleStaple(s.name,s.stores,s.category);}}>${isBusy("star_"+s.id)?html`<${Spin} g=${true}/>`:"\u00d7"}</button>
          </div>`;})}
        <button class="primary" disabled=${isBusy("addstaples")||!Object.values(stapleSel).some(Boolean)} onClick=${addStaplesToList}>${isBusy("addstaples")?html`<${Spin}/>Adding\u2026`:"Add selected to list"}</button>
      </div>`:null}

    <!-- assign store for items the parser couldn't route -->
    ${assignList.length>0?html`
      <div class="scrim" onClick=${commitAssign}></div>
      <div class="sheet tall">
        <div class="lead">Which store${assignList.length>1?"s":""}?</div>
        <div class="hint">Couldn't auto-detect where to buy ${assignList.length>1?"these":"this"}. Pick a store (and category) \u2014 I'll remember for next time.</div>
        ${assignList.map((it,idx)=>html`
          <div class="arow">
            <div class="aname">${it.name}</div>
            <select class="sel sm" value=${it.category} onChange=${e=>updateAssign(idx,{category:e.target.value})}>
              ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
            </select>
            <div class="chiprow">
              ${stores.map(s=>html`<button class=${"chip mini"+(it.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleAssignStore(idx,s.id)}>
                <span class="sq" style=${"background:"+s.color}></span>${s.name}</button>`)}
            </div>
          </div>`)}
        <button class="primary" disabled=${isBusy("assign")} onClick=${commitAssign}>${isBusy("assign")?html`<${Spin}/>Adding\u2026`:"Add to list"}</button>
      </div>`:null}

    <!-- return date -->
    ${retModal?html`
      <div class="scrim" onClick=${()=>setRetModal(null)}></div>
      <div class="sheet">
        <div class="lead">Return \u201c${retModal.name}\u201d</div>
        <div class="hint">Bought at ${sname(retModal.store)} on ${retModal.date}. Enter the return-by date \u2014 a red banner appears within 5 days of it.</div>
        <input class="tin" type="date" value=${retDate} min=${todayISO()} onInput=${e=>setRetDate(e.target.value)} />
        <label class="attachbtn">${retFile?("\u2713 "+retFile.name):"\ud83d\udcce Attach receipt / QR / label \u2014 image or PDF (optional)"}
          <input type="file" accept="image/*,application/pdf" onChange=${e=>setRetFile(e.target.files[0]||null)} />
        </label>
        <button class="primary" disabled=${!retDate||isBusy("confirmret")} onClick=${confirmReturn}>${isBusy("confirmret")?html`<${Spin}/>Saving\u2026`:"Mark for return"}</button>
      </div>`:null}

    <!-- image viewer -->
    ${viewImg?html`
      <div class="scrim dark" onClick=${()=>setViewImg(null)}></div>
      <div class="imgview" onClick=${()=>setViewImg(null)}><img src=${viewImg} alt="attachment" /></div>`:null}

    ${(page==="shop" && checkedIn)?html`
      <div class="submitbar"><div class="inner"><button class="primary" style="width:100%" disabled=${isBusy("checkout")} onClick=${checkOut}>${isBusy("checkout")?html`<${Spin}/>Saving\u2026`:(shopChecked>0?"Check out \u00b7 "+shopChecked+" bought":"Check out")}</button></div></div>`:null}
    ${toast?html`<div class="toast">${toast}</div>`:null}
  `;
}
render(html`<${App}/>`, document.getElementById("app"));
if("serviceWorker" in navigator) addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
