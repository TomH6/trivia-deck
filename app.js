// Trivia Deck — trivia with Uno-style action cards.
// Host-authoritative: the room creator's browser runs the game and writes rooms/{code}/state;
// everyone else sends moves to rooms/{code}/inputs. Clocks are synced with Firebase's server offset.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, set, get, push, remove, onValue, onChildAdded, onDisconnect } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./config.js";
import { BEATLES } from "./packs/beatles.js";

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
 reverse:{name:"Reverse",ic:"🔄",c:"var(--blue)",d:"Play changes direction. Then you answer.",n:3},
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
const rd=()=>{const r=Math.random();return r<.3?"easy":r<.8?"medium":"hard";};
const arr=v=>Array.isArray(v)?v:(v&&typeof v==="object"?Object.values(v):[]);

// ---------------- questions ----------------
const BEATLES_Q=BEATLES.map(q=>({cat:"Beatles: "+q[0],diff:q[1],text:q[2],a:q[3],w:[q[4],q[5],q[6]]}));
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
// sources: "any" | category id | "beatles"
async function fillPool(){
  if(POOL.busy||!POOL.sources.length)return;POOL.busy=true;
  try{
    const src=POOL.sources[POOL.next%POOL.sources.length];POOL.next++;
    if(src==="beatles")addToPool(shuffle(BEATLES_Q.slice()));
    else{const got=await fetchBatch(src==="any"?null:src);if(!got.length)POOL.failed=true;addToPool(got);}
  }catch(e){POOL.failed=true;}
  POOL.busy=false;
}
async function preparePool(sources){
  POOL.qs=[];POOL.next=0;POOL.failed=false;POOL.sources=sources.length?sources.slice():["any"];
  await fillPool();
  if(!POOL.qs.length){addToPool(BEATLES_Q);toast("Couldn't reach the trivia database — using the Beatles pack");}
  // fetch the other chosen sources in the background (the API allows one call per 5 s)
  (async()=>{for(let i=1;i<POOL.sources.length;i++)await fillPool();})();
}
function takeQuestion(diff,cat){
  if(POOL.qs.length<20&&!POOL.busy)fillPool();
  let idx=POOL.qs.findIndex(q=>q.diff===diff&&(!cat||q.cat===cat));
  if(idx<0)idx=POOL.qs.findIndex(q=>!cat||q.cat===cat);
  if(idx<0)idx=POOL.qs.length?0:-1;
  if(idx<0){POOL.seen.clear();addToPool(shuffle(BEATLES_Q.slice()));idx=0;}
  return POOL.qs.splice(idx,1)[0];
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
  x.players=arr(x.players).map(p=>Object.assign({lives:0,shields:0,ghost:false,gp:0},p));
  for(const k of ["log","reactions","deck","who","queue"])x[k]=arr(x[k]);
  for(const k of ["answers","cursed"])x[k]=x[k]||{};
  x.settings=Object.assign({lives:"auto",timer:20,cats:[],catNames:[],party:false},x.settings||{});
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
      if(!quiet)toast("No room with code "+c);
      leave();return;
    }
    if(isHost)return; // the host renders from its own confirmed writes
    s=normalize(snap.val());
    if(firstLoad&&s.hostId===uid&&role==="player"){becomeHost();return;}
    afterState();
  },e=>{toast("Connection problem: "+e.message);});
  unsubState=()=>{unS();unP();remove(pRef).catch(()=>{});};
  setTimeout(()=>{if(!loaded)toast("Still connecting…");},8000);
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
  catch(e){toast("Couldn't send — check your connection");}
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
  s=normalize({code:c,hostId:uid,status:"lobby",created:Date.now(),settings:{lives:"auto",timer:20,cats:[],catNames:[],party:false},
     players:[{id:uid,name:myName(),lives:3,shields:0,ghost:false,gp:0}],log:[myName()+" opened the room"],reactions:[]});
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
    s.players.push({id,name,lives:3,shields:0,ghost:false,gp:0});log(name+" joined");save();return;
  }
  if(!P)return;
  if(kind==="react"){
    if(!EMOJI.includes(v))return;
    s.reactions=(s.reactions||[]).slice(-5).concat([{id:Math.random().toString(36).slice(2,9),uid:id,e:v}]);save();return;
  }
  if(kind==="rename"&&s.status==="lobby"){P.name=String(v||P.name).slice(0,16);save();return;}
  if(s.status!=="playing")return;
  if(kind==="answer"){
    if(s.phase!=="question"||!s.who.includes(id)||s.answers[id])return;
    const o=v&&typeof v==="object"?v:{c:v};
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
}

async function hostStart(){
  const n=s.players.length;if(n<2)return;
  s.status="starting";save();
  await preparePool(s.settings.cats);
  const L=s.settings.lives==="auto"?(n>=5?2:3):Number(s.settings.lives);
  Object.assign(s,{status:"playing",maxLives:L,deck:buildDeck(),dir:1,cur:Math.floor(Math.random()*n),turn:0,qn:0,
    firstLeft:n,cursed:{},safeLeft:0,extraSkip:0,winner:null,log:["Game on! "+L+" lives each."]});
  s.players.forEach(p=>Object.assign(p,{lives:L,shields:0,ghost:false,gp:0}));
  startTurn();
}
function backToLobby(){Object.assign(s,{status:"lobby",phase:null,q:null,card:null});log("Back to the lobby");save();}

function draw(forced){
  if(!s.deck.length)s.deck=buildDeck();
  if(forced){const i=s.deck.findIndex(c=>c!=="plain"&&c!=="skip");if(i>=0)return s.deck.splice(i,1)[0];}
  return s.deck.pop();
}
function startTurn(){
  s.turn++;const forced=s.firstLeft>0;if(forced)s.firstLeft--;
  const t=draw(forced);
  Object.assign(s,{card:{type:t},queue:[],chain:null,chainFail:false,result:null,q:null,who:[],answers:{},chooser:null,options:null,info:null,
    phase:"card",dur:2.8,until:now()+2800});
  log(nm(curId())+" drew "+CARDS[t].ic+" "+CARDS[t].name);
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
      if(o.length===1){log(nm(me)+" passes the bomb to "+nm(o[0])+" 💣");return ask({who:o,diff:rd()});}
      return pickPhase("pick",me,o,15);}
    case "curse":{const nx=s.players[nextAlive(s.cur)].id;if(nx!==me){s.cursed[nx]=true;log(nm(nx)+" is cursed 🧿");}return ask({who:[me],diff:rd()});}
    case "skip":Object.assign(s,{phase:"info",info:nm(me)+"'s turn is skipped ⏭️",dur:2.4,until:now()+2400});return save();
    case "reverse":s.dir*=-1;return ask({who:[me],diff:rd()});
    case "jump":s.extraSkip=1;return ask({who:[me],diff:rd()});
    case "buzzer":return ask({who:s.players.map(p=>p.id),diff:rd(),mode:"buzzer"});
    case "sudden":return ask({who:alive().map(p=>p.id),diff:rd(),mode:"sudden"});
    case "safe":s.safeLeft=alive().length;return ask({who:[me],diff:rd()});
    case "shield":pl(me).shields++;return ask({who:[me],diff:rd()});
    case "underdog":{const al=alive(),mx=Math.max(...al.map(p=>p.lives)),mn=Math.min(...al.map(p=>p.lives));
      if(pl(me).lives===mn&&mn<mx)log(nm(me)+" is the underdog 🐶 "+heal(me));else log(nm(me)+" isn't the underdog — no bonus");
      return ask({who:[me],diff:"easy"});}
    case "joker":return pickPhase("joker",me,Object.keys(CARDS).filter(k=>k!=="joker"&&k!=="plain"),20);
  }
}
function choose(v){
  const pick=s.options&&s.options.includes(v)?v:rand(s.options);
  if(s.phase==="pick"){log(nm(s.chooser)+" passes the bomb to "+nm(pick)+" 💣");ask({who:[pick],diff:rd()});}
  else if(s.phase==="pickcat"){
    const [k,val]=pick.split(/:(.*)/s);log(nm(s.chooser)+" picks "+(k==="cat"?val:val+" difficulty"));
    ask(k==="cat"?{who:[curId()],diff:rd(),cat:val}:{who:[curId()],diff:val});
  }else if(s.phase==="joker"){log(nm(s.chooser)+" plays the Joker as "+CARDS[pick].name);s.card={type:pick,joker:true};s.chooser=null;s.options=null;applyCard(pick);}
}
function ask(item){
  let diff=item.diff;
  if(item.who.length===1&&s.cursed[item.who[0]]){diff=diff==="easy"?"medium":"hard";delete s.cursed[item.who[0]];item.cursed=true;}
  const Q=takeQuestion(diff,item.cat);
  let opts=item.fifty?[Q.a,rand(Q.w)]:[Q.a,...Q.w];shuffle(opts);
  const secs=item.time||Number(s.settings.timer)||20;
  s.qn=(s.qn||0)+1;
  Object.assign(s,{q:{i:s.qn,text:Q.text,cat:Q.cat,diff:Q.diff,opts,correct:opts.indexOf(Q.a)},who:item.who,mode:item.mode||"single",item,
    answers:{},result:null,chooser:null,options:null,phase:"question",dur:secs,until:now()+secs*1000+600});
  save();
}
function lose(id,n){
  const p=pl(id);if(s.safeLeft>0)return "(Safe Round — no damage 🕊️)";
  const out=[];
  for(let k=0;k<n&&p.lives>0;k++){if(p.shields>0){p.shields--;out.push("🛡️ blocked");}else{p.lives--;out.push("−1 ❤️");}}
  if(p.lives<=0&&!p.ghost){p.ghost=true;out.push("— OUT 👻");}
  return out.join(" ");
}
function heal(id){const p=pl(id);if(p.ghost)return "";if(p.lives<s.maxLives){p.lives++;return "+1 ❤️";}return "(already full)";}
function resolve(){
  const q=s.q,it=s.item,res={};let text="";
  for(const id of s.who){const a=s.answers[id];res[id]=a?(a.c===q.correct?"right":"wrong"):"timeout";}
  if(s.mode==="single"){
    const id=s.who[0];const ok=res[id]==="right";s.lastOk=ok;
    if(ok){text=nm(id)+" got it ✅";if(it.reward==="heal")text+=" "+heal(id);}
    else text=nm(id)+(res[id]==="timeout"?" ran out of time ⏰ ":" got it wrong ❌ ")+lose(id,it.lose||1);
  }else if(s.mode==="buzzer"){
    const rights=Object.entries(s.answers).filter(([,a])=>a.c===q.correct).sort((a,b)=>a[1].t-b[1].t);
    const first=rights.find(([id])=>!pl(id).ghost);
    rights.filter(([id])=>pl(id).ghost).forEach(([id])=>{pl(id).gp++;});
    text=first?nm(first[0])+" was fastest 🔔 "+heal(first[0]):"Nobody got it 🤷";
    const g=rights.filter(([id])=>pl(id).ghost).map(([id])=>nm(id));if(g.length)text+=" · 👻 point for "+g.join(", ");
  }else{
    const before=JSON.parse(JSON.stringify(s.players));
    const losers=s.who.filter(id=>res[id]!=="right");
    const parts=losers.map(id=>nm(id)+" "+lose(id,1));
    if(alive().length===0){s.players=before;text="Everyone would be out — you all survive! 😮‍💨";}
    else text=losers.length?parts.join(" · "):"Everyone survived 😮‍💨";
  }
  s.result={res,text};log(text);
  Object.assign(s,{phase:"reveal",dur:3.5,until:now()+3500});save();
}
function afterReveal(){
  if(s.queue&&s.queue.length){
    if(s.lastOk&&!pl(curId()).ghost){ask(s.queue.shift());return;}
    s.queue=[];s.chainFail=true;
  }
  if(s.chain==="allin"&&s.lastOk&&!s.chainFail){
    const t=nm(curId())+" survived All In! 🎰 "+heal(curId());log(t);
    s.chain=null;Object.assign(s,{phase:"info",info:t,dur:2.5,until:now()+2500});save();return;
  }
  endTurn();
}
function nextAlive(c){const n=s.players.length;for(let k=1;k<=n;k++){const j=((c+s.dir*k)%n+n)%n;if(!s.players[j].ghost)return j;}return c;}
function endTurn(){
  const al=alive();
  if(al.length<=1){s.status="over";s.phase="over";s.winner=al[0]?al[0].id:null;log("🏆 "+(al[0]?al[0].name:"Nobody")+" wins!");save();return;}
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
  return `<div class="dir"><span>Room ${esc(s.code)}${Object.values(presence).includes("tv")?" · 📺":""}</span><span>${s.status==="playing"?(s.dir===1?"Order ➡️":"Order ⬅️ (reversed)")+(s.safeLeft>0?" · 🕊️ safe":""):""}</span></div>
  <div class="players">${s.players.map(p=>`<div class="pl ${p.id===turn?"turn":""} ${p.ghost?"ghost":""} ${online(p.id)?"":"off"}">${p.id===uid?'<span class="you">you</span>':""}
  <div class="nm">${esc(p.name)}${s.cursed&&s.cursed[p.id]?" 🧿":""}</div><div class="hp">${hearts(p)}</div></div>`).join("")}</div>`;
}
function cardHTML(t,anim){const C=CARDS[t];return `<div class="card ${anim?"anim":""}" style="--c:${C.c}"><div class="ic">${C.ic}</div><div class="cn">${esc(C.name)}</div><div class="cd">${esc(C.d)}</div></div>`;}
function chip(t){const C=CARDS[t];return `<span class="chip" style="--c:${C.c}">${C.ic} ${esc(C.name)}</span>`;}
const tbar=()=>`<div class="tbar" id="tbar"><i></i></div>`;
function optLabel(ph,o){
  if(ph==="pick")return esc(nm(o));
  if(ph==="joker")return CARDS[o].ic+" "+esc(CARDS[o].name);
  const [k,v]=o.split(/:(.*)/s);return k==="cat"?esc(v):esc(v[0].toUpperCase()+v.slice(1));
}

// main play area, shared by phones and the big screen
function playArea(tv){
  const me=role==="player"?pl(uid):null;
  const party=s.settings.party&&!tv;
  let h="";
  const ph=s.phase,cur=curId();
  if(ph==="card"){
    const key=s.turn+":"+s.card.type;const anim=lastFlip!==key;lastFlip=key;
    h+=`<div class="status">${cur===uid?"Your turn — you drew…":esc(nm(cur))+" drew…"}</div><div class="stage">${cardHTML(s.card.type,anim)}</div>`;
  }else if(ph==="info"){
    h+=`<div class="stage">${cardHTML(s.card.type,false)}</div><div class="result">${esc(s.info)}</div>`;
  }else if(ph==="pick"||ph==="pickcat"||ph==="joker"){
    const mine=s.chooser===uid&&!tv;
    const what=ph==="pick"?"who gets the bomb 💣":ph==="pickcat"?(s.options[0].startsWith("diff:")?"the difficulty 🎯":"a category 🎯"):"a card for the Joker 🃏";
    h+=`<div class="center" style="margin-top:8px">${chip(ph==="joker"?"joker":s.card.type)}</div>`;
    h+=`<div class="status">${mine?"Choose "+what:esc(nm(s.chooser))+" is choosing "+what}</div>${tbar()}`;
    if(mine)h+=`<div class="picks">${s.options.map(o=>`<button class="sec" data-pick="${esc(o)}">${optLabel(ph,o)}</button>`).join("")}</div>`;
  }else if((ph==="question"||ph==="reveal")&&s.q){
    const q=s.q,rev=ph==="reveal";
    const key=s.turn+":"+q.i;const myLocal=localAns&&localAns.key===key?localAns.c:null;
    const my=s.answers[uid]?s.answers[uid].c:myLocal;
    const canAns=!tv&&!rev&&s.who.includes(uid)&&my==null;
    const who=s.mode==="single"?s.who[0]:null;
    h+=`<div class="center" style="margin-top:6px">${chip(s.card.type)}${s.item&&s.item.cursed?' <span class="tag">🧿 cursed</span>':""}</div>`;
    if(party&&!rev)h+=`<div class="lookup">📺 Look at the big screen</div>`;
    else h+=`<div class="q">${esc(q.text)}<div><span class="tag">${esc(q.cat)}</span><span class="tag">${esc(q.diff)}</span></div></div>`;
    if(!rev)h+=tbar();
    h+=`<div class="opts">${q.opts.map((o,i)=>{
      let cls="opt";if(rev&&i===q.correct)cls+=" right";else if(rev&&Object.values(s.answers).some(a=>a.c===i))cls+=" wrong";
      if(my===i&&!tv)cls+=" mine";
      const pickers=rev?Object.entries(s.answers).filter(([,a])=>a.c===i).map(([id])=>nm(id)):[];
      return `<button class="${cls}" data-ans="${i}" ${canAns?"":"disabled"} style="${canAns||rev||tv?"opacity:1":""}"><span><span class="lt">${LETTERS[i]}</span>${esc(o)}</span><span class="who">${esc(pickers.join(", "))}</span></button>`;}).join("")}</div>`;
    if(rev)h+=`<div class="result">${esc(s.result?s.result.text:"")}</div>`;
    else{
      let st;
      if(s.mode==="buzzer")st=canAns?"🔔 Buzzer! Fastest right answer wins a life":my!=null?"Locked in — waiting…":"🔔 Buzzer round — everyone answers";
      else if(s.mode==="sudden")st=canAns?"💀 Everyone answers — wrong loses a life":my!=null?"Locked in — waiting for the others…":"💀 Sudden Death — everyone answers";
      else st=who===uid?(my!=null?"Locked in…":"Your question!"):esc(nm(who))+" is answering…";
      h+=`<div class="status">${st}</div>`;
    }
  }else if(s.status==="over"){
    h+=`<div class="winner">🏆 ${esc(s.winner?nm(s.winner):"Nobody")} wins!</div>`;
    const g=s.players.filter(p=>p.gp>0);
    if(g.length)h+=`<div class="center mute">Ghost points: ${g.map(p=>esc(p.name)+" "+p.gp).join(" · ")}</div>`;
    if(!tv)h+=isHost?`<div class="box"><button data-act="again">Play again</button></div>`:`<div class="status">Waiting for the host to start a new game…</div>`;
  }else if(s.status==="starting"){
    h+=`<div class="status" style="margin-top:40px">🃏 Shuffling the deck and fetching questions…</div>`;
  }
  return h;
}

function gameView(){
  const me=pl(uid);
  let h=playersBar();
  if(me&&me.ghost&&s.status==="playing")h+=`<div class="banner info">You're out — you're a ghost now 👻 Jump in on Buzzer Rounds for ghost points and keep the reactions coming.</div>`;
  if(!me&&s.status!=="lobby")h+=`<div class="banner info">This game already started — you're watching. You can join the next one.</div>`;
  h+=playArea(false);
  h+=`<div class="log">${(s.log||[]).slice(-4).map(l=>`<div>${esc(l)}</div>`).join("")}</div>`;
  h+=`<div class="center"><button class="link" data-act="leave">Leave room</button></div>`;
  if(me)h+=`<div class="react">${EMOJI.map(e=>`<button data-react="${e}">${e}</button>`).join("")}</div>`;
  return h;
}

function tvView(){
  let h=`<div class="tvhead"><h1>Trivia <span>Deck</span></h1><div class="tvcode">Join at ${esc(location.host+location.pathname)}<b>${esc(s.code)}</b></div></div>`;
  if(s.status==="lobby"){
    h+=`<div class="box center"><div class="q">Scan the room code on your phone to join</div><ul class="plist" style="max-width:520px;margin:0 auto;font-size:26px">${s.players.map(p=>`<li><span>${esc(p.name)}</span><span>${p.id===s.hostId?"👑":""}</span></li>`).join("")}</ul><div class="status">Waiting for the host to start…</div></div>`;
    return h;
  }
  const turn=s.status==="playing"?curId():null;
  h+=`<div class="tvgrid"><div>${playArea(true)}</div><div class="side">
    <div class="dir" style="font-size:18px"><span>${s.dir===1?"Order ➡️":"Order ⬅️"}</span><span>${s.safeLeft>0?"🕊️ safe round":""}</span></div>
    ${s.players.map(p=>`<div class="pl ${p.id===turn?"turn":""} ${p.ghost?"ghost":""}"><div class="nm">${esc(p.name)}${s.cursed&&s.cursed[p.id]?" 🧿":""}</div><div class="hp">${hearts(p)}</div></div>`).join("")}
    <div class="log">${(s.log||[]).slice(-5).map(l=>`<div>${esc(l)}</div>`).join("")}</div></div></div>`;
  return h;
}

function catPicker(){
  const sel=s.settings.cats;
  if(!isHost){
    const names=s.settings.catNames.length?s.settings.catNames:["Any category"];
    return `<label>Categories</label><div class="cats ro">${names.map(n=>`<button class="on">${esc(n)}</button>`).join("")}</div>`;
  }
  const cats=catsCache||[];
  const chips=[{id:"any",name:"🎲 Any category"},{id:"beatles",name:"🎸 Beatles pack"},...cats];
  return `<label>Categories <span class="small">(pick any — none means everything)</span></label><div class="cats">${chips.map(c=>{
    const on=c.id==="any"?!sel.length:sel.includes(c.id);
    return `<button class="${on?"on":""}" data-cat="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`;}).join("")}${cats.length?"":'<span class="mute small">Loading categories…</span>'}</div>`;
}

function lobbyView(){
  const me=pl(uid);
  let h=`<h1>Trivia <span>Deck</span></h1><p class="sub">Trivia with Uno-style chaos</p>`;
  h+=`<div class="box center"><div class="mute">Room code</div><div class="code">${esc(s.code)}</div>
    <div class="share"><button class="wa" data-act="wa">Invite on WhatsApp</button><button class="sec" data-act="copy">Copy link</button></div></div>`;
  h+=`<div class="box"><label>Players (${s.players.length}/${MAX_PLAYERS})</label><ul class="plist">${s.players.map(p=>`<li class="${online(p.id)?"":"off"}"><span>${esc(p.name)}${p.id===s.hostId?" 👑":""}</span><span class="mute">${p.id===uid?"you":online(p.id)?"":"offline"}</span></li>`).join("")}</ul>
  ${!me&&role==="player"?'<div class="status">Joining…</div>':""}</div>`;
  h+=`<div class="box">${catPicker()}`;
  if(isHost){
    h+=`<div class="row" style="margin-top:14px"><div><label>Lives</label><select id="slives">${["auto","2","3","4","5"].map(v=>`<option value="${v}" ${String(s.settings.lives)===v?"selected":""}>${v==="auto"?"Auto (3, or 2 for 5+)":v}</option>`).join("")}</select></div>
    <div><label>Seconds per question</label><select id="stimer">${[15,20,30].map(v=>`<option ${Number(s.settings.timer)===v?"selected":""}>${v}</option>`).join("")}</select></div></div>
    <label class="toggle"><span>📺 Party mode — questions show on a big screen, phones are buzzers</span><input type="checkbox" id="sparty" ${s.settings.party?"checked":""}></label>
    ${s.settings.party?`<p class="mute small">Open <b>${esc(location.host+location.pathname)}</b> on a TV or laptop, tap “Big screen”, and enter code ${esc(s.code)}.</p>`:""}
    </div><div class="box"><button data-act="start" ${s.players.length<2?"disabled":""}>${s.players.length<2?"Waiting for friends…":"Start game"}</button></div>`;
  }else h+=`${s.settings.party?'<p class="mute small">📺 Party mode is on — questions will show on the big screen.</p>':""}</div><div class="status">Waiting for the host to start…</div>`;
  h+=rulesBox();
  h+=`<div class="center"><button class="link" data-act="leave">Leave room</button></div>`;
  return h;
}

function rulesBox(){
  return `<details class="box rules"><summary>How to play & the cards</summary>
  <p class="mute small">Before every turn a card is drawn. Get a question wrong and you lose a life. Lose them all and you're a ghost 👻. Last one standing wins. The first round is all action cards.</p>
  <table>${Object.values(CARDS).map(c=>`<tr><td>${c.ic}</td><td><b>${esc(c.name)}</b> <span class="mute">×${c.n}</span><br><span class="mute">${esc(c.d)}</span></td></tr>`).join("")}</table>
  <p class="mute small">Questions from the <a href="https://opentdb.com" style="color:inherit">Open Trivia Database</a> (CC BY-SA 4.0).</p></details>`;
}

function homeView(){
  return `<h1>Trivia <span>Deck</span></h1><p class="sub">Trivia with Uno-style chaos. Play with friends on your phones.</p>
  <div class="box"><label>Your name</label><input id="pname" maxlength="16" placeholder="e.g. Tom" value="${esc(ls.get("td_name")||"")}"></div>
  <div class="box"><button data-act="create">Create a room</button></div>
  <div class="box"><label>Join with a code</label><div class="row"><input id="jcode" maxlength="4" placeholder="ABCD" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:4px"><button class="sec" data-act="join" style="flex:0 0 100px">Join</button></div>
  <button class="link" data-act="tv" style="margin-top:8px">📺 Use this device as the big screen</button></div>
  ${rulesBox()}`;
}

function render(){
  const real=s;if(isHost&&shown)s=shown;
  try{renderInner();}finally{s=real;}
}
function renderInner(){
  const app=document.getElementById("app");
  if(view==="setup"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><div class="banner">Almost there — paste your Firebase config into <b>config.js</b>.</div>`;return;}
  if(view==="error"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><div class="banner">Couldn't sign in. Check that Anonymous sign-in is enabled in Firebase, then reload.</div>`;return;}
  if(view==="loading"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><p class="sub">Loading…</p>`;return;}
  if(view==="connecting"){app.innerHTML=`<h1>Trivia <span>Deck</span></h1><p class="sub">Connecting to room ${esc(code)}…</p><div class="center"><button class="link" data-act="leave">Cancel</button></div>`;return;}
  if(view==="home"){app.innerHTML=homeView();return;}
  if(view==="game"&&s){
    if(role==="screen")app.innerHTML=tvView();
    else app.innerHTML=s.status==="lobby"?lobbyView():gameView();
    const sl=document.getElementById("slives"),st=document.getElementById("stimer"),sp=document.getElementById("sparty");
    if(sl)sl.onchange=()=>{s.settings.lives=sl.value;save();};
    if(st)st.onchange=()=>{s.settings.timer=Number(st.value);save();};
    if(sp)sp.onchange=()=>{s.settings.party=sp.checked;save();};
    if(isHost&&s.status==="lobby"&&!catsCache&&!catsLoading){catsLoading=true;loadCats().then(c=>{catsCache=c;render();});}
    if(s.phase==="question"&&s.q){const k=s.turn+":"+s.q.i;if(qSeenKey!==k){qSeenKey=k;qSeenAt=Date.now();}}
    spawnReacts();updateTimer();
  }
}
function spawnReacts(){
  const list=(s&&s.reactions)||[];
  for(const r of list){
    if(seenReacts.has(r.id))continue;seenReacts.add(r.id);
    if(firstReacts)continue;
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
}
setInterval(updateTimer,200);

document.addEventListener("click",async e=>{
  const t=e.target.closest("button");if(!t)return;
  const act=t.dataset.act;
  if(act==="create"){if(!uid){toast("Still connecting…");return;}myName();createRoom();return;}
  if(act==="join"||act==="tv"){
    const c=(document.getElementById("jcode").value||"").trim().toUpperCase();
    if(!/^[A-Z]{4}$/.test(c)){toast("Enter the 4-letter room code");return;}
    if(!uid){toast("Still connecting…");return;}
    myName();openRoom(c,act==="tv"?"screen":"player");return;
  }
  if(act==="leave"){leave();return;}
  if(act==="wa"){window.open("https://wa.me/?text="+encodeURIComponent("Join my Trivia Deck game! 🃏 "+roomLink()),"_blank");return;}
  if(act==="copy"){try{await navigator.clipboard.writeText(roomLink());toast("Link copied");}catch(err){toast(roomLink());}return;}
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
  if(t.dataset.react){send("react",t.dataset.react);return;}
});

boot();
