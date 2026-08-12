import { DurableObject } from "cloudflare:workers";

const FONT_IDS = ['Bangers','Luckiest Guy','Bowlby One SC','Black Ops One','Russo One','Titan One','Anton','Lilita One'];
const ROOM_NAME = 'batalha-principal';

function defaults(){
  return {
    battle:{title:'BATALHA DAS OPÇÕES',subtitle:'Envie presentes para a sua opção favorita!',backgroundImage:'',titleFont:'Bangers',titleSize:40,championLabel:'★ VENCEDOR DA BATALHA ★',showTimer:false,commentVoting:false},
    timer:{elapsedMs:0,running:false,startedAt:null},
    options:[
      {id:crypto.randomUUID(),name:'Opção A',image:'',giftIcon:'',color:'#ffcc00',gifts:'Rosa, Coração',giftIds:'',count:0},
      {id:crypto.randomUUID(),name:'Opção B',image:'',giftIcon:'',color:'#9aa7b3',gifts:'Café, Perfume',giftIds:'',count:0}
    ],
    lastGift:null,giftHistory:[],giftCatalog:[],savedPresets:[]
  };
}

function norm(s=''){return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase()}
function giftNames(s=''){return String(s).split(',').map(norm).filter(Boolean)}
function giftIds(s=''){return String(s).split(',').map(x=>String(x).trim()).filter(Boolean)}
function json(data,status=200,headers={}){return Response.json(data,{status,headers:{'cache-control':'no-store',...headers}})}
function unauthorized(){return new Response(null,{status:401,headers:{'WWW-Authenticate':'Basic realm="Batalha Admin"'}})}
function secureEqual(a,b){if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0}
function isAuthorized(request,env){
  const pass=String(env.ADMIN_PASSWORD||'');
  if(!pass)return false;
  const h=request.headers.get('authorization')||'';
  if(!h.startsWith('Basic '))return false;
  try{const d=atob(h.slice(6)),i=d.indexOf(':'),u=d.slice(0,i),p=d.slice(i+1);return u==='admin'&&secureEqual(p,pass)}catch{return false}
}
function cleanOption(o={}){return{id:String(o.id||crypto.randomUUID()),name:String(o.name||'Opção').trim().slice(0,80),image:String(o.image||'').slice(0,3000000),giftIcon:String(o.giftIcon||'').slice(0,700000),color:/^#[0-9a-f]{6}$/i.test(String(o.color||''))?String(o.color):'#2f7cff',gifts:String(o.gifts||'').trim().slice(0,1500),giftIds:String(o.giftIds||'').replace(/[^0-9, ]/g,'').slice(0,1500),count:Math.max(0,Number(o.count)||0)}}
function cleanBattle(b={}){const f=FONT_IDS.includes(String(b.titleFont))?String(b.titleFont):'Bangers',sz=Math.max(24,Math.min(48,Number(b.titleSize)||40));return{title:String(b.title||'BATALHA DAS OPÇÕES').trim().slice(0,100),subtitle:String(b.subtitle||'Envie presentes para a sua opção favorita!').trim().slice(0,180),backgroundImage:String(b.backgroundImage||'').slice(0,3000000),titleFont:f,titleSize:sz,championLabel:String(b.championLabel||'★ VENCEDOR DA BATALHA ★').trim().slice(0,80),showTimer:b.showTimer===true,commentVoting:b.commentVoting===true}}
function validateGiftMap(options){const usedNames=new Map(),usedIds=new Map();for(const o of options){for(const g of giftNames(o.gifts)){if(usedNames.has(g)&&usedNames.get(g)!==o.name)return `O presente "${g}" está configurado em mais de uma opção.`;usedNames.set(g,o.name)}for(const id of giftIds(o.giftIds)){if(usedIds.has(id)&&usedIds.get(id)!==o.name)return `O Gift ID "${id}" está configurado em mais de uma opção.`;usedIds.set(id,o.name)}}return null}
function validateOptionNames(options){const used=new Set();for(const o of options){const n=norm(o.name);if(!n)return'Todas as opções precisam ter nome.';if(used.has(n))return`Existem duas opções com o mesmo nome: "${o.name}".`;used.add(n)}return null}

export class BattleRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;this.env=env;this.state=defaults();this.ready=ctx.blockConcurrencyWhile(async()=>{const saved=await ctx.storage.get('state');if(saved)this.state={...defaults(),...saved,battle:{...defaults().battle,...(saved.battle||{})},timer:{elapsedMs:Math.max(0,Number(saved.timer?.elapsedMs)||0),running:false,startedAt:null},giftHistory:Array.isArray(saved.giftHistory)?saved.giftHistory:[],giftCatalog:Array.isArray(saved.giftCatalog)?saved.giftCatalog:[],savedPresets:Array.isArray(saved.savedPresets)?saved.savedPresets:[]};});
  }
  async persist(){await this.ctx.storage.put('state',this.state)}
  timerSnapshot(){const t=this.state.timer||{};return{elapsedMs:Math.max(0,Number(t.elapsedMs)||0)+(t.running&&t.startedAt?Date.now()-Number(t.startedAt):0),running:t.running===true,startedAt:t.startedAt||null}}
  countSnapshot(){return(this.state.options||[]).map(o=>({id:o.id,count:Math.max(0,Number(o.count)||0)}))}
  broadcast(type,payload={}){const msg=JSON.stringify({type,...payload,at:Date.now()});for(const ws of this.ctx.getWebSockets()){try{ws.send(msg)}catch{}}}
  async fetch(request){
    await this.ready;
    const url=new URL(request.url);
    if(request.headers.get('Upgrade')==='websocket'){
      const pair=new WebSocketPair();const [client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);server.send(JSON.stringify({type:'state',...this.state,timer:this.timerSnapshot()}));return new Response(null,{status:101,webSocket:client});
    }
    const needsAuth=url.pathname!=='/api/state'&&url.pathname!=='/api/health';
    if(needsAuth&&!isAuthorized(request,this.env))return unauthorized();
    if(request.method==='GET'&&url.pathname==='/api/health')return json({ok:true,platform:'cloudflare',version:1});
    if(request.method==='GET'&&url.pathname==='/api/state')return json({...this.state,timer:this.timerSnapshot()});
    if(request.method==='GET'&&url.pathname==='/api/gifts')return json({ok:true,gifts:this.state.giftCatalog||[]});
    if(request.method==='GET'&&url.pathname==='/api/gift-history')return json({ok:true,history:this.state.giftHistory||[]});
    if(request.method==='GET'&&url.pathname==='/api/presets')return json({ok:true,presets:(this.state.savedPresets||[]).map(p=>({name:p.name,updatedAt:p.updatedAt})).sort((a,b)=>b.updatedAt-a.updatedAt)});
    if(request.method!=='POST')return json({ok:false,error:'Rota não encontrada'},404);
    let body={};try{body=await request.json()}catch{}
    if(url.pathname==='/api/relay')return this.relay(body);
    if(url.pathname==='/api/config')return this.config(body);
    if(url.pathname==='/api/presets/save')return this.savePreset(body);
    if(url.pathname==='/api/presets/restore')return this.restorePreset(body);
    if(url.pathname==='/api/reset')return this.reset();
    if(url.pathname==='/api/reset-all')return this.resetAll();
    if(url.pathname==='/api/manual')return this.manual(body);
    if(url.pathname==='/api/timer')return this.timerAction(body);
    if(url.pathname==='/api/champion')return this.champion();
    if(url.pathname==='/api/cleanup')return this.cleanup(body);
    return json({ok:false,error:'Rota não encontrada'},404);
  }
  async relay(body={}){
    const event=String(body.event||''),data=body.data||{};
    if(event==='giftCatalog'){
      const incoming=Array.isArray(data.gifts)?data.gifts:[],byId=new Map((this.state.giftCatalog||[]).map(g=>[String(g.id),g]));let added=0,updated=0;
      for(const raw of incoming){const g={id:String(raw.id||raw.giftId||'').trim(),name:String(raw.name||raw.giftName||'').trim(),image:String(raw.image||'').slice(0,1000)};if(!g.id||!g.name)continue;const old=byId.get(g.id);if(old){byId.set(g.id,{...old,...g});updated++}else{byId.set(g.id,g);added++}}
      this.state.giftCatalog=[...byId.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')).slice(0,3000);await this.persist();this.broadcast('giftCatalog',{giftCatalog:this.state.giftCatalog});return json({ok:true,count:this.state.giftCatalog.length,added,updated});
    }
    if(event==='gift'){
      const giftName=String(data.giftName||'').trim(),giftId=String(data.giftId||'').trim();if(!giftName&&!giftId)return json({ok:true,matched:false});let opt=giftId?this.state.options.find(o=>giftIds(o.giftIds).includes(giftId)):null;if(!opt&&giftName)opt=this.state.options.find(o=>giftNames(o.gifts).includes(norm(giftName)));if(!opt)return json({ok:true,matched:false,giftName,giftId});
      const repeat=Math.max(1,Number(data.repeatCount||1)||1),u=data.user||{},entry={id:crypto.randomUUID(),source:'gift',optionId:opt.id,optionName:opt.name,giftId,giftName:giftName||`Gift ${giftId}`,giftImage:String(data.giftImage||'').slice(0,1000),repeatCount:repeat,user:{uniqueId:String(u.uniqueId||''),userId:String(u.userId||''),nickname:String(u.nickname||u.uniqueId||'TikTok'),avatar:String(u.avatar||'').slice(0,1000)},at:Date.now()};
      opt.count+=repeat;this.state.lastGift=entry;this.state.giftHistory.unshift(entry);if(this.state.giftHistory.length>200)this.state.giftHistory.length=200;await this.persist();this.broadcast('gift',{counts:this.countSnapshot(),timer:this.timerSnapshot(),lastGift:entry,giftHistory:this.state.giftHistory.slice(0,100)});return json({ok:true,matched:true,option:opt,lastGift:entry});
    }
    if(event==='comment'){
      if(this.state.battle.commentVoting!==true)return json({ok:true,matched:false,disabled:true});const comment=String(data.comment||'').trim();const opt=this.state.options.find(o=>norm(o.name)===norm(comment));if(!opt)return json({ok:true,matched:false,comment});const u=data.user||{},entry={id:crypto.randomUUID(),source:'comment',optionId:opt.id,optionName:opt.name,giftId:'',giftName:'Comentário',giftImage:'',repeatCount:1,comment,user:{uniqueId:String(u.uniqueId||''),userId:String(u.userId||''),nickname:String(u.nickname||u.uniqueId||'TikTok'),avatar:String(u.avatar||'').slice(0,1000)},at:Date.now()};opt.count++;this.state.giftHistory.unshift(entry);if(this.state.giftHistory.length>200)this.state.giftHistory.length=200;await this.persist();this.broadcast('commentVote',{counts:this.countSnapshot(),timer:this.timerSnapshot(),vote:entry,giftHistory:this.state.giftHistory.slice(0,100)});return json({ok:true,matched:true,option:opt,vote:entry});
    }
    return json({ok:false,error:'Evento não suportado'},400);
  }
  async config(body={}){const raw=Array.isArray(body.options)?body.options:[];if(!raw.length)return json({ok:false,error:'Crie pelo menos uma opção'},400);if(raw.length>6)return json({ok:false,error:'O máximo é 6 opções'},400);const options=raw.map(cleanOption),battle=cleanBattle(body.battle||{}),mapError=validateGiftMap(options);if(mapError)return json({ok:false,error:mapError},400);if(battle.commentVoting===true){const e=validateOptionNames(options);if(e)return json({ok:false,error:e},400)}this.state.battle=battle;this.state.options=options;await this.persist();this.broadcast('state',{...this.state,timer:this.timerSnapshot()});return json({ok:true,savedOptions:options.length,...this.state,timer:this.timerSnapshot()})}
  async savePreset(body={}){const battle=cleanBattle(body.battle||this.state.battle),raw=Array.isArray(body.options)?body.options:this.state.options,name=String(battle.title||'').trim();if(!name)return json({ok:false,error:'Informe o Nome da batalha antes de salvar.'},400);const options=raw.slice(0,6).map(o=>({...cleanOption(o),count:0})),preset={name,battle,options,updatedAt:Date.now()};const list=Array.isArray(this.state.savedPresets)?this.state.savedPresets:[],i=list.findIndex(p=>norm(p.name)===norm(name));if(i>=0)list[i]=preset;else list.push(preset);this.state.savedPresets=list.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,50);await this.persist();return json({ok:true,replaced:i>=0,name,presets:this.state.savedPresets.map(p=>({name:p.name,updatedAt:p.updatedAt}))})}
  async restorePreset(body={}){const name=String(body.name||'').trim(),preset=(this.state.savedPresets||[]).find(p=>norm(p.name)===norm(name));if(!preset)return json({ok:false,error:'Configuração salva não encontrada.'},404);this.state.battle=cleanBattle(preset.battle);this.state.options=(preset.options||[]).map(o=>({...cleanOption(o),count:0}));this.state.lastGift=null;this.state.giftHistory=[];this.state.timer={elapsedMs:0,running:false,startedAt:null};await this.persist();this.broadcast('state',{...this.state,timer:this.timerSnapshot()});return json({ok:true,name:preset.name,...this.state,timer:this.timerSnapshot()})}
  async reset(){for(const o of this.state.options)o.count=0;this.state.lastGift=null;this.state.giftHistory=[];await this.persist();this.broadcast('state',{...this.state,timer:this.timerSnapshot()});return json({ok:true})}
  async resetAll(){const catalog=this.state.giftCatalog||[],savedPresets=this.state.savedPresets||[];this.state=defaults();this.state.giftCatalog=catalog;this.state.savedPresets=savedPresets;await this.persist();this.broadcast('state',{...this.state,timer:this.timerSnapshot()});return json({ok:true,...this.state,timer:this.timerSnapshot()})}
  async manual(body={}){const id=String(body.id||''),amount=Math.max(1,Math.min(999,Number(body.amount||1))),opt=this.state.options.find(o=>o.id===id);if(!opt)return json({ok:false,error:'Opção não encontrada'},404);opt.count+=amount;const entry={id:crypto.randomUUID(),source:'gift',optionId:opt.id,optionName:opt.name,giftId:'admin-test',giftName:String(opt.gifts||'').split(',')[0]?.trim()||'Presente de teste',giftImage:'',repeatCount:amount,user:{uniqueId:'admin-teste',userId:'admin-teste',nickname:'Teste Admin',avatar:''},at:Date.now()};this.state.lastGift=entry;await this.persist();this.broadcast('gift',{counts:this.countSnapshot(),timer:this.timerSnapshot(),lastGift:entry});return json({ok:true,option:opt,lastGift:entry})}
  async timerAction(body={}){const action=String(body.action||''),t=this.state.timer;if(action==='play'){if(!t.running){t.running=true;t.startedAt=Date.now()}}else if(action==='pause'){if(t.running&&t.startedAt)t.elapsedMs+=Date.now()-t.startedAt;t.running=false;t.startedAt=null}else if(action==='reset'){t.elapsedMs=0;t.running=false;t.startedAt=null}else return json({ok:false,error:'Ação inválida'},400);await this.persist();const timer=this.timerSnapshot();this.broadcast('timer',{timer});return json({ok:true,timer})}
  async champion(){if(!this.state.options.length)return json({ok:false,error:'Sem opções'},400);const max=Math.max(...this.state.options.map(o=>Number(o.count)||0)),leaders=this.state.options.filter(o=>(Number(o.count)||0)===max);if(max<=0)return json({ok:false,error:'Ainda não há pontos'},400);if(leaders.length!==1)return json({ok:false,error:'Há empate no primeiro lugar'},400);const champion={...leaders[0],championLabel:this.state.battle.championLabel};this.broadcast('champion',{champion});return json({ok:true,champion})}
  async cleanup(body={}){const mode=String(body.mode||'safe'),before=JSON.stringify(this.state).length;this.state.lastGift=null;this.state.giftHistory=[];this.state.giftCatalog=(this.state.giftCatalog||[]).map(g=>({...g,image:''}));if(mode==='heavy'){this.state.battle={...this.state.battle,backgroundImage:''};this.state.options=(this.state.options||[]).map(o=>({...o,image:'',giftIcon:''}));this.state.savedPresets=(this.state.savedPresets||[]).map(p=>({...p,battle:{...(p.battle||{}),backgroundImage:''},options:(p.options||[]).map(o=>({...o,image:'',giftIcon:''}))}))}await this.persist();const after=JSON.stringify(this.state).length;if(mode==='heavy')this.broadcast('state',{...this.state,timer:this.timerSnapshot()});return json({ok:true,mode,beforeBytes:before,afterBytes:after,freedBytes:Math.max(0,before-after)})}
  webSocketMessage(){}
  webSocketClose(){}
  webSocketError(){}
}

const ADMIN_EXTRA=`<style>#cfCleanupBox{max-width:1280px;margin:0 auto 24px;padding:0 16px}#cfCleanupBox .card{background:#102433;border:1px solid #ffffff10;border-radius:18px;padding:16px;color:#fff;font-family:Arial,sans-serif}#cfCleanupBox .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}#cfCleanupBox button{border:1px solid #ffffff12;border-radius:10px;padding:10px;color:#fff;font-weight:900;cursor:pointer}#cfSafe{background:#31546b}#cfHeavy{background:#7c2936}#cfOut{margin-top:10px;color:#b8c9d5;font-size:12px}@media(max-width:650px){#cfCleanupBox .grid{grid-template-columns:1fr}}</style><div id="cfCleanupBox"><div class="card"><h2>🧹 Limpeza do servidor</h2><p class="sub">Segura: limpa histórico/temporários. Pesada: também remove imagens salvas.</p><div class="grid"><button id="cfSafe">🧹 LIMPEZA SEGURA</button><button id="cfHeavy">⚠️ LIMPEZA PESADA</button></div><div id="cfOut"></div></div></div><script>(function(){const out=document.getElementById('cfOut');async function run(mode){if(mode==='heavy'&&!confirm('Apagar fundo, imagens das opções, ícones e imagens das configurações salvas?'))return;try{out.textContent='Limpando...';const r=await fetch('/api/cleanup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})}),d=await r.json();if(!r.ok)throw Error(d.error||'Falha');out.textContent='✅ Liberado aproximadamente '+((d.freedBytes||0)/1048576).toFixed(2)+' MB.';if(mode==='heavy')setTimeout(()=>location.reload(),600)}catch(e){out.textContent='⚠️ '+e.message}}document.getElementById('cfSafe').onclick=()=>run('safe');document.getElementById('cfHeavy').onclick=()=>run('heavy')})();</script>`;

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const stub=env.BATTLE.getByName(ROOM_NAME);
    if(url.pathname==='/events'||url.pathname.startsWith('/api/'))return stub.fetch(request);
    if(url.pathname==='/admin'||url.pathname==='/admin.html'){
      if(!isAuthorized(request,env))return unauthorized();
      const assetUrl=new URL(request.url);assetUrl.pathname='/admin.html';
      const r=await env.ASSETS.fetch(new Request(assetUrl,request));if(!r.ok)return r;const html=await r.text();return new Response(html.replace('</body>',ADMIN_EXTRA+'</body>'),{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
    }
    if(['/server.js','/cleanup-once.js','/render.yaml','/package.json','/wrangler.jsonc'].includes(url.pathname)||url.pathname.startsWith('/connector/')||url.pathname.startsWith('/src/'))return new Response('Not found',{status:404});
    return env.ASSETS.fetch(request);
  }
};
