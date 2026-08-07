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
function textOn(hex){ if(!hex||hex[0]!=="#") return "#161d18"; let h=hex.slice(1); if(h.length===3)h=h.split("").map(c=>c+c).join(""); const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16); const L=(0.299*r+0.587*g+0.114*b)/255; return L>0.62?"#161d18":"#fff"; }
const sqChar=n=>(((n||"?").trim()[0])||"?").toUpperCase();
const lsq=(color,name,cls)=>html`<i class=${"lsq"+(cls?" "+cls:"")} style=${"background:"+(color||"#ccc")+";color:"+textOn(color)}>${sqChar(name)}</i>`;
const WHO=[["baby","Baby"],["kids","Kids"],["adults","Adults"],["family","Whole family"]];
const AGES=[["u6","Under 6 mo"],["6_9","6-9 mo"],["9_12","9-12 mo"],["12_18","12-18 mo"],["18_36","18-36 mo"]];
const FLAVORS=["Sweet","Savory","Spicy","Mild"];
const MEALS=[["snack","Snack"],["meal","Meal"],["soft","Soft (sore gums)"]];
let _migRan=false;
let _lp=null, _suppressClick=false;
const CUISINES=["Indian","Chinese","Thai","Italian","Mexican","American"];

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
const titleCase = s => (s||"").split(" ").map(w=>w?w.charAt(0).toUpperCase()+w.slice(1):w).join(" ");
const todayISO = () => new Date().toISOString().slice(0,10);
const daysUntil = iso => Math.ceil((new Date(iso+"T00:00:00") - new Date(new Date().toDateString())) / 86400000);
const cfgDoc = () => doc(db,"shoppinglist_config","app");

function normalizeName(raw){
  let s = raw.toLowerCase().trim();
  s = s.replace(/^[-*\d\).\s]+/,"");
  s = s.replace(/\b(\d+(\.\d+)?)\s*(lbs?|lb|kg|g|oz|gallons?|gal|dozen|packs?|pkt|bunch(es)?|cans?|bottles?|boxes?|bags?)\b/gi,"");
  s = s.replace(/\b(a|an|some|few|couple of|one|two|three|four|five)\b/gi,"");
  return titleCase(s.replace(/\s+/g," ").trim());
}
const splitBlob = t => t.split(/\r?\n|,|;|\u2022|\band\b/i).map(x=>x.trim()).filter(Boolean).map(normalizeName).filter(Boolean);
function lookup(dict, name){
  const nl=(name||"").toLowerCase();
  for(const k of Object.keys(dict)){ if(nl===k.toLowerCase()) return dict[k]; }
  for(const k of Object.keys(dict)){ const kl=k.toLowerCase();
    if(nl.length>3 && (nl.includes(kl)||kl.includes(nl))) return dict[k];
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
function Panel({title, count, color, open, onToggle, children, dropCat, onGrip, hot}){
  return html`
    <div class=${"panel"+(hot?" drophot":"")} data-drop-cat=${dropCat||null}>
      <div class="phead">
        ${onGrip?html`<button class="grip catgrip" onPointerDown=${onGrip} onClick=${e=>e.stopPropagation()} aria-label="Reorder category">\u2261</button>`:null}
        <button class="pheadmain" onClick=${onToggle}>
          <span class="ptitle">${color?html`<i class="pdot" style=${"background:"+color}></i>`:null}${title}</span>
          <span class="pright"><span class="pcount">${count}</span><span class=${"caret"+(open?" up":"")}>\u25be</span></span>
        </button>
      </div>
      ${open?html`<div class="pbody">${children}</div>`:null}
    </div>`;
}
function Loader({label}){
  return html`<div class="loader"><span class="spin g big"></span><span>${label||"Loading\u2026"}</span></div>`;
}

function App(){
  const [user,setUser]=useState(undefined);
  const [loading,setLoading]=useState(true);
  const [migDone,setMigDone]=useState(null);
  const [stores,setStores]=useState(DEFAULT_STORES);
  const [dict,setDict]=useState({});
  const [list,setList]=useState([]);
  const [purch,setPurch]=useState([]);
  const [page,setPage]=useState("list");
  const [checkedIn,setCheckedIn]=useState(null);
  const [shopAdd,setShopAdd]=useState("");
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
  const [editTags,setEditTags]=useState([]);
  const [tagDraft,setTagDraft]=useState("");
  const [exclTags,setExclTags]=useState(()=>new Set());
  const [exclStores,setExclStores]=useState(()=>new Set());
  const toggleExcl=(setter,val)=>setter(prev=>{const n=new Set(prev); n.has(val)?n.delete(val):n.add(val); return n;});
  const toggleFlavor=f=>setRFlavors(prev=>{const n=new Set(prev); n.has(f)?n.delete(f):n.add(f); return n;});
  async function getRecipes(){
    const items=rIng.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
    if(!items.length) return;
    if(rWho==="baby"&&!rAge) return;
    setRLoading(true); setRErr(""); setRResults(null);
    try{
      const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),30000);
      const res=await fetch(WORKER_URL+"/recipes",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ingredients:items.join(", "),staples:kitchen,mealType:rMeal,cuisine:rCuisine||null,forWhom:rWho,ageBand:rWho==="baby"?rAge:null,flavors:[...rFlavors],allowOneExtra:true}),signal:ctrl.signal});
      clearTimeout(t);
      if(!res.ok) throw new Error("worker "+res.status);
      const data=await res.json();
      const arr=Array.isArray(data)?data:(data.dishes||[]);
      setRResults(arr); setROpen(arr.length?{0:true}:{});
    }catch(e){ setRErr("Couldn't get ideas \u2014 check your connection and try again."); }
    setRLoading(false);
  }
  const addIngChip=name=>{const t=(name||"").trim(); if(!t) return; setRIng(cur=>{const have=cur.split(/[\n,]+/).map(x=>x.trim().toLowerCase()); if(have.includes(t.toLowerCase())) return cur; return cur.trim()?cur.replace(/\s*$/,"")+", "+t:t;});};
  function openRecipes(){ setRecipeOpen(true); }
  async function addKitchen(){
    const parts=kDraft.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
    if(!parts.length){return;}
    const have=new Set(kitchen.map(x=>x.toLowerCase()));
    const adds=[]; for(const p of parts){ if(!have.has(p.toLowerCase())){ have.add(p.toLowerCase()); adds.push(p); } }
    if(!adds.length){ setKDraft(""); return; }
    const next=[...kitchen,...adds];
    await run("kitchen",()=>setDoc(cfgDoc(),{kitchen:next},{merge:true}));
    setKDraft("");
  }
  async function removeKitchen(t){ const next=kitchen.filter(x=>x!==t); await run("kitchen",()=>setDoc(cfgDoc(),{kitchen:next},{merge:true})); }
  const [openFilter,setOpenFilter]=useState(null);   // 'store' | 'tag' | null
  const [storeSearch,setStoreSearch]=useState("");
  const [tagSearch,setTagSearch]=useState("");
  const [retModal,setRetModal]=useState(null);
  const [retDate,setRetDate]=useState("");
  const [retFile,setRetFile]=useState(null);
  const [viewImg,setViewImg]=useState(null);
  const [pendingOnly,setPendingOnly]=useState(false);
  const [pFilterStore,setPFilterStore]=useState("all");
  const [pFilterCat,setPFilterCat]=useState("all");
  const [pFilterRange,setPFilterRange]=useState("30");
  const [sortBy,setSortBy]=useState("date");
  const [sortDir,setSortDir]=useState("desc");
  const [histPage,setHistPage]=useState(1);
  const [cats,setCats]=useState(CATS);
  const [kitchen,setKitchen]=useState([]);
  const [catModal,setCatModal]=useState(false);
  const [catDraft,setCatDraft]=useState([]);
  const [newCat,setNewCat]=useState("");
  const [staples,setStaples]=useState([]);
  const [staplesModal,setStaplesModal]=useState(false);
  const [stapleSel,setStapleSel]=useState({});
  const [newStaple,setNewStaple]=useState("");
  const [menu,setMenu]=useState(false);
  const [recipeOpen,setRecipeOpen]=useState(false);
  const [rWho,setRWho]=useState("family");
  const [rAge,setRAge]=useState("");
  const [rFlavors,setRFlavors]=useState(()=>new Set());
  const [rMeal,setRMeal]=useState("meal");
  const [rCuisine,setRCuisine]=useState("");
  const [rIng,setRIng]=useState("");
  const [rLoading,setRLoading]=useState(false);
  const [rResults,setRResults]=useState(null);
  const [rErr,setRErr]=useState("");
  const [rOpen,setROpen]=useState({});
  const [kitchenModal,setKitchenModal]=useState(false);
  const [kDraft,setKDraft]=useState("");

  const flash=m=>{setToast(m);setTimeout(()=>setToast(""),1800);};
  const scolor=id=>(stores.find(s=>s.id===id)||{}).color||"#ccc";
  const sname=id=>(stores.find(s=>s.id===id)||{}).name||id;
  const toggleCat=key=>setCollapsed(c=>({...c,[key]:!c[key]}));
  const [drag,setDrag]=useState(null);
  const [ghost,setGhost]=useState(null);
  const [overCat,setOverCat]=useState(null);
  const [reorder,setReorder]=useState(false);
  const [catPick,setCatPick]=useState(null);
  function pointCat(x,y){ const el=document.elementFromPoint(x,y); const h=el&&el.closest?el.closest("[data-drop-cat]"):null; return h?h.getAttribute("data-drop-cat"):null; }
  function runDrag(kind, data, x0, y0){
    setDrag({kind}); setGhost({x:x0,y:y0,label:data.label}); setOverCat(pointCat(x0,y0));
    const move=ev=>{
      setGhost(g=>g?{...g,x:ev.clientX,y:ev.clientY}:g);
      setOverCat(pointCat(ev.clientX,ev.clientY));
      const m=72,H=window.innerHeight; if(ev.clientY<m) window.scrollBy(0,-14); else if(ev.clientY>H-m) window.scrollBy(0,14);
    };
    const up=ev=>{
      window.removeEventListener("pointermove",move); window.removeEventListener("pointerup",up);
      setGhost(null); setDrag(null); setOverCat(null);
      const target=pointCat(ev.clientX,ev.clientY);
      if(target){ if(kind==="item"){ if(target!==data.cat) recategorize(data.item,target); } else if(kind==="cat"){ if(target!==data.cat) reorderCat(data.cat,target); } }
    };
    window.addEventListener("pointermove",move,{passive:false});
    window.addEventListener("pointerup",up);
  }
  function startDrag(kind, data, e){
    if(e.button!==undefined && e.button!==0) return;
    e.preventDefault(); e.stopPropagation();
    runDrag(kind,data,e.clientX,e.clientY);
  }
  function itemPointerDown(it, e){
    if(reorder) return;
    if(e.button!==undefined && e.button!==0) return;
    const x0=e.clientX,y0=e.clientY;
    _lp={x0,y0,fired:false,timer:setTimeout(()=>{
      _lp.fired=true; _suppressClick=true; setReorder(true);
      runDrag("item",{item:it,cat:it.category||"Unsorted",label:it.name},x0,y0);
    },420)};
  }
  function itemPointerMove(e){ if(!_lp||_lp.fired) return; if(Math.abs(e.clientX-_lp.x0)>10||Math.abs(e.clientY-_lp.y0)>10){ clearTimeout(_lp.timer); _lp=null; } }
  function itemPointerUp(){ if(_lp&&!_lp.fired){ clearTimeout(_lp.timer); _lp=null; } }
  function openItemGuarded(it){ if(_suppressClick){ _suppressClick=false; return; } openItem(it); }
  async function recategorize(it, cat){
    await run("recat_"+it.id, async ()=>{
      const b=writeBatch(db);
      b.set(doc(db,"shoppinglist_list",it.id),{category:cat},{merge:true});
      b.set(doc(db,"shoppinglist_dictionary",slug(it.name)),{name:it.name,category:cat},{merge:true});
      await b.commit();
    });
    flash(it.name+" \u2192 "+cat);
  }
  async function reorderCat(from, to){
    if(from==="Unsorted"||to==="Unsorted") return;
    const base=cats.filter(c=>c!=="Unsorted"&&c!==from);
    const idx=base.indexOf(to); if(idx<0) return;
    base.splice(idx,0,from);
    await run("reordercat", ()=>setDoc(cfgDoc(),{categories:base},{merge:true}));
  }
  const setAllCats=(keys,collapse)=>setCollapsed(c=>{const n={...c}; keys.forEach(k=>{ if(collapse) n[k]=true; else delete n[k]; }); return n;});
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
      if(dd.categories&&dd.categories.length) setCats(dd.categories.includes("Unsorted")?dd.categories:[...dd.categories,"Unsorted"]);
      if(dd.kitchen) setKitchen(dd.kitchen);
      setMigDone(!!dd.nameCaseV1);}});
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
    const existing=new Set(list.map(i=>(i.key||"").toLowerCase()));
    const toAdd=[], needAssign=[];
    for(const n of names){
      if(existing.has(n.toLowerCase())) continue; existing.add(n.toLowerCase());
      const known=lookup(dict,n);
      if(known && (known.stores||[]).length){
        toAdd.push({name:n,stores:known.stores,category:known.category||"Unsorted"});
      } else {
        const cat=(learned[n]&&learned[n].category)||(known&&known.category)||"Unsorted";
        needAssign.push({name:n,stores:[],category:cat});
      }
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
  function openItem(it){ setItemModal(it); setEditCat(it.category||"Unsorted"); setEditStores([...(it.stores||[])]); setEditTags([...(it.tags||[])]); setTagDraft(""); }
  const toggleEditStore=sid=>setEditStores(es=>es.includes(sid)?es.filter(x=>x!==sid):[...es,sid]);
  function addTag(){ const t=tagDraft.trim(); if(!t) return; if(!editTags.some(x=>x.toLowerCase()===t.toLowerCase())) setEditTags(ts=>[...ts,t]); setTagDraft(""); }
  const removeTag=t=>setEditTags(ts=>ts.filter(x=>x!==t));
  async function saveItem(){
    await run("saveitem", async ()=>{
      const b=writeBatch(db);
      b.set(doc(db,"shoppinglist_list",itemModal.id),{category:editCat,stores:editStores,tags:editTags},{merge:true});
      b.set(doc(db,"shoppinglist_dictionary",slug(itemModal.key)),{name:itemModal.key,category:editCat,stores:editStores},{merge:true});
      await b.commit();
    });
    setItemModal(null);
  }
  async function removeCurrentItem(){ await run("removeitem", ()=>deleteDoc(doc(db,"shoppinglist_list",itemModal.id))); setItemModal(null); }
  const removeRow=it=>run("rm_"+it.id, ()=>deleteDoc(doc(db,"shoppinglist_list",it.id)));

  async function addInShop(){
    const t=normalizeName(shopAdd); if(!t||!checkedIn) return;
    if(list.some(i=>i.key.toLowerCase()===t.toLowerCase()&&(i.stores||[]).includes(checkedIn))){ setShopAdd(""); flash(t+" is already on this list"); return; }
    const known=lookup(dict,t);
    let category=(known&&known.category)||"Unsorted";
    let stores=known?((known.stores||[]).includes(checkedIn)?known.stores:[...(known.stores||[]),checkedIn]):[checkedIn];
    if(!known){ try{ const learned=await routeUnknowns([t],stores); const m=Object.values(learned)[0]; if(m&&m.category) category=m.category; }catch{} }
    await run("shopadd", async ()=>{
      const b=writeBatch(db);
      b.set(doc(db,"shoppinglist_dictionary",slug(t)),{name:t,stores,category},{merge:true});
      b.set(doc(collection(db,"shoppinglist_list")),{key:t,name:t,stores:[...stores],category,checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
      await b.commit();
    });
    setShopAdd(""); flash(t+" added to "+sname(checkedIn));
  }
  async function cleanupNames(silent){
    const work=async ()=>{
      const ops=[];
      const groups={};
      for(const it of list){ const tc=titleCase(it.name||it.key||""); const k=tc.toLowerCase(); (groups[k]||(groups[k]={tc,items:[]})).items.push(it); }
      for(const g of Object.values(groups)){
        const items=g.items;
        const stores=[...new Set(items.flatMap(i=>i.stores||[]))];
        const tags=[...new Set(items.flatMap(i=>i.tags||[]))];
        const keep=items[0];
        ops.push({t:"set",ref:doc(db,"shoppinglist_list",keep.id),data:{key:g.tc,name:g.tc,stores,tags}});
        for(const dup of items.slice(1)) ops.push({t:"del",ref:doc(db,"shoppinglist_list",dup.id)});
      }
      for(const nm of Object.keys(dict)) ops.push({t:"set",ref:doc(db,"shoppinglist_dictionary",slug(nm)),data:{name:titleCase(nm)}});
      for(const p of purch){ const tc=titleCase(p.name||""); if(tc!==p.name) ops.push({t:"set",ref:doc(db,"shoppinglist_purchased",p.id),data:{name:tc}}); }
      for(let i=0;i<ops.length;i+=400){
        const b=writeBatch(db);
        for(const o of ops.slice(i,i+400)){ o.t==="del"?b.delete(o.ref):b.set(o.ref,o.data,{merge:true}); }
        await b.commit();
      }
      await setDoc(cfgDoc(),{nameCaseV1:true},{merge:true});
    };
    if(silent){ try{ await work(); }catch(e){} return; }
    await run("cleanup", work); flash("Names cleaned up");
  }
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
  const allTags=useMemo(()=>{const s=new Set(); list.forEach(i=>(i.tags||[]).forEach(t=>s.add(t))); return [...s].sort((a,b)=>a.localeCompare(b));},[list]);
  const recentProduce=useMemo(()=>{
    const cut=Date.now()-30*864e5, seen=new Set(), out=[];
    purch.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")).forEach(p=>{
      if(((lookup(dict,p.name)||{}).category)!=="Produce") return;
      const d=Date.parse(p.date); if(isNaN(d)||d<cut) return;
      const k=(p.name||"").toLowerCase(); if(!k||seen.has(k)) return; seen.add(k); out.push(p.name);
    });
    return out;
  },[purch,dict]);
  const listGroups=useMemo(()=>{
    const l=list.filter(i=>{
      const sp=(i.stores||[]).length===0 || (i.stores||[]).some(s=>!exclStores.has(s));
      const tp=(i.tags||[]).length===0 || (i.tags||[]).some(t=>!exclTags.has(t));
      return sp && tp;
    });
    return groupByCat(l,"list");
  },[list,collapsed,cats,exclTags,exclStores]);
  const shopItems=useMemo(()=>list.filter(i=>i.stores.includes(checkedIn)),[list,checkedIn]);
  const shopGroups=useMemo(()=>groupByCat(shopItems,"shop:"+checkedIn),[shopItems,collapsed,checkedIn,cats]);
  const shopChecked=shopItems.filter(i=>i.checked).length;

  const pCatOf=name=>((lookup(dict,name)||{}).category)||"Unsorted";
  const filteredPurch=useMemo(()=>{
    let ps=purch.slice();
    if(pendingOnly) ps=ps.filter(p=>p.status==="returning");
    if(pFilterStore!=="all") ps=ps.filter(p=>p.store===pFilterStore);
    if(pFilterCat!=="all") ps=ps.filter(p=>pCatOf(p.name)===pFilterCat);
    if(pFilterRange!=="all"){const lim=parseInt(pFilterRange,10);
      ps=ps.filter(p=>{const d=(new Date()-new Date(p.date+"T00:00:00"))/86400000; return d<=lim;});}
    return ps.sort((a,b)=>{
      if(sortBy==="store"){const c=sname(a.store).localeCompare(sname(b.store)); if(c) return c;}
      const c=(a.date||"").localeCompare(b.date||"");
      return sortDir==="asc"?c:-c;
    });
  },[purch,pendingOnly,pFilterStore,pFilterCat,pFilterRange,sortBy,sortDir,stores,dict]);
  const HIST_PER=20;
  const histPages=Math.max(1,Math.ceil(filteredPurch.length/HIST_PER));
  const histSlice=useMemo(()=>filteredPurch.slice((histPage-1)*HIST_PER,histPage*HIST_PER),[filteredPurch,histPage]);
  useEffect(()=>{ setHistPage(1); },[pendingOnly,pFilterStore,pFilterCat,pFilterRange,sortBy,sortDir]);
  useEffect(()=>{
    if(migDone!==false||loading||_migRan) return;
    _migRan=true; cleanupNames(true);
  },[migDone,loading,list,dict,purch]);
  useEffect(()=>{
    let sx=0,sy=0,st=0,skip=false;
    const SKIP=".chiprow,.tagbar,.picker,.msellist,.dropdown,.sheet,.scrim,.recipepage,.dragghost,input,textarea,select";
    const ts=e=>{ const t=e.touches&&e.touches[0]; if(!t) return; sx=t.clientX; sy=t.clientY; st=Date.now();
      skip=!!(e.target&&e.target.closest&&e.target.closest(SKIP)); };
    const te=e=>{ if(skip||drag) return; const t=e.changedTouches&&e.changedTouches[0]; if(!t) return;
      const dx=t.clientX-sx, dy=t.clientY-sy, dt=Date.now()-st;
      if(dt<600 && Math.abs(dx)>70 && Math.abs(dx)>Math.abs(dy)*2){
        const order=["list","shop","history"], i=order.indexOf(page);
        if(dx<0 && i<order.length-1) setPage(order[i+1]);
        else if(dx>0 && i>0) setPage(order[i-1]);
      }};
    document.addEventListener("touchstart",ts,{passive:true});
    document.addEventListener("touchend",te,{passive:true});
    return ()=>{ document.removeEventListener("touchstart",ts); document.removeEventListener("touchend",te); };
  },[page,drag]);

  const check=html`<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  if(user===undefined) return html`<div class="gate"><div class="brand">Basketly<span class="dot">.</span></div><${Loader} label="Starting\u2026"/></div>`;
  if(user===null) return html`<div class="gate">
    <img class="gatelogo" src="./icon-512.png" alt="Basketly" />
    <div class="brand">Basketly<span class="dot">.</span></div>
    <p>Your shared grocery list. Sign in with the household Google account.</p>
    <button class="primary" onClick=${signIn}>Sign in with Google</button></div>`;

  return html`
    <div class="top">
      ${ghost?html`<div class="dragghost" style=${"left:"+ghost.x+"px;top:"+ghost.y+"px"}>${ghost.label}</div>`:null}
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
      ${(stores.length>1||allTags.length>0)?html`
        <div class="filterrow">
          ${stores.length>1?html`
            <div class="msel">
              <button class=${"mselbtn"+(exclStores.size?" act":"")} onClick=${()=>setOpenFilter(openFilter==="store"?null:"store")}>
                ${exclStores.size===0?"All stores":(stores.length-exclStores.size)+" store"+((stores.length-exclStores.size)===1?"":"s")}
                <span class="caret">\u25be</span>
              </button>
              ${openFilter==="store"?html`
                <div class="mselscrim" onClick=${()=>{setOpenFilter(null);setStoreSearch("");}}></div>
                <div class="msellist">
                  <input class="mselsearch" placeholder="Search stores\u2026" value=${storeSearch} onInput=${e=>setStoreSearch(e.target.value)} />
                  <button class="mselopt" onClick=${()=>setExclStores(exclStores.size===0?new Set(stores.map(s=>s.id)):new Set())}><span class=${"ckbox"+(exclStores.size===0?" on":"")}></span>${exclStores.size===0?"Deselect all":"All stores"}</button>
                  ${stores.filter(s=>s.name.toLowerCase().includes(storeSearch.trim().toLowerCase())).map(s=>html`<button class="mselopt" onClick=${()=>toggleExcl(setExclStores,s.id)}><span class=${"ckbox"+(!exclStores.has(s.id)?" on":"")}></span>${lsq(s.color,s.name)}${s.name}</button>`)}
                </div>`:null}
            </div>`:null}
          ${allTags.length>0?html`
            <div class="msel">
              <button class=${"mselbtn"+(exclTags.size?" act":"")} onClick=${()=>setOpenFilter(openFilter==="tag"?null:"tag")}>
                ${exclTags.size===0?"All tags":(allTags.length-exclTags.size)+" tag"+((allTags.length-exclTags.size)===1?"":"s")}
                <span class="caret">\u25be</span>
              </button>
              ${openFilter==="tag"?html`
                <div class="mselscrim" onClick=${()=>{setOpenFilter(null);setTagSearch("");}}></div>
                <div class="msellist">
                  <input class="mselsearch" placeholder="Search tags\u2026" value=${tagSearch} onInput=${e=>setTagSearch(e.target.value)} />
                  <button class="mselopt" onClick=${()=>setExclTags(exclTags.size===0?new Set(allTags):new Set())}><span class=${"ckbox"+(exclTags.size===0?" on":"")}></span>${exclTags.size===0?"Deselect all":"All tags"}</button>
                  ${allTags.filter(t=>t.toLowerCase().includes(tagSearch.trim().toLowerCase())).map(t=>html`<button class="mselopt" onClick=${()=>toggleExcl(setExclTags,t)}><span class=${"ckbox"+(!exclTags.has(t)?" on":"")}></span>${t}</button>`)}
                </div>`:null}
            </div>`:null}
        </div>`:null}
      ${list.length>0?html`
        <div class="listtools">
          <button class=${"expandbtn"+(reorder?" on":"")} onClick=${()=>setReorder(r=>!r)}>${reorder?"Done":"Reorder"}</button>
          <span class="listcount">${(exclTags.size||exclStores.size)
            ? html`${listGroups.reduce((a,g)=>a+g.items.length,0)} <span class="lcmuted">of ${list.length} items</span>`
            : html`${list.length} item${list.length===1?"":"s"}`}</span>
          ${listGroups.length>1?html`<button class="expandbtn" onClick=${()=>setAllCats(listGroups.map(g=>g.key),listGroups.every(g=>g.open))}>${listGroups.every(g=>g.open)?"Collapse all":"Expand all"}</button>`:html`<span class="ltspacer"></span>`}
        </div>`:null}
      ${(exclTags.size||exclStores.size)&&listGroups.length===0
        ? html`<div class="empty"><div class="big">Nothing matches</div>No items for these filters \u2014 reset with \u201cAll\u201d.</div>`
        : list.length===0
        ? html`<div class="empty"><div class="big">List is empty</div>Tap \u201cAdd items\u201d or pull from \u2605 Regularly Bought.</div>`
        : listGroups.map(g=>html`
          <${Panel} title=${g.cat} count=${g.items.length} open=${g.open} onToggle=${()=>toggleCat(g.key)}
            dropCat=${g.cat} hot=${!!drag && overCat===g.cat}
            onGrip=${(reorder && g.cat!=="Unsorted")?(e=>startDrag("cat",{cat:g.cat,label:g.cat},e)):null}>
            ${g.items.map(it=>html`
              <div class="lrow" onPointerDown=${e=>itemPointerDown(it,e)} onPointerMove=${itemPointerMove} onPointerUp=${itemPointerUp}>
                ${reorder?html`<button class="grip itemgrip" onPointerDown=${e=>startDrag("item",{item:it,cat:it.category||"Unsorted",label:it.name},e)} onClick=${e=>e.stopPropagation()} aria-label="Drag to recategorize">\u2261</button>`:null}
                <button class=${"rowstar lead-star"+(isStaple(it.name)?" on":"")} onClick=${()=>toggleStaple(it.name,it.stores,it.category)}>${isBusy("star_"+slug(it.name))?html`<${Spin} g=${true}/>`:(isStaple(it.name)?"\u2605":"\u2606")}</button>
                <div class="lmain" onClick=${()=>openItemGuarded(it)}>
                  <span class="lmid">
                    <span class="lname">${it.name}</span>
                    <span class="lmeta">
                      <span class="catchip" onClick=${e=>{e.stopPropagation();setCatPick(it);}}>${it.category||"Unsorted"}</span>
                      ${(it.tags||[]).map(t=>html`<span class="ltag">${t}</span>`)}
                    </span>
                  </span>
                  <span class="lstores">${it.stores.length
                    ? it.stores.map(s=>lsq(scolor(s),sname(s)))
                    : html`<em class="uns">unsorted</em>`}</span>
                </div>
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
        <span class="cistore">${lsq(scolor(checkedIn),sname(checkedIn))}At ${sname(checkedIn)}</span>
        <button class="ghost ciout" onClick=${checkOut}>Check out</button>
      </div>
      <div class="shopaddrow">
        <input class="tin flex" placeholder=${"Add to "+sname(checkedIn)+"\u2026"} value=${shopAdd} onInput=${e=>setShopAdd(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter"){e.preventDefault();addInShop();}}} />
        <button class="primary sm" disabled=${isBusy("shopadd")||!shopAdd.trim()} onClick=${addInShop}>${isBusy("shopadd")?html`<${Spin}/>`:"Add"}</button>
      </div>
      ${shopGroups.length===0
        ? html`<div class="empty"><div class="big">Nothing left for ${sname(checkedIn)}</div>You're all done here \u2014 check out.</div>`
        : shopGroups.map(g=>{
            const open=g.open;
            return html`
            <${Panel} title=${g.cat} count=${g.items.filter(i=>!i.checked).length+"/"+g.items.length} color=${scolor(checkedIn)} open=${open} onToggle=${()=>toggleCat(g.key)}>
              ${g.items.map(it=>html`
                <div class=${"item"+(it.checked?" done":"")} style=${"--sc:"+scolor(checkedIn)} onClick=${()=>toggle(it)}>
                  <div class="box">${check}</div>
                  <div class="label">
                    <span class="lname">${it.name}</span>
                    ${(it.tags&&it.tags.length)?html`<span class="ltags">${it.tags.map(t=>html`<span class="ltag">${t}</span>`)}</span>`:null}
                  </div>
                  ${it.stores.length>1?html`<div class="also">${it.stores.filter(x=>x!==checkedIn).map(x=>lsq(scolor(x),sname(x)))}</div>`:null}
                </div>`)}
            <//>`;})}` ):null}

    ${page==="history"?html`
      <div class="pagetitle">Purchase History</div>
      <div class="filters">
        <button class=${"fbtn"+(pendingOnly?" on":"")} onClick=${()=>setPendingOnly(p=>!p)}>Pending returns</button>
        <select class="sel sm" value=${sortBy} onChange=${e=>setSortBy(e.target.value)}>
          <option value="date">Sort: Date</option><option value="store">Sort: Store</option>
        </select>
        <button class="fbtn" onClick=${()=>setSortDir(d=>d==="desc"?"asc":"desc")}>${sortDir==="desc"?"Newest first":"Oldest first"}</button>
        <select class="sel sm" value=${pFilterStore} onChange=${e=>setPFilterStore(e.target.value)}>
          <option value="all">All stores</option>
          ${stores.map(s=>html`<option value=${s.id}>${s.name}</option>`)}
        </select>
        <select class="sel sm" value=${pFilterCat} onChange=${e=>setPFilterCat(e.target.value)}>
          <option value="all">All categories</option>
          ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
        </select>
        <select class="sel sm" value=${pFilterRange} onChange=${e=>setPFilterRange(e.target.value)}>
          <option value="7">7 days</option><option value="30">30 days</option>
          <option value="90">90 days</option><option value="180">6 months</option>
          <option value="365">1 year</option><option value="all">All time</option>
        </select>
      </div>
      ${filteredPurch.length===0
        ? html`<div class="empty"><div class="big">No purchases</div>Items you mark bought show up here.</div>`
        : html`
          <div class="listcount">${filteredPurch.length} item${filteredPurch.length===1?"":"s"}${histPages>1?html` \u00b7 <span class="lcmuted">page ${histPage} of ${histPages}</span>`:null}</div>
          ${histSlice.map(p=>{
            const ret=p.status==="returning"; const d=ret?daysUntil(p.returnByDate):null;
            const rk="ret_"+p.id, kk="keep_"+p.id;
            return html`
            <div class=${"prow"+(ret?(d<0?" over":d<=5?" due":""):"")}>
              <button class=${"rowstar lead-star"+(isStaple(p.name)?" on":"")} onClick=${()=>toggleStaple(p.name,(dict[p.name]&&dict[p.name].stores)||[p.store],(dict[p.name]&&dict[p.name].category)||"Unsorted")}>${isStaple(p.name)?"\u2605":"\u2606"}</button>
              <div class="pinfo">
                <span class="pname">${p.name}</span>
                <span class="pmeta">${lsq(scolor(p.store),sname(p.store))}${sname(p.store)} \u00b7 ${p.date}
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
            </div>`;})}
          ${histPages>1?html`
            <div class="pager">
              <button class="ghost" disabled=${histPage<=1} onClick=${()=>setHistPage(p=>Math.max(1,p-1))}>\u2190 Prev</button>
              <span class="pnum">${histPage} / ${histPages}</span>
              <button class="ghost" disabled=${histPage>=histPages} onClick=${()=>setHistPage(p=>Math.min(histPages,p+1))}>Next \u2192</button>
            </div>`:null}`}`:null}
    `}

    <!-- add items -->
    ${showAdd?html`
      <div class="scrim" onClick=${()=>setShowAdd(false)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">Paste Your Voice List</div><button class="sheetx" onClick=${()=>setShowAdd(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Alexa, WhatsApp, Notes \u2014 one line or comma-separated. Basketly splits it and files each item to the right store.</div>
        <textarea placeholder=${"2 lbs onions\ncilantro\npaneer\nmilk\ntoor dal"} value=${draft} onInput=${e=>setDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${parsing||!draft.trim()} onClick=${addItems}>${parsing?html`<${Spin}/>Routing\u2026`:"Add to list"}</button>
      </div>`:null}
    ${review.length>0?html`
      <div class="scrim" onClick=${()=>setReview([])}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">New Items \u2014 Fix Any Store</div><button class="sheetx" onClick=${()=>setReview([])} aria-label="Close">\u00d7</button></div>
        ${review.map(k=>{const meta=dict[k]||{stores:[],category:"Unsorted"};return html`
          <div class="rrow"><span class="rname">${k}</span><span class="rcat">${meta.category}</span>
            ${stores.map(s=>html`<button class=${"chip mini"+(meta.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleReviewStore(k,s.id)}>
              ${lsq(s.color,s.name)}${s.name}</button>`)}
          </div>`;})}
        <button class="primary" onClick=${()=>setReview([])}>Done</button>
      </div>`:null}

    <!-- item editor -->
    ${itemModal?html`
      <div class="scrim" onClick=${()=>setItemModal(null)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">${itemModal.name}</div><button class="sheetx" onClick=${()=>setItemModal(null)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Category</div>
        <select class="sel" value=${editCat} onChange=${e=>setEditCat(e.target.value)}>
          ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
        </select>
        <div class="hint">Stores</div>
        <div class="chiprow">${stores.map(s=>html`<button class=${"chip mini"+(editStores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleEditStore(s.id)}>
          ${lsq(s.color,s.name)}${s.name}</button>`)}</div>
        <div class="hint">Tags (for whom)</div>
        <div class="tagedit">
          ${editTags.map(t=>html`<span class="tagchip on">${t}<button class="tagx" onClick=${()=>removeTag(t)}>\u00d7</button></span>`)}
        </div>
        <input class="tin" placeholder="Add a tag (e.g. son) \u2014 Enter" value=${tagDraft} onInput=${e=>setTagDraft(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter"){e.preventDefault();addTag();}}} />
        <button class="primary" disabled=${isBusy("saveitem")} onClick=${saveItem}>${isBusy("saveitem")?html`<${Spin}/>Saving\u2026`:"Save"}</button>
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
        <div class="lead" style="margin-top:10px">Add a Store</div>
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
        <div class="sheethead"><div class="lead">Deleting ${delStore.name}</div><button class="sheetx" onClick=${()=>setDelStore(null)} aria-label="Close">\u00d7</button></div>
        <div class="hint">These items are only at ${delStore.name}. Pick a new store for each, or leave blank to move it to Unsorted.</div>
        ${orphansOf(delStore.id).map(it=>html`
          <div class="orow">
            <span class="rname">${it.name}</span>
            <div class="chiprow">
              ${stores.filter(s=>s.id!==delStore.id).map(s=>html`
                <button class=${"chip mini"+((reassign[it.id]===s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>setReassign(r=>({...r,[it.id]:r[it.id]===s.id?undefined:s.id}))}>
                  ${lsq(s.color,s.name)}${s.name}</button>`)}
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
        <button class="ddm" onClick=${()=>{setMenu(false);setStapleSel({});setStaplesModal(true);}}>Regularly Bought</button>
        <button class="ddm" onClick=${()=>{setMenu(false);openRecipes();}}>Recipe Ideas</button>
        <button class="ddm" onClick=${()=>{setMenu(false);setKitchenModal(true);}}>Kitchen Staples</button>
        <button class="ddm" onClick=${()=>{setMenu(false);openStores();}}>Manage Stores</button>
        <button class="ddm" onClick=${()=>{setMenu(false);openCats();}}>Manage Categories</button>
        <div class="ddsep"></div>
        <button class="ddm ddout" onClick=${()=>signOut(auth)}>Sign out</button>
      </div>`:null}

    <!-- categories -->
    ${catModal?html`
      <div class="scrim" onClick=${()=>setCatModal(false)}></div>
      <div class="sheet tall">
        <div class="sheethead"><div class="lead">Categories</div><button class="sheetx" onClick=${()=>setCatModal(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">This order is how items group on the List and Shop pages. \u201cUnsorted\u201d always stays last.</div>
        ${catDraft.map(c=>html`
          <div class="serow"><span class="flex">${c}</span>
            <button class="rowx" disabled=${isBusy("delcat_"+c)} onClick=${()=>deleteCat(c)}>${isBusy("delcat_"+c)?html`<${Spin} g=${true}/>`:"\ud83d\uddd1"}</button>
          </div>`)}
        <div class="lead" style="margin-top:10px">Add a Category</div>
        <input class="tin" placeholder="e.g. Clothes" value=${newCat} onInput=${e=>setNewCat(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter")addCat();}} />
        <button class="primary" disabled=${!newCat.trim()||isBusy("addcat")} onClick=${addCat}>${isBusy("addcat")?html`<${Spin}/>Adding\u2026`:"Add category"}</button>
      </div>`:null}

    <!-- staples palette -->
    ${staplesModal?html`
      <div class="scrim" onClick=${()=>setStaplesModal(false)}></div>
      <div class="sheet tall">
        <div class="sheethead"><div class="lead">Regularly Bought</div><button class="sheetx" onClick=${()=>setStaplesModal(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Your regulars. Tick what you need this week and add them all at once. Items already on the list are greyed out.</div>
        <input class="tin" placeholder="Add a staple (e.g. milk)" value=${newStaple} onInput=${e=>setNewStaple(e.target.value)} onKeyDown=${e=>{if(e.key==="Enter")addNewStaple();}} />
        ${staples.length===0?html`<div class="hint">Nothing here yet \u2014 star items on the List or in Purchase History to keep them here.</div>`:null}
        ${staples.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(s=>{
          const onList=list.some(i=>i.key===s.name);
          return html`<div class=${"strow"+(onList?" off":"")} onClick=${()=>{ if(!onList) setStapleSel(v=>({...v,[s.id]:!v[s.id]})); }}>
            <div class=${"box sm"+((stapleSel[s.id]&&!onList)?" on":"")}>${(stapleSel[s.id]&&!onList)?check:null}</div>
            <span class="sname2">${s.name}</span>
            <span class="lstores">${(s.stores||[]).map(x=>lsq(scolor(x),sname(x)))}</span>
            ${onList?html`<span class="tag">on list</span>`:null}
            <button class="rowx" onClick=${e=>{e.stopPropagation();toggleStaple(s.name,s.stores,s.category);}}>${isBusy("star_"+s.id)?html`<${Spin} g=${true}/>`:"\u00d7"}</button>
          </div>`;})}
        <button class="primary" disabled=${isBusy("addstaples")||!Object.values(stapleSel).some(Boolean)} onClick=${addStaplesToList}>${isBusy("addstaples")?html`<${Spin}/>Adding\u2026`:"Add selected to list"}</button>
      </div>`:null}

    <!-- assign store for items the parser couldn't route -->
    ${assignList.length>0?html`
      <div class="scrim" onClick=${commitAssign}></div>
      <div class="sheet tall">
        <div class="sheethead"><div class="lead">Which store${assignList.length>1?"s":""}?</div><button class="sheetx" onClick=${commitAssign} aria-label="Close">\u00d7</button></div>
        <div class="hint">Couldn't auto-detect where to buy ${assignList.length>1?"these":"this"}. Pick a store (and category) \u2014 I'll remember for next time.</div>
        ${assignList.map((it,idx)=>html`
          <div class="arow">
            <div class="aname">${it.name}</div>
            <select class="sel sm" value=${it.category} onChange=${e=>updateAssign(idx,{category:e.target.value})}>
              ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
            </select>
            <div class="chiprow">
              ${stores.map(s=>html`<button class=${"chip mini"+(it.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleAssignStore(idx,s.id)}>
                ${lsq(s.color,s.name)}${s.name}</button>`)}
            </div>
          </div>`)}
        <button class="primary" disabled=${isBusy("assign")} onClick=${commitAssign}>${isBusy("assign")?html`<${Spin}/>Adding\u2026`:"Add to list"}</button>
      </div>`:null}

    <!-- return date -->
    ${retModal?html`
      <div class="scrim" onClick=${()=>setRetModal(null)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">Return \u201c${retModal.name}\u201d</div><button class="sheetx" onClick=${()=>setRetModal(null)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Bought at ${sname(retModal.store)} on ${retModal.date}. Enter the return-by date \u2014 a red banner appears within 5 days of it.</div>
        <input class="tin" type="date" value=${retDate} min=${todayISO()} onInput=${e=>setRetDate(e.target.value)} />
        <label class="attachbtn">${retFile?("\u2713 "+retFile.name):"\ud83d\udcce Attach receipt / QR / label \u2014 image or PDF (optional)"}
          <input type="file" accept="image/*,application/pdf" onChange=${e=>setRetFile(e.target.files[0]||null)} />
        </label>
        <button class="primary" disabled=${!retDate||isBusy("confirmret")} onClick=${confirmReturn}>${isBusy("confirmret")?html`<${Spin}/>Saving\u2026`:"Mark for return"}</button>
      </div>`:null}

    <!-- kitchen staples -->
    ${kitchenModal?html`
      <div class="scrim" onClick=${()=>setKitchenModal(false)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">Kitchen Staples</div><button class="sheetx" onClick=${()=>setKitchenModal(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Things you always have \u2014 recipes assume these are on hand so you don't list them each time.</div>
        <div class="tagedit ringlist">
          ${kitchen.map(t=>html`<span class="tagchip on">${t}<button class="tagx" onClick=${()=>removeKitchen(t)}>\u00d7</button></span>`)}
        </div>
        <textarea class="tin ta short" placeholder="salt, flour, eggs, honey\u2026 (comma or new line)" value=${kDraft} onInput=${e=>setKDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${isBusy("kitchen")||!kDraft.trim()} onClick=${addKitchen}>${isBusy("kitchen")?html`<${Spin}/>`:"Add"}</button>
      </div>`:null}

    <!-- quick category picker -->
    ${catPick?html`
      <div class="scrim" onClick=${()=>setCatPick(null)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">Category \u00b7 ${catPick.name}</div><button class="sheetx" onClick=${()=>setCatPick(null)} aria-label="Close">\u00d7</button></div>
        <div class="catgrid">
          ${cats.map(c=>html`<button class=${"catopt"+((catPick.category||"Unsorted")===c?" on":"")} onClick=${()=>{ if(c!==(catPick.category||"Unsorted")) recategorize(catPick,c); setCatPick(null); }}>${c}</button>`)}
        </div>
      </div>`:null}

    <!-- recipe ideas -->
    ${recipeOpen?html`
      <div class="recipepage">
        <div class="rphead">
          <div class="rptitle">Recipe Ideas</div>
          <button class="sheetx" onClick=${()=>setRecipeOpen(false)} aria-label="Close">\u00d7</button>
        </div>
        <div class="rpbody">
          <div class="hint">Your ingredients (comma or line separated)</div>
          <textarea class="tin ta" placeholder="e.g. paneer, spinach, tomato, rice\nor one per line" value=${rIng} onInput=${e=>setRIng(e.target.value)}></textarea>
          ${recentProduce.length>0?html`
            <div class="hint">Bought in the last 30 days \u2014 tap what you still have</div>
            <div class="chiprow">${recentProduce.map(p=>html`<button class="selchip" onClick=${()=>addIngChip(p)}>+ ${p}</button>`)}</div>`:null}
          ${kitchen.length?html`<details class="assumed"><summary>Assumed on hand (${kitchen.length}) \u00b7 <button class="linkbtn" onClick=${e=>{e.preventDefault();setKitchenModal(true);}}>edit</button></summary><div class="assumedlist">${kitchen.join(", ")}</div></details>`:html`<div class="assumed"><button class="linkbtn" onClick=${()=>setKitchenModal(true)}>Set kitchen staples</button> (salt, flour, eggs\u2026) so recipes assume them.</div>`}
          <div class="hint">Cuisine (optional)</div>
          <div class="chiprow">${CUISINES.map(c=>html`<button class=${"selchip"+(rCuisine===c?" on":"")} onClick=${()=>setRCuisine(rCuisine===c?"":c)}>${c}</button>`)}</div>
          <div class="hint">Meal type</div>
          <div class="chiprow">${MEALS.map(([v,l])=>html`<button class=${"selchip"+(rMeal===v?" on":"")} onClick=${()=>setRMeal(v)}>${l}</button>`)}</div>
          <div class="hint">Who's it for?</div>
          <div class="chiprow">${WHO.map(([v,l])=>html`<button class=${"selchip"+(rWho===v?" on":"")} onClick=${()=>setRWho(v)}>${l}</button>`)}</div>
          ${rWho==="baby"?html`
            <div class="hint">Baby's age</div>
            <div class="chiprow">${AGES.map(([v,l])=>html`<button class=${"selchip"+(rAge===v?" on":"")} onClick=${()=>setRAge(v)}>${l}</button>`)}</div>`:null}
          <div class="hint">Flavor (optional)</div>
          <div class="chiprow">${FLAVORS.map(f=>html`<button class=${"selchip"+(rFlavors.has(f)?" on":"")} onClick=${()=>toggleFlavor(f)}>${f}</button>`)}</div>
          <button class="primary" disabled=${rLoading||!rIng.trim()||(rWho==="baby"&&!rAge)} onClick=${getRecipes}>${rLoading?html`<${Spin}/>Thinking\u2026`:"Get ideas"}</button>
          ${rErr?html`<div class="rerr">${rErr}</div>`:null}
          ${rResults?(rResults.length===0
            ? html`<div class="empty"><div class="big">No ideas came back</div>Try adding a couple more ingredients.</div>`
            : html`
              ${rWho==="baby"?html`<div class="babycaveat">Ideas only \u2014 check textures for your baby's age, and avoid honey under 12 months, added salt/sugar, and choking hazards. If they keep refusing food, it's worth checking with your pediatrician.</div>`:null}
              <div class="rlist">
                ${rResults.map((d,i)=>html`
                  <div class="panel">
                    <button class="phead" onClick=${()=>setROpen(o=>({...o,[i]:!o[i]}))}>
                      <span class="ptitle">${d.name}</span>
                      <span class="pright">${d.minutes?html`<span class="pcount">${d.minutes} min</span>`:null}<span class=${"pcaret"+(rOpen[i]?" up":"")}>\u25be</span></span>
                    </button>
                    ${rOpen[i]?html`<div class="pbody rbody">
                      ${(d.need&&d.need.length)?html`<div class="needline">You'd need: ${d.need.join(", ")}</div>`:html`<div class="haveline">You have everything for this</div>`}
                      ${(d.ingredientsUsed&&d.ingredientsUsed.length)?html`<div class="rsec"><h5>Uses</h5><p>${d.ingredientsUsed.join(", ")}</p></div>`:null}
                      ${(d.steps&&d.steps.length)?html`<div class="rsec"><h5>Steps</h5><ol>${d.steps.map(s=>html`<li>${s}</li>`)}</ol></div>`:null}
                      ${d.notes?html`<div class="rsec"><h5>Notes</h5><p>${d.notes}</p></div>`:null}
                      ${d.oneExtra?html`<div class="rsec rextra"><h5>With one more item</h5><p>${d.oneExtra}</p></div>`:null}
                    </div>`:null}
                  </div>`)}
              </div>`):null}
        </div>
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
