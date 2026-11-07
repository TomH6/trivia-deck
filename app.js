// Trivia Deck — trivia with Uno-style action cards.
// Host-authoritative: the room creator's browser runs the game and writes rooms/{code}/state;
// everyone else sends moves to rooms/{code}/inputs. Clocks are synced with Firebase's server offset.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, set, get, push, remove, onValue, onChildAdded, onDisconnect } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./config.js?v=8";
import { BEATLES } from "./packs/beatles.js?v=8";
import { TOLKIEN } from "./packs/tolkien.js?v=8";
import { HE_MUSIC, HE_TV, HE_GEO, HE_GENERAL } from "./packs/hebrew.js?v=8";
import { HE } from "./i18n.js?v=8";

// ---------------- Cards ----------------
const CARDS={
 plain:{name:"Answer",ic:"❓",c:"var(--grey)",d:"Answer one question.",n:9},
 easy:{name:"Easy Street",ic:"🌴",c:"var(--green)",d:"You get an easy question.",n:2},
 fifty:{name:"50/50",ic:"✂️",c:"var(--green)",d:"Two wrong answers are removed.",n:2},
 cat:{name:"Category Pick",ic:"🎯",c:"var(--green)",d:"You choose the category.",n:3},
 shield:{name:"Shield",ic:"🛡️",c:"var(--green)",d:"Gain a shield that blocks one lost life. Then answer.",n:2},
 safe:{name:"Safe Round",ic:"🕊️",c:"var(--green)",d:"Nobody loses lives for one full round. Then answer.",n:1},
 double:{name:"Double Trouble",ic:"✌️",c:"var(--yellow)",d:"Answer 2 questions. Miss either and lose a life.",n:4},
 hard:{name:"Hard Mode",ic:"🔥",c:"var(--yellow)",d:"A hard question. Right = win back a lost life.",n:3},
 speed:{name:"Speed Round",ic:"⚡",c:"var(--yellow)",d:"Only 7 seconds to answer.",n:3},
 allin:{name:"All In",ic:"🎰",c:"var(--yellow)",d:"3 questions. All right = win back a life. Any wrong = lose 2.",n:1},
 bomb:{name:"Pass the Bomb",ic:"💣",c:"var(--red)",d:"Pick who has to answer your question.",n:3},
 curse:{name:"Curse",ic:"🧿",c:"var(--red)",d:"The next player gets a harder question. Then you answer.",n:2},
 sudden:{name:"Sudden Death",ic:"💀",c:"var(--red)",d:"Everyone answers. Wrong = lose a life.",n:1},
 skip:{name:"Skip",ic:"⏭️",c:"var(--blue)",d:"Your turn is skipped.",n:2},
 reverse:{name:"Reverse",ic:"🔄",c:"var(--blue)",d:"Play changes direction. No question for you.",n:3},
 jump:{name:"Jump",ic:"🦘",c:"var(--blue)",d:"Answer, then the next player is skipped.",n:2},
 buzzer:{name:"Buzzer Round",ic:"🔔",c:"var(--purple)",d:"Everyone answers. Fastest right answer wins back a life.",n:2},
 underdog:{name:"Underdog",ic:"🐶",c:"var(--purple)",d:"If you have the fewest lives, win one back. Then answer an easy question.",n:2},
 joker:{name:"Joker",ic:"🃏",c:"var(--purple)",d:"Choose any card you like.",n:1},
};
const EMOJI=["😂","😱","🔥","👏","😈","💀"];
const LETTERS="ABCD";
const GRACE=1500;          // ms the host waits past a deadline for answers still in flight
const MAX_PLAYERS=10;

// ---------------- helpers ----------------
const rand=a=>a[Math.floor(Math.random()*a.length)];
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const sample=(a,n)=>shuffle(a.slice()).slice(0,n);
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ls={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}},del(k){try{localStorage.removeItem(k)}catch(e){}}};
const DIFF_MIX={chill:[.65,.30],normal:[.45,.45],brainy:[.20,.50]}; // [easy, medium] — rest is hard
const rd=()=>{const m=DIFF_MIX[(typeof s!=="undefined"&&s&&s.settings&&s.settings.diff)||"normal"]||DIFF_MIX.normal;const r=Math.random();return r<m[0]?"easy":r<m[0]+m[1]?"medium":"hard";};
const arr=v=>Array.isArray(v)?v:(v&&typeof v==="object"?Object.values(v):[]);
// ---------------- language ----------------
let devLang=ls.get("td_lang")==="he"?"he":"en";
const lang=()=>(typeof s!=="undefined"&&s&&s.settings&&s.settings.lang)||devLang;
const L=(en,...a)=>{let t=(lang()==="he"&&HE[en])||en;a.forEach((v,i)=>{t=t.split("{"+i+"}").join(v);});return t;};
const letters=()=>lang()==="he"?"אבגד":"ABCD";

// ---------------- questions ----------------
const packQ=(label,list)=>list.map(q=>({cat:label+": "+q[0],diff:q[1],text:q[2],a:q[3],w:[q[4],q[5],q[6]]}));
// custom packs: id -> {name shown in the lobby, questions}
const PACKS={
  beatles:{name:"🎸 Beatles pack",lang:"en",qs:packQ("Beatles",BEATLES)},
  tolkien:{name:"💍 Tolkien pack",lang:"en",qs:packQ("Tolkien",TOLKIEN)},
  he_music:{name:"🎤 מוזיקה ישראלית",lang:"he",qs:packQ("מוזיקה ישראלית",HE_MUSIC)},
  he_tv:{name:"📺 טלוויזיה וקולנוע",lang:"he",qs:packQ("טלוויזיה וקולנוע",HE_TV)},
  he_geo:{name:"🗺️ ארץ ישראל",lang:"he",qs:packQ("ארץ ישראל",HE_GEO)},
  he_general:{name:"🧠 ידע כללי",lang:"he",qs:packQ("ידע כללי",HE_GENERAL)},
};
const packIds=()=>Object.keys(PACKS).filter(k=>PACKS[k].lang===lang());
const ALL_PACK_Q_FOR=()=>packIds().flatMap(k=>PACKS[k].qs.map(q=>({...q,src:k})));
// what "Everything" means: the whole Open Trivia DB in English, all Hebrew packs in Hebrew
const defaultSources=()=>lang()==="he"?packIds():["any"];
const OT={token:null,lastCall:0,cats:null};
const POOL={qs:[],sources:[],next:0,busy:false,failed:false,seen:new Set()};
const cleanCat=n=>n.replace(/^(Entertainment|Science): /,"");
const dec=t=>{try{return decodeURIComponent(t);}catch(e){return t;}};

async function loadCats(){
  if(OT.cats)return OT.cats;
  try{const j=await (await fetch("https://opentdb.com/api_category.php")).json();
    OT.cats=j.trivia_categories.map(c=>({id:String(c.id),name:cleanCat(c.name)})).sort((a,b)=>a.name.localeCompare(b.name));}
  catch(e){OT.cats=[];}
  return OT.cats;
}
async function otCall(url){
  const wait=OT.lastCall+5300-Date.now();if(wait>0)await sleep(wait);
  OT.lastCall=Date.now();
  return (await fetch(url)).json();
}
async function fetchBatch(catId){
  if(!OT.token){try{const j=await (await fetch("https://opentdb.com/api_token.php?command=request")).json();OT.token=j.token||null;}catch(e){}}
  const base=n=>"https://opentdb.com/api.php?amount="+n+"&type=multiple&encode=url3986"+(catId?"&category="+catId:"")+(OT.token?"&token="+OT.token:"");
  let j=await otCall(base(50));
  if(j.response_code===1)j=await otCall(base(15));
  if(j.response_code===4&&OT.token){try{await fetch("https://opentdb.com/api_token.php?command=reset&token="+OT.token);}catch(e){}j=await otCall(base(30));}
  if(j.response_code===3){OT.token=null;}
  if(j.response_code!==0)return [];
  return j.results.map(r=>({cat:cleanCat(dec(r.category)),diff:r.difficulty,text:dec(r.question),a:dec(r.correct_answer),w:r.incorrect_answers.map(dec)}));
}
function addToPool(list){for(const q of list){if(POOL.seen.has(q.text))continue;POOL.seen.add(q.text);POOL.qs.push(q);}}
// sources: "any" | Open Trivia category id | pack id. Every pooled question remembers its source.
const left=src=>POOL.qs.filter(q=>q.src===src).length;
async function fillPool(src){
  if(POOL.busy||!POOL.sources.length)return;POOL.busy=true;
  try{
    // refill whichever chosen source is running lowest (or the one asked for)
    src=src||POOL.sources.slice().sort((a,b)=>left(a)-left(b))[0];
    if(PACKS[src])addToPool(shuffle(PACKS[src].qs.slice()).map(q=>({...q,src})));
    else{const got=await fetchBatch(src==="any"?null:src);if(!got.length)POOL.failed=true;addToPool(got.map(q=>({...q,src})));}
  }catch(e){POOL.failed=true;}
  POOL.busy=false;
}
async function preparePool(sources){
  POOL.qs=[];POOL.failed=false;POOL.sources=sources.length?sources.slice():defaultSources();
  // load the first two sources before the game starts, the rest in the background (the API allows one call per 5 s)
  for(let i=0;i<Math.min(2,POOL.sources.length);i++)await fillPool(POOL.sources[i]);
  if(!POOL.qs.length){addToPool(shuffle(ALL_PACK_Q_FOR()));toast(L("Couldn't reach the trivia database — using the built-in packs"));}
  (async()=>{for(let i=2;i<POOL.sources.length;i++)await fillPool(POOL.sources[i]);})();
}
function takeQuestion(diff,cat){
  if(!POOL.busy&&POOL.sources.some(x=>left(x)<10))fillPool();
  let c=POOL.qs.map((q,i)=>i);
  if(cat){const f=c.filter(i=>POOL.qs[i].cat===cat);if(f.length)c=f;}
  else{
    // pick one of the chosen sources at random first, so every chosen category gets its share
    const have=POOL.sources.filter(x=>c.some(i=>POOL.qs[i].src===x));
    if(have.length){const pick=rand(have);c=c.filter(i=>POOL.qs[i].src===pick);}
  }
  const d=c.filter(i=>POOL.qs[i].diff===diff);if(d.length)c=d;
  if(!c.length){POOL.seen.clear();const own=POOL.sources.filter(x=>PACKS[x]);
    if(own.length)own.forEach(x=>addToPool(shuffle(PACKS[x].qs.slice()).map(q=>({...q,src:x}))));
    else addToPool(shuffle(ALL_PACK_Q_FOR()));
    c=POOL.qs.map((q,i)=>i);}
  return POOL.qs.splice(rand(c),1)[0];
}
function poolCats(){const m={};for(const q of POOL.qs)m[q.cat]=(m[q.cat]||0)+1;return Object.keys(m).filter(k=>m[k]>=2);}

// ---------------- app state ----------------
let FB=null,uid=null,skew=0;
let view="loading",role="player",code=null,s=null,shown=null,isHost=false;
let unsubState=null,unsubIn=null,tickTimer=null,joinSent=false,presence={};
let localAns=null,lastFlip=null,seenReacts=new Set(),firstReacts=true,qSeenAt=0,qSeenKey=null,catsCache=null,catsLoading=false;

const now=()=>Date.now()+skew;
const pl=id=>s.players.find(p=>p.id===id);
const nm=id=>{const p=s&&s.players.find(p=>p.id===id);return p?p.name:"?";};
const alive=()=>s.players.filter(p=>!p.ghost);
const curId=()=>s.players[s.cur]&&s.players[s.cur].id;
function toast(t){const d=document.createElement("div");d.className="toast";d.textContent=t;document.body.appendChild(d);setTimeout(()=>d.remove(),3000);}

// Firebase drops empty arrays/objects; put the shape back.
function normalize(x){
  if(!x)return x;
  x.players=arr(x.players).map(p=>Object.assign({lives:0,shields:0,ghost:false,gp:0,haunts:0},p));
  for(const k of ["log","reactions","deck","who","queue","ghostWho"])x[k]=arr(x[k]);
  for(const k of ["answers","cursed","ghostAns"])x[k]=x[k]||{};
  x.settings=Object.assign({lives:"auto",timer:20,cats:[],catNames:[],party:false,diff:"normal",lang:"en"},x.settings||{});
  x.settings.cats=arr(x.settings.cats);x.settings.catNames=arr(x.settings.catNames);
  if(x.q)x.q.opts=arr(x.q.opts);
  if(x.options)x.options=arr(x.options);
  if(x.item&&x.item.who)x.item.who=arr(x.item.who);
  return x;
}

// ---------------- boot ----------------
async function boot(){
  if(!firebaseConfig.apiKey||firebaseConfig.apiKey==="PASTE_ME"){view="setup";render();return;}
  const app=initializeApp(firebaseConfig);
  const auth=getAuth(app);const db=getDatabase(app);
  FB={db,ref:p=>ref(db,p)};
  onValue(ref(db,".info/serverTimeOffset"),snap=>{skew=snap.val()||0;});
  onAuthStateChanged(auth,u=>{
    if(!u)return;
    const first=!uid;uid=u.uid;
    if(first){
      view="home";
      const qp=new URLSearchParams(location.search);
      const c=(qp.get("room")||"").toUpperCase();
      const tv=qp.get("tv")==="1";
      render();
      if(/^[A-Z]{4}$/.test(c)){
        const el=document.getElementById("jcode");if(el)el.value=c;
        if(tv)openRoom(c,"screen");
        else if(ls.get("td_code")===c||ls.get("td_name"))openRoom(c,"player");
      }else if(ls.get("td_code"))openRoom(ls.get("td_code"),"player",true);
    }
  });
  try{await signInAnonymously(auth);}
  catch(e){view="error";render();console.error(e);}
}

// ---------------- sync ----------------
function stopRoom(){
  if(unsubState)unsubState();if(unsubIn)unsubIn();if(tickTimer)clearInterval(tickTimer);
  unsubState=unsubIn=tickTimer=null;
}
function openRoom(c,asRole,quiet){
  stopRoom();
  role=asRole;code=c;isHost=false;s=null;shown=null;joinSent=false;presence={};
  if(role==="player")ls.set("td_code",c);
  document.body.classList.toggle("tv",role==="screen");
  try{history.replaceState(null,"","?room="+c+(role==="screen"?"&tv=1":""));}catch(e){}
  view="connecting";render();
  const pRef=FB.ref("rooms/"+c+"/presence/"+uid);
  set(pRef,role==="screen"?"tv":"p").catch(()=>{});onDisconnect(pRef).remove();
  const unP=onValue(FB.ref("rooms/"+c+"/presence"),snap=>{presence=snap.val()||{};if(view==="game")render();});
  let loaded=false;
  const unS=onValue(FB.ref("rooms/"+c+"/state"),snap=>{
    const firstLoad=!loaded;loaded=true;
    if(!snap.exists()){
      if(isHost)return;
      if(!quiet)toast(L("No room with code {0}",c));
      leave();return;
    }
    if(isHost)return; // the host renders from its own confirmed writes
    s=normalize(snap.val());
    if(firstLoad&&s.hostId===uid&&role==="player"){becomeHost();return;}
    afterState();
  },e=>{toast(L("Connection problem: {0}",e.message));});
  unsubState=()=>{unS();unP();remove(pRef).catch(()=>{});};
  setTimeout(()=>{if(!loaded)toast(L("Still connecting…"));},8000);
}
function afterState(){
  if(!s)return;
  if(role==="player"&&!isHost&&s.status==="lobby"&&!pl(uid)&&!joinSent){joinSent=true;send("join",{name:myName()});}
  view="game";render();
}

let saving=false,dirty=false;
async function save(){
  if(!isHost)return;
  dirty=true;if(saving)return;saving=true;
  while(dirty){
    dirty=false;
    const body=JSON.parse(JSON.stringify(s));
    try{await set(FB.ref("rooms/"+code+"/state"),body);shown=normalize(body);view="game";render();}
    catch(e){console.error(e);await sleep(700);dirty=true;}
  }
  saving=false;
}
async function send(kind,v){
  if(isHost){handle({uid,kind,v});return;}
  try{await push(FB.ref("rooms/"+code+"/inputs"),{uid,kind,v:v===undefined?null:v,at:Date.now()});}
  catch(e){toast(L("Couldn't send — check your connection"));}
}
function becomeHost(){
  isHost=true;shown=normalize(JSON.parse(JSON.stringify(s)));
  const inRef=FB.ref("rooms/"+code+"/inputs");
  unsubIn=onChildAdded(inRef,snap=>{
    try{handle(snap.val());}catch(e){console.error(e);}
    remove(snap.ref).catch(()=>{});
  });
  tickTimer=setInterval(tick,200);
  if(s.status==="playing"&&!POOL.qs.length)preparePool(s.settings.cats);
  view="game";render();
}
async function createRoom(){
  const A="ABCDEFGHJKLMNPQRSTUVWXYZ";let c="";
  for(let tries=0;tries<6;tries++){
    c="";for(let i=0;i<4;i++)c+=rand(A.split(""));
    const ex=await get(FB.ref("rooms/"+c+"/state")).catch(()=>null);
    if(!ex||!ex.exists())break;
  }
  openRoom(c,"player");
  isHost=true;shown=null;
  s=normalize({code:c,hostId:uid,status:"lobby",created:Date.now(),settings:{lives:"auto",timer:20,cats:[],catNames:[],party:false,diff:"normal",lang:devLang},
     players:[{id:uid,name:myName(),lives:3,shields:0,ghost:false,gp:0}],log:[],reactions:[]});
  log(L("{0} opened the room",myName()));
  const inRef=FB.ref("rooms/"+c+"/inputs");
  unsubIn=onChildAdded(inRef,snap=>{try{handle(snap.val());}catch(e){console.error(e);}remove(snap.ref).catch(()=>{});});
  tickTimer=setInterval(tick,200);
  save();
}

// ---------------- host: game logic ----------------
function log(t){s.log=(s.log||[]).slice(-6).concat([t]);}
function buildDeck(){const d=[];for(const k in CARDS)for(let i=0;i<CARDS[k].n;i++)d.push(k);return shuffle(d);}

function handle(inp){
  if(!s||!inp)return;
  const {kind,v}=inp;const id=inp.uid;const P=pl(id);
  if(kind==="join"){
    if(s.status!=="lobby"||P||s.players.length>=MAX_PLAYERS)return;
    const name=String((v&&v.name)||"Player").slice(0,16);
    s.players.push({id,name,lives:3,shields:0,ghost:false,gp:0});log(L("{0} joined",name));save();return;
  }
  if(!P)return;
  if(kind==="react"){
    if(!EMOJI.includes(v))return;
    s.reactions=(s.reactions||[]).slice(-5).concat([{id:Math.random().toString(36).slice(2,9),uid:id,e:v}]);save();return;
  }
  if(kind==="rename"&&s.status==="lobby"){P.name=String(v||P.name).slice(0,16);save();return;}
  if(s.status!=="playing")return;
  if(kind==="answer"){
    if(s.phase!=="question")return;
    const o=v&&typeof v==="object"?v:{c:v};
    if(s.ghostWho.includes(id)){ // ghost guessing along
      if(s.ghostAns[id]||(o.i!==undefined&&o.i!==s.q.i))return;
      s.ghostAns[id]={c:Number(o.c)};save();return;
    }
    if(!s.who.includes(id)||s.answers[id])return;
    if(o.i!==undefined&&o.i!==s.q.i)return;
    const limit=s.dur*1000+300;
    const rt=isFinite(o.rt)?Math.max(0,Number(o.rt)):now()-(s.until-s.dur*1000);
    if(rt>limit)return;
    const c=Number(o.c);s.answers[id]={c,t:rt};
    if(s.mode==="buzzer"&&c===s.q.correct&&!P.ghost&&s.who.filter(w=>!pl(w).ghost).every(w=>s.answers[w])){resolve();return;}
    if(s.who.every(w=>s.answers[w]))resolve();else save();
    return;
  }
  if(kind==="pick"){if(s.chooser===id)choose(v);}
  if(kind==="haunt"){
    const T=pl(v);if(!P.ghost||!(P.haunts>0)||!T||T.ghost)return;
    P.haunts--;s.cursed[T.id]=true;log(L("👻 {0} haunts {1} — their next question is harder 🧿",P.name,T.name));save();
  }
}

async function hostStart(){
  const n=s.players.length;if(n<2)return;
  s.status="starting";save();
  await preparePool(s.settings.cats);
  const LV=s.settings.lives==="auto"?(n>=5?2:3):Number(s.settings.lives);
  Object.assign(s,{status:"playing",maxLives:LV,deck:buildDeck(),dir:1,cur:Math.floor(Math.random()*n),turn:0,qn:0,
    firstLeft:n,cursed:{},safeLeft:0,extraSkip:0,winner:null,log:[L("Game on! {0} lives each.",LV)]});
  s.players.forEach(p=>Object.assign(p,{lives:LV,shields:0,ghost:false,gp:0,haunts:0}));
  startTurn();
}
function backToLobby(){Object.assign(s,{status:"lobby",phase:null,q:null,card:null});log(L("Back to the lobby"));save();}

function draw(forced){
  if(!s.deck.length)s.deck=buildDeck();
  if(forced){const i=s.deck.findIndex(c=>c!=="plain"&&c!=="skip");if(i>=0)return s.deck.splice(i,1)[0];}
  return s.deck.pop();
}
function startTurn(){
  s.turn++;const forced=s.firstLeft>0;if(forced)s.firstLeft--;
  const t=draw(forced);
  Object.assign(s,{card:{type:t},queue:[],chain:null,chainFail:false,result:null,q:null,who:[],answers:{},chooser:null,options:null,info:null,
    phase:"card",dur:3.3,until:now()+3300});
  log(L("{0} drew {1}",nm(curId()),CARDS[t].ic+" "+L(CARDS[t].name)));
  save();
}
function pickPhase(phase,chooser,options,secs){Object.assign(s,{phase,chooser,options,dur:secs,until:now()+secs*1000});save();}

function applyCard(t){
  const me=curId();
  switch(t){
    case "plain":return ask({who:[me],diff:rd()});
    case "easy":return ask({who:[me],diff:"easy"});
    case "double":s.chain="double";s.queue=[{who:[me],diff:rd()}];return ask({who:[me],diff:rd()});
    case "hard":return ask({who:[me],diff:"hard",reward:"heal"});
    case "speed":return ask({who:[me],diff:rd(),time:7});
    case "fifty":return ask({who:[me],diff:rd(),fifty:true});
    case "allin":s.chain="allin";s.queue=[{who:[me],diff:rd(),lose:2},{who:[me],diff:rd(),lose:2}];return ask({who:[me],diff:rd(),lose:2});
    case "cat":{const cats=poolCats();
      if(cats.length>=2)return pickPhase("pickcat",me,sample(cats,3).map(c=>"cat:"+c),15);
      return pickPhase("pickcat",me,["diff:easy","diff:medium","diff:hard"],15);}
    case "bomb":{const o=alive().filter(p=>p.id!==me).map(p=>p.id);
      if(o.length===1){log(L("{0} passes the bomb to {1} 💣",nm(me),nm(o[0])));return ask({who:o,diff:rd()});}
      return pickPhase("pick",me,o,15);}
    case "curse":{const nx=s.players[nextAlive(s.cur)].id;if(nx!==me){s.cursed[nx]=true;log(L("{0} is cursed 🧿",nm(nx)));}return ask({who:[me],diff:rd()});}
    case "skip":Object.assign(s,{phase:"info",info:L("{0}'s turn is skipped ⏭️",nm(me)),dur:2.4,until:now()+2400});return save();
    case "reverse":s.dir*=-1;Object.assign(s,{phase:"info",info:L("Play reverses direction 🔄"),dur:2.4,until:now()+2400});return save();
    case "jump":s.extraSkip=1;return ask({who:[me],diff:rd()});
    case "buzzer":return ask({who:s.players.map(p=>p.id),diff:rd(),mode:"buzzer"});
    case "sudden":return ask({who:alive().map(p=>p.id),diff:rd(),mode:"sudden"});
    case "safe":s.safeLeft=alive().length;return ask({who:[me],diff:rd()});
    case "shield":pl(me).shields++;return ask({who:[me],diff:rd()});
    case "underdog":{const al=alive(),mx=Math.max(...al.map(p=>p.lives)),mn=Math.min(...al.map(p=>p.lives));
      if(pl(me).lives===mn&&mn<mx)log(L("{0} is the underdog 🐶",nm(me))+" "+heal(me));else log(L("{0} isn't the underdog — no bonus",nm(me)));
      return ask({who:[me],diff:"easy"});}
    case "joker":return pickPhase("joker",me,Object.keys(CARDS).filter(k=>k!=="joker"&&k!=="plain"),20);
  }
}
function choose(v){
  const pick=s.options&&s.options.includes(v)?v:rand(s.options);
  if(s.phase==="pick"){log(L("{0} passes the bomb to {1} 💣",nm(s.chooser),nm(pick)));ask({who:[pick],diff:rd()});}
  else if(s.phase==="pickcat"){
    const [k,val]=pick.split(/:(.*)/s);log(L("{0} picks {1}",nm(s.chooser),k==="cat"?val:L(val)+" "+L("difficulty")));
    ask(k==="cat"?{who:[curId()],diff:rd(),cat:val}:{who:[curId()],diff:val});
  }else if(s.phase==="joker"){log(L("{0} plays the Joker as {1}",nm(s.chooser),L(CARDS[pick].name)));s.card={type:pick,joker:true};s.chooser=null;s.options=null;applyCard(pick);}
}
function ask(item){
  let diff=item.diff;
  if(item.who.length===1&&s.cursed[item.who[0]]){diff=diff==="easy"?"medium":"hard";delete s.cursed[item.who[0]];item.cursed=true;}
  const Q=takeQuestion(diff,item.cat);
  let opts=item.fifty?[Q.a,rand(Q.w)]:[Q.a,...Q.w];shuffle(opts);
  const secs=item.time||Number(s.settings.timer)||20;
  s.qn=(s.qn||0)+1;
  Object.assign(s,{q:{i:s.qn,text:Q.text,cat:Q.cat,diff:Q.diff,opts,correct:opts.indexOf(Q.a)},who:item.who,mode:item.mode||"single",item,
    answers:{},result:null,chooser:null,options:null,phase:"question",dur:secs,until:now()+secs*1000+600,
    ghostWho:(item.mode==="buzzer")?[]:s.players.filter(p=>p.ghost).map(p=>p.id),ghostAns:{}});
  save();
}
function ghostScore(id){const p=pl(id);p.gp++;if(p.gp%3===0){p.haunts=(p.haunts||0)+1;return " "+L("(+1 haunt 🧿)");}return "";}
function lose(id,n){
  const p=pl(id);if(s.safeLeft>0)return L("(Safe Round — no damage 🕊️)");
  const out=[];
  for(let k=0;k<n&&p.lives>0;k++){if(p.shields>0){p.shields--;out.push(L("🛡️ blocked"));}else{p.lives--;out.push(L("−1 ❤️"));}}
  if(p.lives<=0&&!p.ghost){p.ghost=true;out.push(L("— OUT 👻"));}
  return out.join(" ");
}
function heal(id){const p=pl(id);if(p.ghost)return "";if(p.lives<s.maxLives){p.lives++;return "+1 ❤️";}return L("(already full)");}
function resolve(){
  const q=s.q,it=s.item,res={};let text="";
  for(const id of s.who){const a=s.answers[id];res[id]=a?(a.c===q.correct?"right":"wrong"):"timeout";}
  if(s.mode==="single"){
    const id=s.who[0];const ok=res[id]==="right";s.lastOk=ok;
    if(ok){text=L("{0} got it ✅",nm(id));if(it.reward==="heal")text+=" "+heal(id);}
    else text=(res[id]==="timeout"?L("{0} ran out of time ⏰",nm(id)):L("{0} got it wrong ❌",nm(id)))+" "+lose(id,it.lose||1);
  }else if(s.mode==="buzzer"){
    const rights=Object.entries(s.answers).filter(([,a])=>a.c===q.correct).sort((a,b)=>a[1].t-b[1].t);
    const first=rights.find(([id])=>!pl(id).ghost);
    const g=rights.filter(([id])=>pl(id).ghost).map(([id])=>nm(id)+ghostScore(id));
    text=first?L("{0} was fastest 🔔",nm(first[0]))+" "+heal(first[0]):L("Nobody got it 🤷");
    if(g.length)text+=" · "+L("👻 point for {0}",g.join(", "));
  }else{
    const before=JSON.parse(JSON.stringify(s.players));
    const losers=s.who.filter(id=>res[id]!=="right");
    const parts=losers.map(id=>nm(id)+" "+lose(id,1));
    if(alive().length===0){s.players=before;text=L("Everyone would be out — you all survive! 😮‍💨");}
    else text=losers.length?parts.join(" · "):L("Everyone survived 😮‍💨");
  }
  const gr=Object.entries(s.ghostAns).filter(([,a])=>a.c===q.correct).map(([id])=>nm(id)+ghostScore(id));
  if(gr.length)text+=" · "+L("👻 {0} guessed right",gr.join(", "));
  s.result={res,text};log(text);
  Object.assign(s,{phase:"reveal",dur:3.5,until:now()+3500});save();
}
function afterReveal(){
  if(s.queue&&s.queue.length){
    if(s.lastOk&&!pl(curId()).ghost){ask(s.queue.shift());return;}
    s.queue=[];s.chainFail=true;
  }
  if(s.chain==="allin"&&s.lastOk&&!s.chainFail){
    const t=L("{0} survived All In! 🎰",nm(curId()))+" "+heal(curId());log(t);
    s.chain=null;Object.assign(s,{phase:"info",info:t,dur:2.5,until:now()+2500});save();return;
  }
  endTurn();
}
function nextAlive(c){const n=s.players.length;for(let k=1;k<=n;k++){const j=((c+s.dir*k)%n+n)%n;if(!s.players[j].ghost)return j;}return c;}
function endTurn(){
  const al=alive();
  if(al.length<=1){s.status="over";s.phase="over";s.winner=al[0]?al[0].id:null;log(L("🏆 {0} wins!",al[0]?al[0].name:L("Nobody")));save();return;}
  if(s.safeLeft>0)s.safeLeft--;
  const steps=1+(s.extraSkip||0);s.extraSkip=0;
  let c=s.cur;for(let k=0;k<steps;k++)c=nextAlive(c);
  s.cur=c;startTurn();
}
function tick(){
  if(!s||s.status!=="playing")return;
  const n=now();if(n<s.until+(s.phase==="question"?GRACE:0))return;
  if(s.phase==="card")applyCard(s.card.type);
  else if(s.phase==="question")resolve();
  else if(s.phase==="reveal")afterReveal();
  else if(s.phase==="pick"||s.phase==="pickcat"||s.phase==="joker")choose(null);
  else if(s.phase==="info")endTurn();
}


// ---------------- sound effects (synthesised with Web Audio — no files) ----------------
const SFX={ctx:null,on:ls.get("td_sound")!=="off",prev:null,lastTick:null};
function actx(){
  if(!SFX.ctx){try{SFX.ctx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){return null;}}
  if(SFX.ctx.state==="suspended")SFX.ctx.resume().catch(()=>{});
  return SFX.ctx;
}
function tone(f,t0,dur,type="sine",vol=.18,f2){
  const c=SFX.ctx,t=c.currentTime+t0,o=c.createOscillator(),g=c.createGain();
  o.type=type;o.frequency.setValueAtTime(f,t);if(f2)o.frequency.exponentialRampToValueAtTime(f2,t+dur);
  g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol,t+.012);g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  o.connect(g).connect(c.destination);o.start(t);o.stop(t+dur+.05);
}
function whoosh(t0,dur,vol=.22,from=400,to=3000){
  const c=SFX.ctx,t=c.currentTime+t0,n=Math.floor(c.sampleRate*dur),b=c.createBuffer(1,n,c.sampleRate),d=b.getChannelData(0);
  for(let i=0;i<n;i++)d[i]=Math.random()*2-1;
  const src=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
  src.buffer=b;f.type="bandpass";f.Q.value=1.2;f.frequency.setValueAtTime(from,t);f.frequency.exponentialRampToValueAtTime(to,t+dur);
  g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol,t+dur*.3);g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  src.connect(f).connect(g).connect(c.destination);src.start(t);src.stop(t+dur+.05);
}
const N=m=>440*Math.pow(2,(m-69)/12); // midi note -> Hz
function sfx(name,arg){
  if(!SFX.on)return;const c=actx();if(!c||c.state!=="running")return;
  try{switch(name){
    case "deal":whoosh(0,.32,.25,300,2400);break;
    case "flip":tone(900,0,.06,"triangle",.12,1600);break;
    case "card":{const fx=arg;
      if(fx==="red"){tone(110,0,.45,"square",.12,55);whoosh(0,.3,.18,1500,200);}
      else if(fx==="blue"){[72,76,79,76,72].forEach((m,i)=>tone(N(m),i*.06,.12,"triangle",.14));}
      else if(fx==="yellow"){[0,.16,.32].forEach(t=>{tone(N(81),t,.08,"square",.08);tone(N(76),t+.08,.08,"square",.08);});}
      else if(fx==="green"){[72,76,79,84].forEach((m,i)=>tone(N(m),i*.05,.5,"sine",.12));}
      else if(fx==="purple"){for(let i=0;i<10;i++)tone(N(70+i*2),i*.035,.18,"triangle",.09);}
      else tone(N(67),0,.25,"triangle",.14);
      break;}
    case "turn":tone(N(79),0,.15,"sine",.16);tone(N(84),.13,.3,"sine",.16);break;
    case "tick":tone(arg?1500:1150,0,.05,"square",.05);break;
    case "right":[72,76,79,84].forEach((m,i)=>tone(N(m),i*.07,.22,"triangle",.15));break;
    case "wrong":tone(196,0,.22,"sawtooth",.11,150);tone(147,.2,.35,"sawtooth",.11,110);break;
    case "hurt":tone(140,0,.25,"sine",.3,60);break;
    case "heal":[76,79,83,88].forEach((m,i)=>tone(N(m),i*.06,.3,"sine",.12));break;
    case "out":[67,66,65,62].forEach((m,i)=>tone(N(m),i*.32,i===3?.8:.3,"sawtooth",.09,i===3?N(58):undefined));break;
    case "win":[[60,0],[64,.12],[67,.24],[72,.36],[67,.6],[72,.72]].forEach(([m,t])=>{tone(N(m),t,.35,"square",.07);tone(N(m+12),t,.35,"triangle",.07);});break;
    case "pop":tone(600,0,.08,"sine",.15,1200);break;
    case "haunt":tone(N(60),0,.9,"sine",.12,N(48));tone(N(63),.05,.9,"sine",.08,N(51));break;
  }}catch(e){}
}
// compare the newly shown state with the previous one and play what changed
function soundsFor(S){
  const P=SFX.prev;SFX.prev={key:S.status+":"+S.turn+":"+(S.card&&S.card.type)+":"+S.phase+":"+(S.q&&S.q.i),
    phase:S.phase,status:S.status,lives:Object.fromEntries(S.players.map(p=>[p.id,p.lives])),ghosts:S.players.filter(p=>p.ghost).map(p=>p.id),
    cursed:Object.keys(S.cursed||{}).length,cardKey:S.turn+":"+(S.card&&S.card.type)};
  if(!P||P.key===SFX.prev.key&&P.cursed===SFX.prev.cursed)return;
  if(S.status==="playing"&&S.phase==="card"&&P.cardKey!==SFX.prev.cardKey){
    const fx=FXC[CARDS[S.card.type].c]||"grey";
    sfx("deal");setTimeout(()=>sfx("flip"),560);setTimeout(()=>sfx("card",fx),1150);
    if(curId()===uid)setTimeout(()=>sfx("turn"),1700);
  }
  if(S.phase==="reveal"&&P.phase!=="reveal"&&S.result){
    const mine=S.result.res&&S.result.res[uid];
    const ok=mine?mine==="right":(S.mode==="single"?S.result.res[S.who[0]]==="right":Object.values(S.result.res||{}).some(r=>r==="right"));
    sfx(ok?"right":"wrong");
  }
  for(const p of S.players){
    const was=P.lives[p.id];if(was===undefined)continue;
    if(p.lives<was&&!p.ghost)setTimeout(()=>sfx("hurt"),250);
    if(p.lives>was)setTimeout(()=>sfx("heal"),350);
  }
  if(S.players.some(p=>p.ghost&&!P.ghosts.includes(p.id)))setTimeout(()=>sfx("out"),400);
  if(SFX.prev.cursed>P.cursed&&S.phase!=="card")sfx("haunt");
  if(S.status==="over"&&P.status!=="over")setTimeout(()=>sfx("win"),300);
}

// ---------------- UI ----------------
function myName(){const el=document.getElementById("pname");const v=((el&&el.value.trim())||ls.get("td_name")||"Player").slice(0,16);ls.set("td_name",v);return v;}
function leave(){
  stopRoom();s=null;shown=null;code=null;isHost=false;ls.del("td_code");role="player";
  document.body.classList.remove("tv");
  try{history.replaceState(null,"",location.pathname);}catch(e){}
  view="home";render();
}
const roomLink=()=>location.origin+location.pathname+"?room="+code;
function hearts(p){
  if(p.ghost)return "👻"+(p.gp?" "+p.gp:"");
  return "❤️".repeat(p.lives)+"🖤".repeat(Math.max(0,(s.maxLives||p.lives)-p.lives))+(p.shields?" 🛡️"+(p.shields>1?p.shields:""):"");
}
const online=id=>!!presence[id];
function playersBar(){
  const turn=s.status==="playing"?curId():null;
  return `<div class="dir"><span>${L("Room")} ${esc(s.code)}${Object.values(presence).includes("tv")?" · 📺":""}</span><span>${s.status==="playing"?(s.dir===1?L("Order ➡️"):L("Order ⬅️ (reversed)"))+(s.safeLeft>0?L(" · 🕊️ safe"):""):""}</span></div>
  <div class="players">${s.players.map(p=>`<div class="pl ${p.id===turn?"turn":""} ${p.ghost?"ghost":""} ${online(p.id)?"":"off"}">${p.id===uid?`<span class="you">${L("you")}</span>`:""}
  <div class="nm">${esc(p.name)}${s.cursed&&s.cursed[p.id]?" 🧿":""}</div><div class="hp">${hearts(p)}</div></div>`).join("")}</div>`;
}
const FXC={"var(--red)":"red","var(--blue)":"blue","var(--yellow)":"yellow","var(--green)":"green","var(--purple)":"purple","var(--grey)":"grey"};
const HEX={red:"#ff5a5f",blue:"#3d8bff",yellow:"#ffc531",green:"#2ecc71",purple:"#a66bff",grey:"#c9c6e6"};
function cardHTML(t,anim){
  const C=CARDS[t],fx=FXC[C.c]||"grey";
  return `<div class="card3d ${anim?"play":"still"} fx-${fx} k-${t}" data-fx="${fx}" data-ic="${C.ic}" style="--c:${C.c}"><div class="inner">
    <div class="face front"><span class="crn tl">${C.ic}</span><span class="crn br">${C.ic}</span>
      <div class="oval"><span class="big">${C.ic}</span></div><div class="cn">${esc(L(C.name))}</div><div class="cd">${esc(L(C.d))}</div></div>
    <div class="face back"><div class="logo">TRIVIA<span>DECK</span></div></div></div></div>`;
}
// confetti-style burst from the card once it has flipped
function burstFrom(el){
  if(!el||(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches))return;
  const fx=el.dataset.fx,ic=el.dataset.ic;
  setTimeout(()=>{
    if(!document.body.contains(el))return;
    const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    const n=document.body.classList.contains("tv")?34:22;
    for(let i=0;i<n;i++){
      const d=document.createElement("span");const emoji=i%6===0;
      d.className="spark"+(emoji?" e":"");if(emoji)d.textContent=ic;
      const a=Math.random()*Math.PI*2,dist=(emoji?120:90)+Math.random()*(r.width*.9);
      d.style.left=cx+"px";d.style.top=cy+"px";
      d.style.background=i%3===0?"#fff":HEX[fx];
      d.style.setProperty("--dx",Math.cos(a)*dist+"px");d.style.setProperty("--dy",Math.sin(a)*dist+"px");
      d.style.setProperty("--r",(Math.random()*720-360)+"deg");
      document.body.appendChild(d);setTimeout(()=>d.remove(),950);
    }
  },1180);
}
function chip(t){const C=CARDS[t];return `<span class="chip" style="--c:${C.c}">${C.ic} ${esc(L(C.name))}</span>`;}
const tbar=()=>`<div class="tbar" id="tbar"><i></i></div>`;
function optLabel(ph,o){
  if(ph==="pick")return esc(nm(o));
  if(ph==="joker")return CARDS[o].ic+" "+esc(L(CARDS[o].name));
  const [k,v]=o.split(/:(.*)/s);return k==="cat"?esc(v):esc(L(v[0].toUpperCase()+v.slice(1)));
}

// main play area, shared by phones and the big screen
function playArea(tv){
  const me=role==="player"?pl(uid):null;
  const party=s.settings.party&&!tv;
  let h="";
  const ph=s.phase,cur=curId();
  if(ph==="card"){
    const key=s.turn+":"+s.card.type;const anim=lastFlip!==key;lastFlip=key;
    h+=`<div class="status">${cur===uid?L("Your turn — you drew…"):L("{0} drew…",esc(nm(cur)))}</div><div class="stage">${cardHTML(s.card.type,anim)}</div>`;
  }else if(ph==="info"){
    h+=`<div class="stage">${cardHTML(s.card.type,false)}</div><div class="result">${esc(s.info)}</div>`;
  }else if(ph==="pick"||ph==="pickcat"||ph==="joker"){
    const mine=s.chooser===uid&&!tv;
    const what=L(ph==="pick"?"who gets the bomb 💣":ph==="pickcat"?(s.options[0].startsWith("diff:")?"the difficulty 🎯":"a category 🎯"):"a card for the Joker 🃏");
    h+=`<div class="center" style="margin-top:8px">${chip(ph==="joker"?"joker":s.card.type)}</div>`;
    h+=`<div class="status">${mine?L("Choose {0}",what):L("{0} is choosing {1}",esc(nm(s.chooser)),what)}</div>${tbar()}`;
    if(mine)h+=`<div class="picks">${s.options.map(o=>`<button class="sec" data-pick="${esc(o)}">${optLabel(ph,o)}</button>`).join("")}</div>`;
  }else if((ph==="question"||ph==="reveal")&&s.q){
    const q=s.q,rev=ph==="reveal";
    const key=s.turn+":"+q.i;const myLocal=localAns&&localAns.key===key?localAns.c:null;
    const amGhostGuess=s.ghostWho.includes(uid);
    const my=s.answers[uid]?s.answers[uid].c:(s.ghostAns[uid]?s.ghostAns[uid].c:myLocal);
    const canAns=!tv&&!rev&&(s.who.includes(uid)||amGhostGuess)&&my==null;
    const who=s.mode==="single"?s.who[0]:null;
    h+=`<div class="center" style="margin-top:6px">${chip(s.card.type)}${s.item&&s.item.cursed?` <span class="tag">${L("🧿 cursed")}</span>`:""}</div>`;
    if(party&&!rev)h+=`<div class="lookup">${L("📺 Look at the big screen")}</div>`;
    else h+=`<div class="q">${esc(q.text)}<div><span class="tag">${esc(q.cat)}</span><span class="tag">${esc(L(q.diff))}</span></div></div>`;
    if(!rev)h+=tbar();
    h+=`<div class="opts">${q.opts.map((o,i)=>{
      let cls="opt";if(rev&&i===q.correct)cls+=" right";else if(rev&&Object.values(s.answers).some(a=>a.c===i))cls+=" wrong";
      if(my===i&&!tv)cls+=" mine";
      const pickers=rev?Object.entries(s.answers).filter(([,a])=>a.c===i).map(([id])=>nm(id)):[];
      return `<button class="${cls}" data-ans="${i}" ${canAns?"":"disabled"} style="${canAns||rev||tv?"opacity:1":""}"><span><span class="lt">${letters()[i]}</span>${esc(o)}</span><span class="who">${esc(pickers.join(", "))}</span></button>`;}).join("")}</div>`;
    if(rev)h+=`<div class="result">${esc(s.result?s.result.text:"")}</div>`;
    else{
      let st;
      if(s.mode==="buzzer")st=L(canAns?"🔔 Buzzer! Fastest right answer wins a life":my!=null?"Locked in — waiting…":"🔔 Buzzer round — everyone answers");
      else if(s.mode==="sudden")st=L(canAns?"💀 Everyone answers — wrong loses a life":my!=null?"Locked in — waiting for the others…":"💀 Sudden Death — everyone answers");
      else st=who===uid?L(my!=null?"Locked in…":"Your question!"):L("{0} is answering…",esc(nm(who)));
      if(amGhostGuess)st=L(my!=null?"👻 Guess locked in":"👻 Ghost guess — every 3 right answers earns a haunt");
      h+=`<div class="status">${st}</div>`;
    }
  }else if(s.status==="over"){
    h+=`<div class="winner">${L("🏆 {0} wins!",esc(s.winner?nm(s.winner):L("Nobody")))}</div>`;
    const g=s.players.filter(p=>p.gp>0);
    if(g.length)h+=`<div class="center mute">${L("Ghost points: {0}",g.map(p=>esc(p.name)+" "+p.gp).join(" · "))}</div>`;
    if(!tv)h+=isHost?`<div class="box"><button data-act="again">${L("Play again")}</button></div>`:`<div class="status">${L("Waiting for the host to start a new game…")}</div>`;
  }else if(s.status==="starting"){
    h+=`<div class="status" style="margin-top:40px">${L("🃏 Shuffling the deck and fetching questions…")}</div>`;
  }
  return h;
}

function gameView(){
  const me=pl(uid);
  let h=playersBar();
  if(me&&me.ghost&&s.status==="playing"){
    h+=`<div class="banner info">${L("You're a ghost now 👻 Keep guessing every question — each 3 right answers earns a <b>haunt</b>: curse a living player so their next question is harder. Ghost points: <b>{0}</b>",me.gp)}</div>`;
    if(me.haunts>0)h+=`<div class="box"><label>${L(me.haunts>1?"🧿 You have {0} haunts — who do you curse?":"🧿 You have {0} haunt — who do you curse?",me.haunts)}</label><div class="picks">${alive().map(p=>`<button class="sec" data-haunt="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div></div>`;
  }
  if(!me&&s.status!=="lobby")h+=`<div class="banner info">${L("This game already started — you're watching. You can join the next one.")}</div>`;
  h+=playArea(false);
  h+=`<div class="log">${(s.log||[]).slice(-4).map(l=>`<div>${esc(l)}</div>`).join("")}</div>`;
  h+=`<div class="center"><button class="link" data-act="leave">${L("Leave room")}</button></div>`;
  h+=muteBtn();
  if(me)h+=`<div class="react">${EMOJI.map(e=>`<button data-react="${e}">${e}</button>`).join("")}</div>`;
  return h;
}

const muteBtn=()=>`<button class="mute-btn" data-act="mute" aria-label="${L(SFX.on?"Mute sounds":"Turn sounds on")}">${SFX.on?"🔊":"🔇"}</button>`;
function tvView(){
  let h=muteBtn()+`<div class="tvhead"><h1>Trivia <span>Deck</span></h1><div class="tvcode">${L("Join at {0}",esc(location.host+location.pathname))}<b>${esc(s.code)}</b></div></div>`;
  if(s.status==="lobby"){
    h+=`<div class="box center"><div class="q">${L("Enter the room code on your phone to join")}</div><ul class="plist" style="max-width:520px;margin:0 auto;font-size:26px">${s.players.map(p=>`<li><span>${esc(p.name)}</span><span>${p.id===s.hostId?L("🏠 host"):""}</span></li>`).join("")}</ul><div class="status">${L("Waiting for the host to start…")}</div></div>`;
    return h;
  }
  const turn=s.status==="playing"?curId():null;
  h+=`<div class="tvgrid"><div>${playArea(true)}</div><div class="side">
    <div class="dir" style="font-size:18px"><span>${s.dir===1?L("Order ➡️"):L("Order ⬅️")}</span><span>${s.safeLeft>0?L("🕊️ safe round"):""}</span></div>
    ${s.players.map(p=>`<div class="pl ${p.id===turn?"turn":""} ${p.ghost?"ghost":""}"><div class="nm">${esc(p.name)}${s.cursed&&s.cursed[p.id]?" 🧿":""}</div><div class="hp">${hearts(p)}</div></div>`).join("")}
    <div class="log">${(s.log||[]).slice(-5).map(l=>`<div>${esc(l)}</div>`).join("")}</div></div></div>`;
  return h;
}

function catPicker(){
  const sel=s.settings.cats;
  if(!isHost){
    const names=s.settings.catNames.length?s.settings.catNames:[L("🌍 Everything")];
    return `<label>${L("Categories")}</label><div class="cats ro">${names.map(n=>`<button class="on">${esc(n)}</button>`).join("")}</div>`;
  }
  const he=lang()==="he",cats=he?[]:(catsCache||[]);
  const chips=[{id:"any",name:L("🌍 Everything")},...packIds().map(id=>({id,name:PACKS[id].name})),...cats];
  return `<label>${L("Categories")} <span class="small">${L("(tap to mix — or play 🌍 Everything)")}</span></label><div class="cats">${chips.map(c=>{
    const on=c.id==="any"?!sel.length:sel.includes(c.id);
    return `<button class="${on?"on":""}" data-cat="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`;}).join("")}${cats.length||he?"":`<span class="mute small">${L("Loading categories…")}</span>`}</div>`;
}

function lobbyView(){
  const me=pl(uid);
  let h=`<h1>Trivia <span>Deck</span></h1><p class="sub">${L("Trivia with Uno-style chaos")}</p>`;
  h+=`<div class="box center"><div class="mute">${L("Room code")}</div><div class="code">${esc(s.code)}</div>
    <div class="share"><button class="wa" data-act="wa">${L("Invite on WhatsApp")}</button><button class="sec" data-act="copy">${L("Copy link")}</button></div></div>`;
  h+=`<div class="box"><label>${L("Players ({0}/{1})",s.players.length,MAX_PLAYERS)}</label><ul class="plist">${s.players.map(p=>`<li class="${online(p.id)?"":"off"}"><span>${esc(p.name)}${p.id===s.hostId?` <span class="mute small">${L("🏠 host")}</span>`:""}</span><span class="mute">${p.id===uid?L("you"):online(p.id)?"":L("offline")}</span></li>`).join("")}</ul>
  ${!me&&role==="player"?`<div class="status">${L("Joining…")}</div>`:""}</div>`;
  h+=`<div class="box">${catPicker()}`;
  if(isHost){
    h+=`<div class="row" style="margin-top:14px"><div><label>${L("Lives")}</label><select id="slives">${["auto","2","3","4","5"].map(v=>`<option value="${v}" ${String(s.settings.lives)===v?"selected":""}>${v==="auto"?L("Auto (3, or 2 for 5+)"):v}</option>`).join("")}</select></div>
    <div><label>${L("Difficulty")}</label><select id="sdiff">${[["chill","😌 Chill"],["normal","🙂 Normal"],["brainy","🧠 Brainy"]].map(([v,l])=>`<option value="${v}" ${(s.settings.diff||"normal")===v?"selected":""}>${L(l)}</option>`).join("")}</select></div>
    <div><label>${L("Seconds")}</label><select id="stimer">${[15,20,30].map(v=>`<option ${Number(s.settings.timer)===v?"selected":""}>${v}</option>`).join("")}</select></div></div>
    <div style="margin-top:12px"><label>${L("Language")}</label><select id="slang"><option value="en" ${lang()==="en"?"selected":""}>English</option><option value="he" ${lang()==="he"?"selected":""}>עברית</option></select></div>
    <label class="toggle"><span>${L("📺 Party mode — questions show on a big screen, phones are buzzers")}</span><input type="checkbox" id="sparty" ${s.settings.party?"checked":""}></label>
    ${s.settings.party?`<p class="mute small">${L("Open <b>{0}</b> on a TV or laptop, tap “Big screen”, and enter code {1}.",esc(location.host+location.pathname),esc(s.code))}</p>`:""}
    </div><div class="box"><button data-act="start" ${s.players.length<2?"disabled":""}>${L(s.players.length<2?"Waiting for friends…":"Start game")}</button></div>`;
  }else h+=`${s.settings.party?`<p class="mute small">${L("📺 Party mode is on — questions will show on the big screen.")}</p>`:""}</div><div class="status">${L("Waiting for the host to start…")}</div>`;
  h+=rulesBox();
  h+=`<div class="center"><button class="link" data-act="leave">${L("Leave room")}</button></div>`;
  h+=muteBtn();
  return h;
}

function rulesBox(){
  return `<details class="box rules"><summary>${L("How to play & the cards")}</summary>
  <p class="mute small">${L("Before every turn a card is drawn. Get a question wrong and you lose a life. Lose them all and you're a ghost 👻 — ghosts keep guessing, and every 3 right guesses lets them haunt a living player. Last one standing wins. The first round is all action cards.")}</p>
  <table>${Object.values(CARDS).map(c=>`<tr><td>${c.ic}</td><td><b>${esc(L(c.name))}</b> <span class="mute">×${c.n}</span><br><span class="mute">${esc(L(c.d))}</span></td></tr>`).join("")}</table>
  <p class="mute small">Questions from the <a href="https://opentdb.com" style="color:inherit">Open Trivia Database</a> (CC BY-SA 4.0).</p></details>`;
}

function homeView(){
  return `<div class="langs"><button class="${lang()==="en"?"on":""}" data-act="lang" data-v="en">English</button><button class="${lang()==="he"?"on":""}" data-act="lang" data-v="he">עברית</button></div>
  <h1>Trivia <span>Deck</span></h1><p class="sub">${L("Trivia with Uno-style chaos. Play with friends on your phones.")}</p>
  <div class="box"><label>${L("Your name")}</label><input id="pname" maxlength="16" placeholder="${L("e.g. Tom")}" value="${esc(ls.get("td_name")||"")}"></div>
  <div class="box"><button data-act="create">${L("Create a room")}</button></div>
  <div class="box"><label>${L("Join with a code")}</label><div class="row"><input id="jcode" dir="ltr" maxlength="4" placeholder="ABCD" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:4px"><button class="sec" data-act="join" style="flex:0 0 100px">${L("Join")}</button></div>
  <button class="link" data-act="tv" style="margin-top:8px">${L("📺 Use this device as the big screen")}</button></div>
  ${rulesBox()}`;
}

function render(){
  const real=s;if(isHost&&shown)s=shown;
  try{renderInner();}finally{s=real;}
}
function renderInner(){
  const app=document.getElementById("app");
  try{document.documentElement.lang=lang();document.documentElement.dir=lang()==="he"?"rtl":"ltr";}catch(e){}
  if(view==="setup"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><div class="banner">${L("Almost there — paste your Firebase config into <b>config.js</b>.")}</div>`;return;}
  if(view==="error"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><div class="banner">${L("Couldn't sign in. Check that Anonymous sign-in is enabled in Firebase, then reload.")}</div>`;return;}
  if(view==="loading"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><p class="sub">${L("Loading…")}</p>`;return;}
  if(view==="connecting"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><p class="sub">${L("Connecting to room {0}…",esc(code))}</p><div class="center"><button class="link" data-act="leave">${L("Cancel")}</button></div>`;return;}
  if(view==="home"){app.innerHTML=homeView();return;}
  if(view==="game"&&s){
    if(role==="screen")app.innerHTML=tvView();
    else app.innerHTML=s.status==="lobby"?lobbyView():gameView();
    const sl=document.getElementById("slives"),st=document.getElementById("stimer"),sp=document.getElementById("sparty");
    if(sl)sl.onchange=()=>{s.settings.lives=sl.value;save();};
    if(st)st.onchange=()=>{s.settings.timer=Number(st.value);save();};
    const sd=document.getElementById("sdiff");if(sd)sd.onchange=()=>{s.settings.diff=sd.value;save();};
    const sg=document.getElementById("slang");if(sg)sg.onchange=()=>{s.settings.lang=sg.value;s.settings.cats=[];s.settings.catNames=[];devLang=sg.value;ls.set("td_lang",sg.value);save();};
    if(sp)sp.onchange=()=>{s.settings.party=sp.checked;save();};
    if(isHost&&s.status==="lobby"&&!catsCache&&!catsLoading){catsLoading=true;loadCats().then(c=>{catsCache=c;render();});}
    if(s.phase==="question"&&s.q){const k=s.turn+":"+s.q.i;if(qSeenKey!==k){qSeenKey=k;qSeenAt=Date.now();}}
    soundsFor(s);
    const played=document.querySelector(".card3d.play");if(played&&!played.dataset.burst){played.dataset.burst="1";burstFrom(played);}
    spawnReacts();updateTimer();
  }
}
function spawnReacts(){
  const list=(s&&s.reactions)||[];
  for(const r of list){
    if(seenReacts.has(r.id))continue;seenReacts.add(r.id);
    if(firstReacts)continue;
    if(r.uid!==uid)sfx("pop");
    const d=document.createElement("div");d.className="float";d.style.left=(10+Math.random()*75)+"%";
    d.innerHTML=esc(r.e)+`<small>${esc(nm(r.uid))}</small>`;document.getElementById("fx").appendChild(d);setTimeout(()=>d.remove(),2300);
  }
  firstReacts=false;
}
function updateTimer(){
  const V=isHost&&shown?shown:s;
  const b=document.getElementById("tbar");if(!b||!V||!V.until)return;
  const left=Math.max(0,V.until-now()),total=(V.dur||20)*1000;
  b.firstElementChild.style.width=Math.min(100,left/total*100)+"%";
  b.classList.toggle("low",left<4000);
  if(V.phase==="question"){const sec=Math.ceil(left/1000),k=V.q&&V.q.i+":"+sec;if(sec<=5&&sec>0&&SFX.lastTick!==k){SFX.lastTick=k;sfx("tick",sec<=2);}}
}
setInterval(updateTimer,200);

document.addEventListener("pointerdown",()=>{if(SFX.on)actx();},{passive:true});
document.addEventListener("click",async e=>{
  const t=e.target.closest("button");if(!t)return;
  const act=t.dataset.act;
  if(act==="lang"){devLang=t.dataset.v;ls.set("td_lang",devLang);render();return;}
  if(act==="create"){if(!uid){toast(L("Still connecting…"));return;}myName();createRoom();return;}
  if(act==="join"||act==="tv"){
    const c=(document.getElementById("jcode").value||"").trim().toUpperCase();
    if(!/^[A-Z]{4}$/.test(c)){toast(L("Enter the 4-letter room code"));return;}
    if(!uid){toast(L("Still connecting…"));return;}
    myName();openRoom(c,act==="tv"?"screen":"player");return;
  }
  if(act==="leave"){leave();return;}
  if(act==="wa"){window.open("https://wa.me/?text="+encodeURIComponent(L("Join my Trivia Deck game! 🃏 {0}",roomLink())),"_blank");return;}
  if(act==="copy"){try{await navigator.clipboard.writeText(roomLink());toast(L("Link copied"));}catch(err){toast(roomLink());}return;}
  if(act==="start"&&isHost){hostStart();return;}
  if(act==="again"&&isHost){backToLobby();return;}
  if(t.dataset.cat!==undefined&&isHost&&s.status==="lobby"){
    const id=t.dataset.cat;let cats=s.settings.cats.slice();let names=s.settings.catNames.slice();
    if(id==="any"){cats=[];names=[];}
    else if(cats.includes(id)){const i=cats.indexOf(id);cats.splice(i,1);names.splice(i,1);}
    else{cats.push(id);names.push(t.dataset.name);}
    s.settings.cats=cats;s.settings.catNames=names;save();return;
  }
  if(t.dataset.ans!==undefined){
    const V=isHost&&shown?shown:s;if(!V||!V.q)return;
    const i=Number(t.dataset.ans);localAns={key:V.turn+":"+V.q.i,c:i};
    send("answer",{c:i,i:V.q.i,rt:Date.now()-qSeenAt});render();return;
  }
  if(t.dataset.pick!==undefined){send("pick",t.dataset.pick);t.disabled=true;return;}
  if(t.dataset.react){sfx("pop");send("react",t.dataset.react);return;}
  if(t.dataset.haunt){send("haunt",t.dataset.haunt);t.disabled=true;return;}
  if(act==="mute"){SFX.on=!SFX.on;ls.set("td_sound",SFX.on?"on":"off");if(SFX.on){actx();sfx("pop");}render();return;}
});

boot();
