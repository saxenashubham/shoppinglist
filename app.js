import { h, render } from "https://esm.sh/preact@10.19.3";
import { useState, useEffect, useMemo, useRef } from "https://esm.sh/preact@10.19.3/hooks";
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
const BUILD = "v63";  // bump in lockstep with sw.js CACHE every deploy
function textOn(hex){ if(!hex||hex[0]!=="#") return "#161d18"; let h=hex.slice(1); if(h.length===3)h=h.split("").map(c=>c+c).join(""); const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16); const L=(0.299*r+0.587*g+0.114*b)/255; return L>0.62?"#161d18":"#fff"; }
const sqChar=n=>(((n||"?").trim()[0])||"?").toUpperCase();
const lsq=(color,name,cls)=>html`<i class=${"lsq"+(cls?" "+cls:"")} style=${"background:"+(color||"#ccc")+";color:"+textOn(color)}>${sqChar(name)}</i>`;
const WHO=[["baby","Baby"],["kids","Kids"],["adults","Adults"],["family","Whole family"]];
const AGES=[["u6","Under 6 mo"],["6_9","6-9 mo"],["9_12","9-12 mo"],["12_18","12-18 mo"],["18_36","18-36 mo"]];
const FLAVORS=["Sweet","Savory","Spicy","Mild"];
const MEALS=[["snack","Snack"],["meal","Meal"],["soft","Soft (sore gums)"]];
let _migRan=false;
let _lp=null, _suppressClick=false;
let _checkoutLock=false;
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

// slug() is still the id scheme for NON-item things (stores, categories, busy keys).
// Item identity uses canon() — see below.
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,120) || "x";
const titleCase = s => (s||"").split(" ").map(w=>w?w.charAt(0).toUpperCase()+w.slice(1):w).join(" ");

// ---- canonical item identity -------------------------------------------------
// "Diapers" and "diaper" must be ONE dictionary doc. canon() is the match key and
// the dictionary/staples document id. Display names are never touched by this.
// Seeded into config.app as `noStrip` so new exceptions don't need a redeploy.
const NO_STRIP_SEED = ["hummus","chips","oats","greens","grapes","berries","molasses","couscous","asparagus","lentils","noodles","sprouts"];
function singularWord(w, noStrip){
  if(!w || w.length<4) return w;
  if(noStrip && noStrip.has(w)) return w;
  if(/ies$/.test(w) && w.length>4) return w.slice(0,-3)+"y";   // berries -> berry
  if(/oes$/.test(w)) return w.slice(0,-2);                     // tomatoes -> tomato
  if(/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0,-2);         // boxes -> box, dishes -> dish
  if(/ss$/.test(w)) return w;                                  // glass, dress
  if(/us$/.test(w)) return w;                                  // hummus, asparagus
  if(/s$/.test(w)) return w.slice(0,-1);                       // diapers -> diaper
  return w;
}
function canon(name, noStrip){
  const words = String(name||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if(!words.length) return "x";
  return words.map(w=>singularWord(w,noStrip)).join("_").slice(0,120) || "x";
}
// Bounded Levenshtein — bails out as soon as it exceeds `max` (we only ever care about <=2).
function levWithin(a, b, max){
  a=String(a||""); b=String(b||"");
  if(Math.abs(a.length-b.length)>max) return max+1;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i]; let best=i;
    for(let j=1;j<=b.length;j++){
      const v=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
      cur[j]=v; if(v<best) best=v;
    }
    if(best>max) return max+1;
    prev=cur;
  }
  return prev[b.length];
}
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
// lookup() now lives inside App() as a closure over the canonical index (byCanon).
// It is an EXACT canonical-key match — the old two-way substring fallback is gone,
// because it silently routed "Corn" to "Popcorn". Near-misses are surfaced as an
// explicit fuzzy suggestion instead (see fuzzyFor) rather than auto-applied.
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
// Slide-to-confirm: a tap does nothing; must drag the thumb ~90% across to fire onConfirm.
function SlideConfirm({label, onConfirm, busy}){
  const trackRef=useRef(null);
  const [x,setX]=useState(0);
  const xRef=useRef(0), maxRef=useRef(1), startRef=useRef(0), dragRef=useRef(false), doneRef=useRef(false);
  const THUMB=52, PAD=4;
  const setPos=v=>{ xRef.current=v; setX(v); };
  function measure(){ const t=trackRef.current; maxRef.current=t?Math.max(1,t.clientWidth-THUMB-PAD*2):1; }
  function onDown(e){ if(busy||doneRef.current) return; try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){} measure(); dragRef.current=true; startRef.current=e.clientX-xRef.current; }
  function onMove(e){ if(!dragRef.current) return; let nx=e.clientX-startRef.current; nx=Math.max(0,Math.min(maxRef.current,nx)); setPos(nx); }
  function onUp(e){ if(!dragRef.current) return; dragRef.current=false; try{e.currentTarget.releasePointerCapture(e.pointerId);}catch(_){}
    if(xRef.current>=maxRef.current*0.9){ doneRef.current=true; setPos(maxRef.current); onConfirm(); }
    else setPos(0); }
  const pct=maxRef.current?xRef.current/maxRef.current:0;
  return html`<div class="slidetrack" ref=${trackRef}>
    <span class="slidelabel" style=${"opacity:"+(1-Math.min(1,pct*1.7))}>${busy?"Saving\u2026":label}</span>
    <button class="slidethumb" style=${"transform:translateX("+x+"px)"+(dragRef.current?";transition:none":"")}
      onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}
      aria-label="Slide to check out">${busy?html`<${Spin}/>`:"\u2192"}</button>
  </div>`;
}

function App(){
  const [user,setUser]=useState(undefined);
  const [loading,setLoading]=useState(true);
  const [migDone,setMigDone]=useState(null);
  const [stores,setStores]=useState(DEFAULT_STORES);
  const [dictDocs,setDictDocs]=useState([]);        // raw dictionary docs: {id,name,stores,category,notSame}
  const [noStrip,setNoStrip]=useState(NO_STRIP_SEED);
  const [dedupeMigrated,setDedupeMigrated]=useState(true); // assume done until config says otherwise
  const [list,setList]=useState([]);
  const [purch,setPurch]=useState([]);
  const [page,setPage]=useState("list");
  const [checkedIn,setCheckedIn]=useState(null);
  const [swVer,setSwVer]=useState("");   // active service-worker cache version, for the deploy check
  const [shopAdd,setShopAdd]=useState("");
  const [draft,setDraft]=useState("");
  const [quickAdd,setQuickAdd]=useState("");      // single-line add on the Add sheet (typeahead source)
  const [dupOpen,setDupOpen]=useState(false);
  const [dupPage,setDupPage]=useState(1);
  const [dupWin,setDupWin]=useState({});          // canonical key -> winning doc id
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
  const [editName,setEditName]=useState("");
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
  function openRecipes(){ setRecipeTab("new"); setRecipeOpen(true); }
  // ---- saved recipes (favorites) + add-ingredients-to-list ----
  const isSavedRecipe=name=>savedRecipes.some(r=>(r.name||"").toLowerCase()===(name||"").toLowerCase());
  function toggleSaveRecipe(d){
    const id=slug(d.name);
    const ref=doc(db,"shoppinglist_recipes",id);
    return run("saverec_"+id, ()=> isSavedRecipe(d.name)
      ? deleteDoc(ref)
      : setDoc(ref,{name:d.name,minutes:d.minutes||null,need:d.need||[],ingredientsUsed:d.ingredientsUsed||[],steps:d.steps||[],notes:d.notes||"",oneExtra:d.oneExtra||"",ts:serverTimestamp()}));
  }
  // strip a leading quantity + measure word so "2 cloves garlic" -> "Garlic"; local only, never touches the global parser
  const cleanNeed=s=>normalizeName(String(s||"").replace(/^\s*[\d\u00bc\u00bd\u00be\u2153\u2154\u215b/.\s-]*\s*(cups?|cloves?|tbsps?|tablespoons?|tsps?|teaspoons?|pinch(es)?|cans?|sprigs?|slices?|pieces?|sticks?|heads?|bunch(es)?|handfuls?)\b\s*(of\s+)?/i,""));
  // a recipe ingredient counts as a kitchen staple if a staple name matches it whole-word (so "salt to taste" is filtered, "olive oil" is not filtered by staple "oil" unless "oil" is a standalone word)
  const ingMatchesKitchen=n=>{ const c=cleanNeed(n).toLowerCase().trim(); if(!c) return false; const w=c.split(/\s+/); return kitchen.some(k=>{ const kl=(k||"").toLowerCase().trim(); return kl && (c===kl || w.includes(kl)); }); };
  // what a recipe offers to add: its buy-list (need) if present, else all ingredients used, minus assumed kitchen staples
  function recipeAddSource(d){ const need=d.need||[]; const used=d.ingredientsUsed||[]; return (need.length?need:used).filter(n=>!ingMatchesKitchen(n)); }
  function openAddRecipe(d){
    const need=d.need||[];
    const source=recipeAddSource(d);
    const isNeed=n=>need.some(x=>(x||"").toLowerCase()===(n||"").toLowerCase());
    const sel={}; source.forEach(n=>{ sel[n]={on:isNeed(n), name:cleanNeed(n)||n}; });
    setNeedSel(sel); setAddRecipe(d);
  }
  async function addRecipeNeeds(){
    const d=addRecipe; if(!d){ return; }
    const source=recipeAddSource(d);
    const chosen=source
      .filter(n=>needSel[n]&&needSel[n].on)
      .map(n=>titleCase((needSel[n].name||"").trim()))
      .filter(Boolean);
    if(!chosen.length){ setAddRecipe(null); return; }
    const existing=new Set(list.map(i=>ckey(i.key||i.name)));
    const toAdd=[], needAssign=[];
    for(const raw of chosen){
      const { name:nm, key:k } = resolveName(raw);
      if(!nm || existing.has(k)) continue; existing.add(k);
      const known=lookup(nm);
      if(known && (known.stores||[]).length) toAdd.push({name:known.name||nm,stores:known.stores,category:known.category||"Unsorted"});
      // no store known -> assign modal, not a silent storeless row
      else needAssign.push({name:nm,stores:[],category:(known&&known.category)||"Unsorted",fuzzy:fuzzyFor(nm)});
    }
    if(!toAdd.length && !needAssign.length){ setAddRecipe(null); flash("Already on your list"); return; }
    if(toAdd.length){
      await writeAdds("addrecipe", toAdd);
      flash(toAdd.length===1?`"${toAdd[0].name}" added`:`${toAdd.length} added to list`);
    }
    setAddRecipe(null);
    if(needAssign.length) setAssignList(needAssign);
  }
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
  const [savedRecipes,setSavedRecipes]=useState([]);
  const [recipeTab,setRecipeTab]=useState("new");   // "new" | "saved"
  const [addRecipe,setAddRecipe]=useState(null);     // dish whose ingredients are being added
  const [needSel,setNeedSel]=useState({});           // {needString: bool}

  const flash=m=>{setToast(m);setTimeout(()=>setToast(""),1800);};
  const scolor=id=>(stores.find(s=>s.id===id)||{}).color||"#ccc";
  const sname=id=>(stores.find(s=>s.id===id)||{}).name||id;

  // ---- canonical identity, built once per dictionary/config change ----
  const noStripSet=useMemo(()=>new Set((noStrip||[]).map(x=>String(x||"").toLowerCase().trim()).filter(Boolean)),[noStrip]);
  const ckey=useMemo(()=>(name=>canon(name,noStripSet)),[noStripSet]);
  // One entry per canonical key. Legacy splits (two docs, same canonical key) are
  // folded here at read time so routing is deterministic BEFORE the merge tool runs.
  const byCanon=useMemo(()=>{
    const m=new Map();
    for(const d of dictDocs){
      const k=ckey(d.name||d.id); if(!k) continue;
      const cur=m.get(k);
      if(!cur){ m.set(k,{key:k,name:d.name||d.id,stores:[...(d.stores||[])],category:d.category||"Unsorted",notSame:[...(d.notSame||[])],ids:[d.id]}); continue; }
      cur.stores=[...new Set([...cur.stores,...(d.stores||[])])];
      if((cur.category||"Unsorted")==="Unsorted" && d.category && d.category!=="Unsorted") cur.category=d.category;
      cur.notSame=[...new Set([...cur.notSame,...(d.notSame||[])])];
      cur.ids.push(d.id);
    }
    return m;
  },[dictDocs,ckey]);
  // EXACT canonical match only. No substring fallback — near-misses go through fuzzyFor().
  const lookup=name=>byCanon.get(ckey(name))||null;
  const dictRef=name=>doc(db,"shoppinglist_dictionary",ckey(name));
  const stapleRef=name=>doc(db,"shoppinglist_staples",ckey(name));
  // The one funnel every item-name write goes through: strip quantities, Title-Case
  // for display, canonical key for identity. Never call normalizeName directly on a
  // write path — add it here instead.
  const resolveName=raw=>{ const name=normalizeName(raw); return {name,key:ckey(name)}; };
  const onList=name=>{ const k=ckey(name); return list.some(i=>ckey(i.key||i.name)===k); };

  // the dictionary is the source of truth for store mapping; the row's own stores are a warm offline fallback
  const storesOf=it=>{ const m=lookup(it.key||it.name); return (m&&m.stores&&m.stores.length)?m.stores:(it.stores||[]); };

  // ---- typeahead + fuzzy suggestion -------------------------------------------
  // Ranking source: how often and how recently a thing was actually bought.
  const purchStats=useMemo(()=>{
    const m=new Map();
    for(const p of purch){
      const k=ckey(p.name); if(!k) continue;
      const t=Date.parse((p.date||"")+"T00:00:00");
      const cur=m.get(k)||{n:0,last:0};
      cur.n++; if(!isNaN(t)&&t>cur.last) cur.last=t;
      m.set(k,cur);
    }
    return m;
  },[purch,ckey]);
  const rankOf=k=>{
    const s=purchStats.get(k); if(!s) return 0;
    const days=s.last?Math.max(0,(Date.now()-s.last)/864e5):999;
    return s.n*Math.exp(-days/45);          // frequency x recency
  };
  // Filters the dictionary we already hold in memory. No Firestore query per keystroke.
  const suggest=(q,limit=5)=>{
    const t=String(q||"").trim().toLowerCase(); if(!t) return [];
    const tk=ckey(t), out=[];
    for(const e of byCanon.values()){
      const nl=(e.name||"").toLowerCase();
      const pos=nl.indexOf(t);
      if(pos<0 && !(tk && e.key.includes(tk))) continue;
      out.push({...e,_pre:pos===0?1:0,_rank:rankOf(e.key)});
    }
    out.sort((a,b)=>(b._pre-a._pre)||(b._rank-a._rank)||a.name.localeCompare(b.name));
    return out.slice(0,limit);
  };
  // Levenshtein <= 2 on canonical keys. SUGGEST ONLY — never auto-applied — and never
  // offered for a pair the user already rejected (notSame), or the prompt turns into
  // nagware and gets blind-dismissed.
  const fuzzyFor=name=>{
    const k=ckey(name); if(!k||k.length<4) return null;
    if(byCanon.has(k)) return null;   // exact after normalization: merges silently, nothing to ask
    let best=null;
    for(const e of byCanon.values()){
      if((e.notSame||[]).includes(k)) continue;
      const d=levWithin(k,e.key,2);
      if(d<=2 && (!best || d<best.d || (d===best.d && rankOf(e.key)>rankOf(best.key)))) best={...e,d};
    }
    return best;
  };
  // Tapping a suggestion: fully routed straight from the dictionary — no parser
  // call, no assign modal.
  async function addFromSuggestion(entry, forceStore){
    const { name:nm, key:k } = resolveName(entry.name);
    if(list.some(i=>ckey(i.key||i.name)===k)){ flash(nm+" is already on your list"); return; }
    const st=forceStore?[...new Set([...(entry.stores||[]),forceStore])]:[...(entry.stores||[])];
    if(!st.length){ setAssignList([{name:nm,stores:[],category:entry.category||"Unsorted",fuzzy:null}]); return; }
    await writeAdds("quickadd",[{name:nm,stores:st,category:entry.category||"Unsorted"}]);
    flash(`"${nm}" added to ${entry.category||"Unsorted"}`);
  }
  // Rendered as a static block BELOW the input, not an overlay and not inline ghost
  // text — ghost text + setSelectionRange fights Android autocorrect and IME composition.
  function typeahead(q,{onPick,store,isOn,onLabel}={}){
    const rows=suggest(q);
    const fz=(q||"").trim().length>=3?fuzzyFor(q):null;
    const showFz=fz && !rows.some(r=>r.key===fz.key);
    if(!rows.length && !showFz) return null;
    return html`<div class="talist">
      ${showFz?html`
        <div class="tafuzzy">
          <span class="tafzq">Did you mean <b>${fz.name}</b>?</span>
          <span class="tafza">
            <button class="linkbtn" onClick=${()=>onPick(fz)}>Use it</button>
            <button class="ghost mut" onClick=${()=>rejectFuzzy(fz.key,q)}>Not the same</button>
          </span>
        </div>`:null}
      ${rows.map(e=>{
        const on=isOn?isOn(e):onList(e.name);   // greyed, not hidden — same pattern as Regularly Bought
        const st=store?[...new Set([...(e.stores||[]),store])]:(e.stores||[]);
        return html`<button class=${"tarow"+(on?" off":"")} disabled=${on} onClick=${()=>{ if(!on) onPick(e); }}>
          <span class="taname">${e.name}</span>
          <span class="catchip">${e.category||"Unsorted"}</span>
          <span class="lstores">${st.map(s=>lsq(scolor(s),sname(s)))}</span>
          ${on?html`<span class="tag">${onLabel||"on list"}</span>`:null}
        </button>`;})}
    </div>`;
  }

  // ---- legacy duplicate cleanup ------------------------------------------------
  // Everything above keeps NEW writes canonical. This is the one-shot sweep for
  // splits already sitting in the dictionary. Guarded by config.dedupeMigrated —
  // flip that boolean back to false in the console to re-run it.
  const DUP_PER=20;
  const dupGroups=useMemo(()=>{
    const g=new Map();
    for(const d of dictDocs){
      const k=ckey(d.name||d.id); if(!k) continue;
      if(!g.has(k)) g.set(k,[]);
      g.get(k).push(d);
    }
    return [...g.entries()].filter(([,ms])=>ms.length>1)
      .map(([key,members])=>({key,members:members.slice().sort((a,b)=>
        ((b.stores||[]).length-(a.stores||[]).length)||(a.name||"").localeCompare(b.name||""))}))
      .sort((a,b)=>a.key.localeCompare(b.key));
  },[dictDocs,ckey]);
  const dupPages=Math.max(1,Math.ceil(dupGroups.length/DUP_PER));
  const dupSlice=dupGroups.slice((dupPage-1)*DUP_PER,dupPage*DUP_PER);
  const dupWinner=g=>g.members.find(m=>m.id===dupWin[g.key])||g.members[0];
  function dupCatNote(g){
    const w=dupWinner(g);
    const loser=g.members.filter(m=>m.id!==w.id).map(m=>m.category).find(c=>c&&c!=="Unsorted"&&c!==w.category);
    if(!loser) return null;                                  // loser Unsorted -> winner's, silently
    return (w.category&&w.category!=="Unsorted")?`${w.category} ← ${loser}`:`${loser}`;
  }
  // MERGE, not delete. Write order is deliberate: winner doc -> list/staples
  // rewrite -> loser docs last, so a mid-flight failure can't orphan a list row.
  // shoppinglist_purchased is never touched: history stays as it happened.
  async function mergeGroup(g){
    const winner=dupWinner(g);
    const name=winner.name;
    const stores=[...new Set(g.members.flatMap(m=>m.stores||[]))];
    const loserCat=g.members.filter(m=>m.id!==winner.id).map(m=>m.category).find(c=>c&&c!=="Unsorted");
    const category=(winner.category&&winner.category!=="Unsorted")?winner.category:(loserCat||"Unsorted");
    const notSame=[...new Set(g.members.flatMap(m=>m.notSame||[]))];
    await run("merge_"+g.key, async ()=>{
      // 1. winner, at the canonical id
      await setDoc(doc(db,"shoppinglist_dictionary",g.key),{name,stores,category,notSame},{merge:true});
      // 2. repoint live list rows and staples
      const b=writeBatch(db);
      const rows=list.filter(i=>ckey(i.key||i.name)===g.key);
      if(rows.length){
        const keep=rows[0];
        b.set(doc(db,"shoppinglist_list",keep.id),{
          key:name,name,
          stores:[...new Set([...(keep.stores||[]),...stores])],
          tags:[...new Set(rows.flatMap(r=>r.tags||[]))],   // per-instance tags preserved across the fold
          category:(keep.category&&keep.category!=="Unsorted")?keep.category:category
        },{merge:true});
        for(const extra of rows.slice(1)) b.delete(doc(db,"shoppinglist_list",extra.id));
      }
      const st=staples.filter(s=>ckey(s.name)===g.key);
      if(st.length){
        b.set(doc(db,"shoppinglist_staples",g.key),{name});
        for(const s of st) if(s.id!==g.key) b.delete(doc(db,"shoppinglist_staples",s.id));
      }
      await b.commit();
      // 3. loser dictionary docs LAST
      const b2=writeBatch(db);
      let n=0;
      for(const m of g.members) if(m.id!==g.key){ b2.delete(doc(db,"shoppinglist_dictionary",m.id)); n++; }
      if(n) await b2.commit();
    });
    flash("Merged as “"+name+"”");
  }
  async function mergeVisible(){
    for(const g of dupSlice) await mergeGroup(g);
    setDupPage(1);
  }
  async function finishDedupe(){
    await run("dedupedone",()=>setDoc(cfgDoc(),{dedupeMigrated:true},{merge:true}));
    setDupOpen(false); flash("Duplicate cleanup marked done");
  }
  const toggleCat=key=>setCollapsed(c=>({...c,[key]:!c[key]}));
  const [drag,setDrag]=useState(null);
  const [ghost,setGhost]=useState(null);
  const [overCat,setOverCat]=useState(null);
  const [reorder,setReorder]=useState(false);
  const [catPick,setCatPick]=useState(null);
  const [catAdd,setCatAdd]=useState(null);
  const [storeAdd,setStoreAdd]=useState(null);
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
  function openAddCat(onDone){ setCatAdd({name:"",onDone}); }
  async function commitAddCat(){
    const nm=(catAdd&&catAdd.name||"").trim(); if(!nm) return;
    const cur=cats.filter(c=>c!=="Unsorted");
    let finalName=cur.find(c=>c.toLowerCase()===nm.toLowerCase());
    if(!finalName){ finalName=nm; await run("quickcat",()=>setDoc(cfgDoc(),{categories:[...cur,nm]},{merge:true})); }
    const done=catAdd.onDone; setCatAdd(null); if(done) done(finalName);
  }
  function openAddStore(onDone){ setStoreAdd({name:"",color:STORE_SWATCHES[0],onDone}); }
  async function commitAddStore(){
    const nm=(storeAdd&&storeAdd.name||"").trim(); if(!nm) return;
    const id=slug(nm);
    if(!stores.some(s=>s.id===id)){
      const next=[...stores.map(serStore),{id,name:nm,color:storeAdd.color}];
      await run("quickstore",()=>setDoc(cfgDoc(),{stores:next},{merge:true}));
    }
    const done=storeAdd.onDone; setStoreAdd(null); if(done) done(id);
  }
  async function recategorize(it, cat){
    await run("recat_"+it.id, async ()=>{
      const b=writeBatch(db);
      b.set(doc(db,"shoppinglist_list",it.id),{category:cat},{merge:true});
      b.set(dictRef(it.name),{name:it.name,category:cat},{merge:true});
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
    try{ await fn(); } catch(e){ console.error("[run:"+key+"]",e); flash("Error: "+((e&&(e.code||e.message))||"unknown")); }
    finally{ setBusy(b=>{const n={...b}; delete n[key]; return n;}); } }

  useEffect(()=>onAuthStateChanged(auth,u=>{
    if(u && !ALLOWED_EMAILS.includes((u.email||"").toLowerCase())){signOut(auth);setUser(null);return;}
    setUser(u||null); if(!u) setLoading(true);
  }),[]);
  useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false);
    addEventListener("online",on);addEventListener("offline",off);
    return()=>{removeEventListener("online",on);removeEventListener("offline",off);};},[]);
  useEffect(()=>{
    if(!("caches" in self)) return;
    caches.keys().then(ks=>{const k=ks.find(x=>x.startsWith("basketly-")); if(k) setSwVer(k.slice("basketly-".length));}).catch(()=>{});
  },[]);

  useEffect(()=>{
    if(!user) return;
    (async()=>{
      const cfg=await getDoc(cfgDoc());
      if(!cfg.exists()){
        await setDoc(cfgDoc(),{stores:DEFAULT_STORES,categories:CATS,noStrip:NO_STRIP_SEED,dedupeMigrated:false});
        const b=writeBatch(db);
        for(const [k,v] of Object.entries(SEED_DICT)) b.set(doc(db,"shoppinglist_dictionary",canon(k,new Set(NO_STRIP_SEED))),{name:titleCase(k),...v});
        await b.commit();
      } else if(!Array.isArray(cfg.data().noStrip)){
        // existing household, first run on v63: seed the exception list once
        await setDoc(cfgDoc(),{noStrip:NO_STRIP_SEED},{merge:true});
      }
    })();
    const u1=onSnapshot(cfgDoc(),d=>{if(d.exists()){const dd=d.data();
      if(dd.stores){setStores(dd.stores);}
      if(dd.categories&&dd.categories.length) setCats(dd.categories.includes("Unsorted")?dd.categories:[...dd.categories,"Unsorted"]);
      if(dd.kitchen) setKitchen(dd.kitchen);
      if(Array.isArray(dd.noStrip)) setNoStrip(dd.noStrip);
      setDedupeMigrated(!!dd.dedupeMigrated);
      setMigDone(!!dd.nameCaseV1);}});
    const u2=onSnapshot(collection(db,"shoppinglist_dictionary"),snap=>{
      const docs=[];
      snap.forEach(d=>{const x=d.data();
        docs.push({id:d.id,name:x.name||d.id,stores:x.stores||[],category:x.category||"Unsorted",notSame:x.notSame||[]});
      });
      setDictDocs(docs);
    });
    const u3=onSnapshot(collection(db,"shoppinglist_list"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setList(a);setLoading(false);});
    const u4=onSnapshot(collection(db,"shoppinglist_purchased"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setPurch(a);});
    const u5=onSnapshot(collection(db,"shoppinglist_staples"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setStaples(a);});
    const u6=onSnapshot(collection(db,"shoppinglist_recipes"),snap=>{const a=[];snap.forEach(d=>a.push({id:d.id,...d.data()}));setSavedRecipes(a);});
    return()=>{u1();u2();u3();u4();u5();u6();};
  },[user]);

  async function signIn(){try{await signInWithPopup(auth,new GoogleAuthProvider());}catch{flash("Sign-in failed");}}

  // Single writer for "name -> dictionary + list row". Chunked at 200 items
  // (400 ops) because a Firestore batch caps at 500.
  async function writeAdds(busyKey, items){
    await run(busyKey, async ()=>{
      for(let i=0;i<items.length;i+=200){
        const b=writeBatch(db);
        for(const it of items.slice(i,i+200)){
          // merge:true so an existing doc's notSame[] survives
          b.set(dictRef(it.name),{name:it.name,stores:it.stores,category:it.category},{merge:true});
          b.set(doc(collection(db,"shoppinglist_list")),{key:it.name,name:it.name,stores:[...it.stores],category:it.category,checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
        }
        await b.commit();
      }
    });
  }

  async function addItems(){
    const names=splitBlob(draft).map(n=>resolveName(n).name).filter(Boolean);
    if(!names.length) return;
    const unknown=names.filter(n=>!lookup(n));
    let learned={};
    if(unknown.length){
      setParsing(true);
      try{ learned=await routeUnknowns([...new Set(unknown)],stores); }
      catch{ learned={}; flash("Couldn't reach the parser \u2014 pick a store"); }
      setParsing(false);
    }
    // learned[] is keyed by the parser's echo of the name; index it canonically so
    // "Diapers" back from the parser still matches the "diaper" we sent.
    const learnedByKey=new Map(Object.entries(learned).map(([n,v])=>[ckey(n),v]));
    const existing=new Set(list.map(i=>ckey(i.key||i.name)));
    const toAdd=[], needAssign=[];
    for(const n of names){
      const k=ckey(n);
      if(existing.has(k)) continue; existing.add(k);
      const known=lookup(n);
      if(known && (known.stores||[]).length){
        // exact-match-after-normalization: merges silently, never surfaced
        toAdd.push({name:known.name||n,stores:known.stores,category:known.category||"Unsorted"});
      } else {
        const cat=(learnedByKey.get(k)&&learnedByKey.get(k).category)||(known&&known.category)||"Unsorted";
        needAssign.push({name:n,stores:[],category:cat,fuzzy:fuzzyFor(n)});
      }
    }
    if(toAdd.length){
      await writeAdds("additems", toAdd);
      flash(toAdd.length===1 ? `"${toAdd[0].name}" added to ${toAdd[0].category}` : `${toAdd.length} items added`);
    }
    setDraft(""); setQuickAdd(""); setShowAdd(false);
    if(needAssign.length) setAssignList(needAssign);
  }
  const updateAssign=(idx,patch)=>setAssignList(a=>a.map((x,i)=>i===idx?{...x,...patch}:x));
  const toggleAssignStore=(idx,sid)=>setAssignList(a=>a.map((x,i)=>i===idx?{...x,stores:x.stores.includes(sid)?x.stores.filter(y=>y!==sid):[...x.stores,sid]}:x));
  async function commitAssign(){
    const items=assignList; if(!items.length){ setAssignList([]); return; }
    const resolved=items.map(it=>({name:resolveName(it.name).name,stores:it.stores||[],category:it.category||"Unsorted"}));
    await writeAdds("assign", resolved);
    flash(resolved.length===1 ? `"${resolved[0].name}" added to ${resolved[0].category}` : `${resolved.length} items added`);
    setAssignList([]);
  }
  // A fuzzy hit the user said isn't the same thing. Remember it on the CANDIDATE's
  // dictionary doc so we never offer that pair again — otherwise the prompt becomes
  // nagware and gets blind-dismissed.
  async function rejectFuzzy(candidateKey, typedName){
    const k=ckey(typedName); if(!candidateKey||!k) return;
    const entry=byCanon.get(candidateKey); if(!entry) return;
    const next=[...new Set([...(entry.notSame||[]),k])];
    try{ await setDoc(doc(db,"shoppinglist_dictionary",candidateKey),{notSame:next},{merge:true}); }
    catch(e){ console.error("[rejectFuzzy]",e); }
  }
  // Applies a fuzzy suggestion the user accepted: the typed name becomes the
  // candidate's name. Suggest-only — this only runs on an explicit tap.
  function acceptFuzzyInAssign(idx, cand){
    const entry=byCanon.get(cand.key); if(!entry) return;
    updateAssign(idx,{name:entry.name,stores:[...(entry.stores||[])],category:entry.category||"Unsorted",fuzzy:null});
  }
  async function toggleReviewStore(key,sid){
    const cur=lookup(key)||{stores:[],category:"Unsorted"};
    const st=cur.stores.includes(sid)?cur.stores.filter(x=>x!==sid):[...cur.stores,sid];
    await setDoc(dictRef(key),{name:cur.name||key,stores:st,category:cur.category},{merge:true});
    const k=ckey(key);
    const b=writeBatch(db); list.filter(i=>ckey(i.key||i.name)===k).forEach(i=>b.set(doc(db,"shoppinglist_list",i.id),{stores:st},{merge:true})); await b.commit();
  }
  const toggle=it=>setDoc(doc(db,"shoppinglist_list",it.id),{checked:!it.checked},{merge:true});

  // ---- item editor: remove, category (remembered), store mapping ----
  function openItem(it){ setItemModal(it); setEditCat(it.category||"Unsorted"); setEditStores([...storesOf(it)]); setEditTags([...(it.tags||[])]); setEditName(it.name||it.key||""); setTagDraft(""); }
  const toggleEditStore=sid=>setEditStores(es=>es.includes(sid)?es.filter(x=>x!==sid):[...es,sid]);
  function addTag(){ const t=tagDraft.trim(); if(!t) return; if(!editTags.some(x=>x.toLowerCase()===t.toLowerCase())) setEditTags(ts=>[...ts,t]); setTagDraft(""); }
  const removeTag=t=>setEditTags(ts=>ts.filter(x=>x!==t));
  // Rename goes through resolveName like every other name write — a hand-typed
  // "Diapers" here must land on the same canonical doc as a parsed one.
  async function saveItem(){
    const oldKey=ckey(itemModal.key||itemModal.name);
    const typed=(editName||"").trim();
    const { name:newName, key:newKey } = typed ? resolveName(typed) : {name:itemModal.name,key:oldKey};
    if(!newName){ flash("Name can't be empty"); return; }
    // renaming onto something already on the list: fold the rows instead of
    // creating the duplicate this whole feature exists to prevent
    const collide=newKey!==oldKey ? list.find(i=>i.id!==itemModal.id && ckey(i.key||i.name)===newKey) : null;
    await run("saveitem", async ()=>{
      const b=writeBatch(db);
      b.set(dictRef(newName),{name:newName,category:editCat,stores:editStores},{merge:true});
      if(collide){
        b.set(doc(db,"shoppinglist_list",collide.id),{
          key:newName,name:newName,category:editCat,stores:editStores,
          tags:[...new Set([...(collide.tags||[]),...editTags])]
        },{merge:true});
        b.delete(doc(db,"shoppinglist_list",itemModal.id));
      } else {
        b.set(doc(db,"shoppinglist_list",itemModal.id),{key:newName,name:newName,category:editCat,stores:editStores,tags:editTags},{merge:true});
      }
      await b.commit();
    });
    if(collide) flash("Merged into “"+newName+"”");
    else if(newKey!==oldKey) flash("Renamed to “"+newName+"”");
    setItemModal(null);
  }
  async function removeCurrentItem(){ await run("removeitem", ()=>deleteDoc(doc(db,"shoppinglist_list",itemModal.id))); setItemModal(null); }
  const removeRow=it=>run("rm_"+it.id, ()=>deleteDoc(doc(db,"shoppinglist_list",it.id)));

  async function addInShop(){
    if(!checkedIn) return;
    const { name:t, key:k } = resolveName(shopAdd); if(!t) return;
    const known=lookup(t);
    // already on the list under any name variant: union this store in rather than
    // creating a second row
    const row=list.find(i=>ckey(i.key||i.name)===k);
    if(row){
      const st=[...new Set([...storesOf(row),checkedIn])];
      setShopAdd("");
      if(storesOf(row).includes(checkedIn)){ flash(t+" is already on this list"); return; }
      await run("shopadd", async ()=>{
        const b=writeBatch(db);
        b.set(doc(db,"shoppinglist_list",row.id),{stores:st},{merge:true});
        b.set(dictRef(row.name||t),{name:row.name||t,stores:st,category:row.category||"Unsorted"},{merge:true});
        await b.commit();
      });
      flash(t+" now also at "+sname(checkedIn));
      return;
    }
    let category=(known&&known.category)||"Unsorted";
    const itemStores=[...new Set([...((known&&known.stores)||[]),checkedIn])];
    if(!known){
      // routeUnknowns expects the STORE OBJECTS from state, not a list of ids.
      // Passing ids here used to blank out the worker prompt silently.
      try{ const learned=await routeUnknowns([t],stores); const m=Object.values(learned)[0]; if(m&&m.category) category=m.category; }catch{}
    }
    await run("shopadd", async ()=>{
      const b=writeBatch(db);
      b.set(dictRef(t),{name:t,stores:itemStores,category},{merge:true});
      b.set(doc(collection(db,"shoppinglist_list")),{key:t,name:t,stores:[...itemStores],category,checked:false,addedBy:(user.email||"").split("@")[0],ts:serverTimestamp()});
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
      // write by the doc's REAL id — ids are canonical now, so slug(name) is no
      // longer a safe way to address an existing dictionary doc
      for(const d of dictDocs){ const tc=titleCase(d.name||""); if(tc && tc!==d.name) ops.push({t:"set",ref:doc(db,"shoppinglist_dictionary",d.id),data:{name:tc}}); }
      for(const p of purch){ const tc=titleCase(p.name||""); if(tc!==p.name) ops.push({t:"set",ref:doc(db,"shoppinglist_purchased",p.id),data:{name:tc}}); }
      for(const s of staples){ const tc=titleCase(s.name||""); if(tc!==s.name) ops.push({t:"set",ref:doc(db,"shoppinglist_staples",s.id),data:{name:tc}}); }
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
    if(_checkoutLock) return;                 // guard against any double-fire
    _checkoutLock=true;
    try{
      const store=checkedIn;
      const done=list.filter(i=>storesOf(i).includes(store)&&i.checked);
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
    } finally { _checkoutLock=false; }
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
  function orphansOf(sid){ return list.filter(i=>storesOf(i).includes(sid) && storesOf(i).filter(x=>x!==sid).length===0); }
  function deleteStore(s){
    if(orphansOf(s.id).length){ setDelStore(s); setReassign({}); return; }
    if(!confirm(`Delete ${s.name}?`)) return;
    commitDelete(s,{});
  }
  async function commitDelete(s, assign){
    await run("delstore_"+s.id, async ()=>{
      const b=writeBatch(db);
      b.set(cfgDoc(),{stores:storeDraft.filter(x=>x.id!==s.id).map(serStore)},{merge:true});
      list.filter(i=>storesOf(i).includes(s.id)).forEach(i=>{
        let ns=storesOf(i).filter(x=>x!==s.id);
        if(ns.length===0 && assign[i.id]) ns=[assign[i.id]];
        b.set(doc(db,"shoppinglist_list",i.id),{stores:ns},{merge:true});
        b.set(dictRef(i.key||i.name),{name:i.name||i.key,stores:ns,category:i.category||"Unsorted"},{merge:true});
      });
      const onListKeys=new Set(list.map(i=>ckey(i.key||i.name)));
      dictDocs.forEach(d=>{ if((d.stores||[]).includes(s.id) && !onListKeys.has(ckey(d.name))) b.set(doc(db,"shoppinglist_dictionary",d.id),{stores:(d.stores||[]).filter(x=>x!==s.id)},{merge:true}); });
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
      affected.forEach(i=>{ b.set(doc(db,"shoppinglist_list",i.id),{category:"Unsorted"},{merge:true}); b.set(dictRef(i.key||i.name),{name:i.name||i.key,category:"Unsorted"},{merge:true}); });
      await b.commit();
    });
    setCatDraft(d=>d.filter(x=>x!==c));
  }

  // ---- staples ----
  const isStaple=name=>{ const k=ckey(name); return staples.some(s=>ckey(s.name)===k); };
  function toggleStaple(name,seedStores,seedCat){
    const { name:nm, key:k } = resolveName(name);
    return run("star_"+k, async ()=>{
      // delete by the doc's REAL id — legacy staples still carry old slug ids
      const found=staples.find(s=>ckey(s.name)===k);
      if(found){ await deleteDoc(doc(db,"shoppinglist_staples",found.id)); return; }
      // seed the shared dictionary only if it has no entry yet — one source of truth
      if(!lookup(nm) && seedStores && seedStores.length){
        await setDoc(dictRef(nm),{name:nm,stores:seedStores,category:seedCat||"Unsorted"},{merge:true});
      }
      await setDoc(stapleRef(nm),{name:nm});
    });
  }
  async function addNewStaple(){
    const { name:nm } = resolveName(newStaple); if(!nm) return;
    await run("addstaple", async ()=>{
      if(!lookup(nm)) await setDoc(dictRef(nm),{name:nm,stores:[],category:"Unsorted"},{merge:true});
      await setDoc(stapleRef(nm),{name:nm});
    });
    setNewStaple("");
  }
  async function addStaplesToList(){
    const existing=new Set(list.map(i=>ckey(i.key||i.name)));
    const picked=staples.filter(s=>stapleSel[s.id] && !existing.has(ckey(s.name)));
    if(!picked.length){ setStaplesModal(false); setStapleSel({}); return; }
    const toAdd=[], needAssign=[];
    for(const s of picked){
      const { name:nm } = resolveName(s.name);
      const meta=lookup(nm)||{};
      const st=(meta.stores&&meta.stores.length)?meta.stores:(s.stores||[]);
      const category=meta.category||s.category||"Unsorted";
      // no store known -> assign modal, same as any other new item. Previously
      // these landed silently with zero stores.
      if(st.length) toAdd.push({name:meta.name||nm,stores:st,category});
      else needAssign.push({name:nm,stores:[],category,fuzzy:null});
    }
    if(toAdd.length){ await writeAdds("addstaples", toAdd); flash(toAdd.length+" added to list"); }
    setStaplesModal(false); setStapleSel({});
    if(needAssign.length) setAssignList(needAssign);
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
  const shopOrder=useMemo(()=>{
    const cnt=Object.fromEntries(stores.map(s=>[s.id, list.filter(i=>storesOf(i).includes(s.id)&&!i.checked).length]));
    const idx=Object.fromEntries(stores.map((s,i)=>[s.id,i]));
    return stores.slice().sort((a,b)=>{
      const ca=cnt[a.id], cb=cnt[b.id];
      if((ca>0)!==(cb>0)) return cb>0?1:-1;
      if(cb!==ca) return cb-ca;
      return idx[a.id]-idx[b.id];
    }).map(s=>({...s,_n:cnt[s.id]}));
  },[stores,list,byCanon]);
  const recentProduce=useMemo(()=>{
    const cut=Date.now()-30*864e5, seen=new Set(), out=[];
    purch.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")).forEach(p=>{
      if(((lookup(p.name)||{}).category)!=="Produce") return;
      const d=Date.parse(p.date); if(isNaN(d)||d<cut) return;
      const k=(p.name||"").toLowerCase(); if(!k||seen.has(k)) return; seen.add(k); out.push(p.name);
    });
    return out;
  },[purch,byCanon]);
  const listGroups=useMemo(()=>{
    const l=list.filter(i=>{
      const st=storesOf(i);
      const sp=st.length===0 || st.some(s=>!exclStores.has(s));
      const tp=(i.tags||[]).length===0 || (i.tags||[]).some(t=>!exclTags.has(t));
      return sp && tp;
    });
    return groupByCat(l,"list");
  },[list,collapsed,cats,exclTags,exclStores,byCanon]);
  const shopItems=useMemo(()=>list.filter(i=>storesOf(i).includes(checkedIn)),[list,checkedIn,byCanon]);
  const shopGroups=useMemo(()=>groupByCat(shopItems,"shop:"+checkedIn),[shopItems,collapsed,checkedIn,cats]);
  const shopChecked=shopItems.filter(i=>i.checked).length;

  const pCatOf=name=>((lookup(name)||{}).category)||"Unsorted";
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
  },[purch,pendingOnly,pFilterStore,pFilterCat,pFilterRange,sortBy,sortDir,stores,byCanon]);
  const HIST_PER=20;
  const histPages=Math.max(1,Math.ceil(filteredPurch.length/HIST_PER));
  const histSlice=useMemo(()=>filteredPurch.slice((histPage-1)*HIST_PER,histPage*HIST_PER),[filteredPurch,histPage]);
  useEffect(()=>{ setHistPage(1); },[pendingOnly,pFilterStore,pFilterCat,pFilterRange,sortBy,sortDir]);
  useEffect(()=>{
    if(migDone!==false||loading||_migRan) return;
    _migRan=true; cleanupNames(true);
  },[migDone,loading,list,dictDocs,purch,staples]);
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

  function dishCard(d, okey){
    const open=!!rOpen[okey];
    const onToggle=()=>setROpen(o=>({...o,[okey]:!o[okey]}));
    const saved=isSavedRecipe(d.name);
    const need=d.need||[];
    const used=d.ingredientsUsed||[];
    const source=recipeAddSource(d);
    const have=used.filter(u=>!need.some(n=>(n||"").toLowerCase()===(u||"").toLowerCase()));
    const adding=addRecipe && addRecipe.name===d.name;
    return html`
      <div class="panel">
        <div class="phead rdhead">
          <button class="pheadmain" onClick=${onToggle}>
            <span class="ptitle">${d.name}</span>
            <span class="pright">${d.minutes?html`<span class="pcount">${d.minutes} min</span>`:null}<span class=${"pcaret"+(open?" up":"")}>\u25be</span></span>
          </button>
          <button class=${"recstar"+(saved?" on":"")} onClick=${()=>toggleSaveRecipe(d)} aria-label=${saved?"Unsave recipe":"Save recipe"}>${isBusy("saverec_"+slug(d.name))?html`<${Spin} g=${true}/>`:(saved?"\u2605":"\u2606")}</button>
        </div>
        ${open?html`<div class="pbody rbody">
          ${used.length?html`<div class="haveline">On hand: ${have.length} of ${used.length}${have.length?" \u00b7 "+have.join(", "):""}</div>`:null}
          ${need.length?html`<div class="needline">To buy: ${need.join(", ")}</div>`:html`<div class="haveline">You have everything for this</div>`}
          ${(d.steps&&d.steps.length)?html`<div class="rsec"><h5>Steps</h5><ol>${d.steps.map(s=>html`<li>${s}</li>`)}</ol></div>`:null}
          ${d.notes?html`<div class="rsec"><h5>Notes</h5><p>${d.notes}</p></div>`:null}
          ${d.oneExtra?html`<div class="rsec rextra"><h5>With one more item</h5><p>${d.oneExtra}</p></div>`:null}
          ${source.length?(adding
            ? html`<div class="addneed">
                <div class="hint">Tick what you need to buy \u2014 edit a name if it looks off. Ticked items go on your list.</div>
                ${source.map(n=>{ const row=needSel[n]||{on:false,name:n}; return html`<div class="needrow">
                  <button class=${"box sm"+(row.on?" on":"")} onClick=${()=>setNeedSel(s=>({...s,[n]:{...(s[n]||{name:n}),on:!(s[n]&&s[n].on)}}))}>${row.on?check:null}</button>
                  <div class="neededit">
                    <input class="needinput" value=${row.name} onInput=${e=>{const v=e.target.value; setNeedSel(s=>({...s,[n]:{...(s[n]||{on:true}),name:v}}));}} />
                    ${n!==row.name?html`<span class="needraw">from \u201c${n}\u201d</span>`:null}
                  </div>
                </div>`})}
                <div class="addneedbtns">
                  <button class="ghost" onClick=${()=>setAddRecipe(null)}>Cancel</button>
                  <button class="primary sm" disabled=${isBusy("addrecipe")||!Object.values(needSel).some(v=>v&&v.on&&(v.name||"").trim())} onClick=${addRecipeNeeds}>${isBusy("addrecipe")?html`<${Spin}/>Adding\u2026`:"Add ticked to list"}</button>
                </div>
              </div>`
            : html`<button class="primary sm addneedbtn" onClick=${()=>openAddRecipe(d)}>Add ingredients to list</button>`
          ):null}
        </div>`:null}
      </div>`;
  }

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
            ${g.items.map(it=>{ const st=storesOf(it); return html`
              <div class="lrow" onPointerDown=${e=>itemPointerDown(it,e)} onPointerMove=${itemPointerMove} onPointerUp=${itemPointerUp}>
                ${reorder?html`<button class="grip itemgrip" onPointerDown=${e=>startDrag("item",{item:it,cat:it.category||"Unsorted",label:it.name},e)} onClick=${e=>e.stopPropagation()} aria-label="Drag to recategorize">\u2261</button>`:null}
                <button class=${"rowstar lead-star"+(isStaple(it.name)?" on":"")} onClick=${()=>toggleStaple(it.name,st,it.category)}>${isBusy("star_"+ckey(it.name))?html`<${Spin} g=${true}/>`:(isStaple(it.name)?"\u2605":"\u2606")}</button>
                <div class="lmain" onClick=${()=>openItemGuarded(it)}>
                  <span class="lmid">
                    <span class="lname">${it.name}</span>
                    <span class="lmeta">
                      <span class="catchip" onClick=${e=>{e.stopPropagation();setCatPick(it);}}>${it.category||"Unsorted"}</span>
                      ${(it.tags||[]).map(t=>html`<span class="ltag">${t}</span>`)}
                    </span>
                  </span>
                  <span class="lstores">${st.length
                    ? st.map(s=>lsq(scolor(s),sname(s)))
                    : html`<em class="uns">unsorted</em>`}</span>
                </div>
                <button class="rowx" onClick=${()=>removeRow(it)}>${isBusy("rm_"+it.id)?html`<${Spin} g=${true}/>`:"\u00d7"}</button>
              </div>`})}
          <//>`)}`:null}

    ${page==="shop"?( !checkedIn ? html`
      <div class="pickhead">Which store are you at?</div>
      <div class="picker">
        ${shopOrder.map(s=>{const n=s._n;
          return html`<button class=${"storecard"+(n===0?" empty":"")} style=${"--sc:"+s.color} onClick=${()=>setCheckedIn(s.id)}>
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
      ${typeahead(shopAdd,{store:checkedIn,onPick:e=>{ addFromSuggestion(e,checkedIn); setShopAdd(""); }})}
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
                  ${(()=>{const st=storesOf(it); return st.length>1?html`<div class="also">${st.filter(x=>x!==checkedIn).map(x=>lsq(scolor(x),sname(x)))}</div>`:null;})()}
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
              <button class=${"rowstar lead-star"+(isStaple(p.name)?" on":"")} onClick=${()=>toggleStaple(p.name,((lookup(p.name)||{}).stores||[]).length?lookup(p.name).stores:[p.store],(lookup(p.name)||{}).category||"Unsorted")}>${isStaple(p.name)?"\u2605":"\u2606"}</button>
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
        <div class="sheethead"><div class="lead">Add Items</div><button class="sheetx" onClick=${()=>setShowAdd(false)} aria-label="Close">\u00d7</button></div>
        <div class="hint">Start typing for something you buy often \u2014 tap it and it goes straight on, already routed.</div>
        <input class="tin" placeholder="Search your items\u2026" value=${quickAdd} onInput=${e=>setQuickAdd(e.target.value)}
          onKeyDown=${e=>{if(e.key==="Enter"){e.preventDefault(); const s=suggest(quickAdd,1)[0]; if(s&&!onList(s.name)){ addFromSuggestion(s); setQuickAdd(""); }}}} />
        ${typeahead(quickAdd,{onPick:e=>{ addFromSuggestion(e); setQuickAdd(""); }})}
        <div class="hint">Or paste a voice list \u2014 Alexa, WhatsApp, Notes. One line or comma-separated; Basketly splits it and files each item to the right store.</div>
        <textarea placeholder=${"2 lbs onions\ncilantro\npaneer\nmilk\ntoor dal"} value=${draft} onInput=${e=>setDraft(e.target.value)}></textarea>
        <button class="primary" disabled=${parsing||!draft.trim()} onClick=${addItems}>${parsing?html`<${Spin}/>Routing\u2026`:"Add to list"}</button>
      </div>`:null}
    ${review.length>0?html`
      <div class="scrim" onClick=${()=>setReview([])}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">New Items \u2014 Fix Any Store</div><button class="sheetx" onClick=${()=>setReview([])} aria-label="Close">\u00d7</button></div>
        ${review.map(k=>{const meta=lookup(k)||{stores:[],category:"Unsorted"};return html`
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
        <div class="hint">Name</div>
        <input class="tin" value=${editName} onInput=${e=>setEditName(e.target.value)} placeholder="Item name" />
        ${(()=>{const t=(editName||"").trim(); if(!t) return null;
          const nk=ckey(t), ok=ckey(itemModal.key||itemModal.name);
          if(nk===ok) return null;
          const hit=byCanon.get(nk);
          return html`<div class="hint">${hit?"Will merge into the existing \u201c"+hit.name+"\u201d.":"New item \u2014 \u201c"+resolveName(t).name+"\u201d."}</div>`;})()}
        <div class="hint">Category</div>
        <select class="sel" value=${editCat} onChange=${e=>{ if(e.target.value==="__newcat__"){ openAddCat(n=>setEditCat(n)); } else setEditCat(e.target.value); }}>
          ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
          <option value="__newcat__">+ New category\u2026</option>
        </select>
        <div class="hint">Stores</div>
        <div class="chiprow">${stores.map(s=>html`<button class=${"chip mini"+(editStores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleEditStore(s.id)}>
          ${lsq(s.color,s.name)}${s.name}</button>`)}
          <button class="chip mini addchip" onClick=${()=>openAddStore(id=>toggleEditStore(id))}>+ New store</button></div>
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
        ${!dedupeMigrated?html`<button class="ddm" onClick=${()=>{setMenu(false);setDupPage(1);setDupOpen(true);}}>Merge Duplicates${dupGroups.length?" ("+dupGroups.length+")":""}</button>`:null}
        <div class="ddsep"></div>
        <button class="ddm ddout" onClick=${()=>signOut(auth)}>Sign out</button>
        <div class=${"ddver"+(swVer&&swVer!==BUILD?" stale":"")}>Version ${BUILD}${swVer&&swVer!==BUILD?html` \u00b7 cache ${swVer} \u2014 reload`:""}</div>
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
        ${typeahead(newStaple,{isOn:e=>isStaple(e.name),onLabel:"a staple",onPick:e=>{ toggleStaple(e.name,e.stores,e.category); setNewStaple(""); }})}
        ${staples.length===0?html`<div class="hint">Nothing here yet \u2014 star items on the List or in Purchase History to keep them here.</div>`:null}
        ${staples.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(s=>{
          const rowOnList=onList(s.name);
          const meta=lookup(s.name)||{stores:[],category:"Unsorted"};
          return html`<div class=${"strow"+(rowOnList?" off":"")} onClick=${()=>{ if(!rowOnList) setStapleSel(v=>({...v,[s.id]:!v[s.id]})); }}>
            <div class=${"box sm"+((stapleSel[s.id]&&!rowOnList)?" on":"")}>${(stapleSel[s.id]&&!rowOnList)?check:null}</div>
            <span class="sname2">${s.name}</span>
            <span class="lstores">${(meta.stores||[]).map(x=>lsq(scolor(x),sname(x)))}</span>
            ${rowOnList?html`<span class="tag">on list</span>`:null}
            <button class="rowx" onClick=${e=>{e.stopPropagation();toggleStaple(s.name,s.stores,s.category);}}>${isBusy("star_"+ckey(s.name))?html`<${Spin} g=${true}/>`:"\u00d7"}</button>
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
            ${it.fuzzy?html`
              <div class="tafuzzy inrow">
                <span class="tafzq">Did you mean <b>${it.fuzzy.name}</b>?</span>
                <span class="tafza">
                  <button class="linkbtn" onClick=${()=>acceptFuzzyInAssign(idx,it.fuzzy)}>Use it</button>
                  <button class="ghost mut" onClick=${()=>{ rejectFuzzy(it.fuzzy.key,it.name); updateAssign(idx,{fuzzy:null}); }}>Not the same</button>
                </span>
              </div>`:null}
            <select class="sel sm" value=${it.category} onChange=${e=>{ if(e.target.value==="__newcat__"){ openAddCat(n=>updateAssign(idx,{category:n})); } else updateAssign(idx,{category:e.target.value}); }}>
              ${cats.map(c=>html`<option value=${c}>${c}</option>`)}
              <option value="__newcat__">+ New category\u2026</option>
            </select>
            <div class="chiprow">
              ${stores.map(s=>html`<button class=${"chip mini"+(it.stores.includes(s.id)?" pick":"")} style=${"--sc:"+s.color} onClick=${()=>toggleAssignStore(idx,s.id)}>
                ${lsq(s.color,s.name)}${s.name}</button>`)}
              <button class="chip mini addchip" onClick=${()=>openAddStore(id=>toggleAssignStore(idx,id))}>+ New store</button>
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
        <button class="linkbtn" style="margin-top:12px" onClick=${()=>{const it=catPick; setCatPick(null); openAddCat(n=>recategorize(it,n));}}>+ New category</button>
      </div>`:null}

    <!-- quick create: category -->
    ${catAdd?html`
      <div class="scrim" onClick=${()=>setCatAdd(null)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">New category</div><button class="sheetx" onClick=${()=>setCatAdd(null)} aria-label="Close">\u00d7</button></div>
        <input class="tin" placeholder="Category name" value=${catAdd.name} onInput=${e=>setCatAdd(a=>({...a,name:e.target.value}))} onKeyDown=${e=>{if(e.key==="Enter"){e.preventDefault();commitAddCat();}}} />
        <button class="primary" disabled=${!catAdd.name.trim()||isBusy("quickcat")} onClick=${commitAddCat}>${isBusy("quickcat")?html`<${Spin}/>Adding\u2026`:"Add & select"}</button>
      </div>`:null}

    <!-- quick create: store (name + color) -->
    ${storeAdd?html`
      <div class="scrim" onClick=${()=>setStoreAdd(null)}></div>
      <div class="sheet">
        <div class="sheethead"><div class="lead">New store</div><button class="sheetx" onClick=${()=>setStoreAdd(null)} aria-label="Close">\u00d7</button></div>
        <input class="tin" placeholder="Store name" value=${storeAdd.name} onInput=${e=>setStoreAdd(a=>({...a,name:e.target.value}))} />
        <div class="hint">Color</div>
        <div class="pickrow">
          <div class="swatches">${STORE_SWATCHES.map(c=>html`<button class=${"sw"+(storeAdd.color===c?" on":"")} style=${"background:"+c} onClick=${()=>setStoreAdd(a=>({...a,color:c}))}></button>`)}</div>
          <input class="colorin" type="color" value=${storeAdd.color} onInput=${e=>setStoreAdd(a=>({...a,color:e.target.value}))} />
        </div>
        <button class="primary" disabled=${!storeAdd.name.trim()||isBusy("quickstore")} onClick=${commitAddStore}>${isBusy("quickstore")?html`<${Spin}/>Adding\u2026`:"Add & select"}</button>
      </div>`:null}

    <!-- recipe ideas -->
    ${recipeOpen?html`
      <div class="recipepage">
        <div class="rphead">
          <div class="rptitle">Recipe Ideas</div>
          <button class="sheetx" onClick=${()=>setRecipeOpen(false)} aria-label="Close">\u00d7</button>
        </div>
        <div class="rpbody">
          <div class="rtabs">
            <button class=${recipeTab==="new"?"on":""} onClick=${()=>setRecipeTab("new")}>Get ideas</button>
            <button class=${recipeTab==="saved"?"on":""} onClick=${()=>setRecipeTab("saved")}>Saved${savedRecipes.length?" ("+savedRecipes.length+")":""}</button>
          </div>
          ${recipeTab==="new"?html`
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
                ${rResults.map((d,i)=>dishCard(d,i))}
              </div>`):null}
          `:html`
          ${savedRecipes.length===0
            ? html`<div class="empty"><div class="big">No saved recipes</div>Tap the \u2606 on any idea to keep it here.</div>`
            : html`<div class="rlist">
                ${savedRecipes.slice().sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(r=>dishCard(r,"s:"+r.id))}
              </div>`}
          `}
        </div>
      </div>`:null}

    <!-- merge duplicates (one-shot legacy cleanup) -->
    ${dupOpen?html`
      <div class="recipepage">
        <div class="rphead">
          <div class="rptitle">Merge Duplicates</div>
          <button class="sheetx" onClick=${()=>setDupOpen(false)} aria-label="Close">\u00d7</button>
        </div>
        <div class="rpbody">
          ${dupGroups.length===0
            ? html`<div class="empty"><div class="big">No duplicates found.</div>Your dictionary is already one entry per item.</div>
                   <button class="primary" onClick=${finishDedupe} disabled=${isBusy("dedupedone")}>${isBusy("dedupedone")?html`<${Spin}/>Saving\u2026`:"Done \u2014 hide this"}</button>`
            : html`
              <div class="hint">These entries collapse to the same item. Pick the name to keep \u2014 stores are merged, and purchase history is left exactly as it happened.</div>
              <div class="listcount">${dupGroups.length} group${dupGroups.length===1?"":"s"}${dupPages>1?html` \u00b7 <span class="lcmuted">page ${dupPage} of ${dupPages}</span>`:null}</div>
              ${dupSlice.map(g=>{
                const w=dupWinner(g);
                const note=dupCatNote(g);
                return html`
                <div class="arow">
                  <div class="aname">${g.key.replace(/_/g," ")}</div>
                  <div class="dupgrid">
                    ${g.members.map(m=>html`
                      <button class=${"catopt dupname"+(m.id===w.id?" on":"")} onClick=${()=>setDupWin(v=>({...v,[g.key]:m.id}))}>
                        <span class="dupn">${m.name}</span>
                        <span class="dupmeta">
                          <span class="catchip">${m.category||"Unsorted"}</span>
                          <span class="lstores">${(m.stores||[]).map(x=>lsq(scolor(x),sname(x)))}</span>
                        </span>
                      </button>`)}
                  </div>
                  ${note?html`<div class="dupcat">Category: ${note}</div>`:null}
                  <button class="primary sm" disabled=${isBusy("merge_"+g.key)} onClick=${()=>mergeGroup(g)}>${isBusy("merge_"+g.key)?html`<${Spin}/>Merging\u2026`:"Keep this name & merge"}</button>
                </div>`;})}
              ${dupPages>1?html`
                <div class="pager">
                  <button class="ghost" disabled=${dupPage<=1} onClick=${()=>setDupPage(p=>Math.max(1,p-1))}>\u2190 Prev</button>
                  <span class="pnum">${dupPage} / ${dupPages}</span>
                  <button class="ghost" disabled=${dupPage>=dupPages} onClick=${()=>setDupPage(p=>Math.min(dupPages,p+1))}>Next \u2192</button>
                </div>`:null}
              <button class="primary" onClick=${mergeVisible}>Merge all ${dupSlice.length} on this page</button>
              <button class="ghost" onClick=${finishDedupe}>Skip the rest \u2014 hide this menu item</button>`}
        </div>
      </div>`:null}

    <!-- image viewer -->
    ${viewImg?html`
      <div class="scrim dark" onClick=${()=>setViewImg(null)}></div>
      <div class="imgview" onClick=${()=>setViewImg(null)}><img src=${viewImg} alt="attachment" /></div>`:null}

    ${(page==="shop" && checkedIn)?html`
      <div class="submitbar"><div class="inner"><${SlideConfirm} busy=${isBusy("checkout")} label=${shopChecked>0?"Slide to check out \u00b7 "+shopChecked+" bought":"Slide to check out"} onConfirm=${checkOut} /></div></div>`:null}
    ${toast?html`<div class="toast">${toast}</div>`:null}
    <div class=${"vstamp"+(swVer&&swVer!==BUILD?" stale":"")}>${BUILD}</div>
  `;
}
render(html`<${App}/>`, document.getElementById("app"));
if("serviceWorker" in navigator) addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
