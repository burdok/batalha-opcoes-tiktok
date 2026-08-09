import fs from 'fs';
import path from 'path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { fileURLToPath } from 'url';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const CONFIG_FILE=path.join(__dirname,'config.json');

function loadConfig(){
  try{return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))}
  catch{return{server:'',username:'',adminPassword:'',signApiKey:''}}
}
function saveConfig(c){fs.writeFileSync(CONFIG_FILE,JSON.stringify(c,null,2),'utf8')}
function str(v){return v==null?'':String(v).trim()}

const rl=readline.createInterface({input:process.stdin,output:process.stdout});
let cfg=loadConfig();

console.log('========================================');
console.log(' BATALHA DE OPCOES - CONECTOR TIKTOK');
console.log('========================================');

if(cfg.server&&cfg.username&&cfg.adminPassword){
  console.log('Configuracao encontrada em config.json');
  console.log(`Servidor: ${cfg.server}`);
  console.log(`TikTok: @${cfg.username}`);
  const change=String(await rl.question('Usar configuracao salva? (S/n): ')).trim().toLowerCase();
  if(change==='n'||change==='nao'||change==='não')cfg={server:'',username:'',adminPassword:'',signApiKey:''};
}

if(!cfg.server)cfg.server=String(await rl.question('URL do jogo hospedado: ')).trim().replace(/\/+$/,'');
if(!cfg.username)cfg.username=String(await rl.question('Usuario TikTok da LIVE (sem @): ')).trim().replace(/^@+/,'');
if(!cfg.adminPassword)cfg.adminPassword=String(await rl.question('Senha do painel Admin: '));
if(!cfg.signApiKey)cfg.signApiKey=String(await rl.question('Sign API Key (opcional - ENTER para vazio): ')).trim();

if(!cfg.server||!cfg.username||!cfg.adminPassword){
  console.error('Dados obrigatorios ausentes.');
  process.exit(1);
}
saveConfig(cfg);

const auth='Basic '+Buffer.from(`admin:${cfg.adminPassword}`).toString('base64');

async function post(pathname,body){
  try{
    const r=await fetch(`${cfg.server}${pathname}`,{
      method:'POST',
      headers:{'content-type':'application/json','authorization':auth},
      body:JSON.stringify(body)
    });
    const text=await r.text();
    let d={};
    try{d=text?JSON.parse(text):{}}catch{d={error:text}}
    if(!r.ok){console.error(`ERRO ${r.status}:`,d.error||d);return null}
    return d;
  }catch(e){
    console.error('ERRO DE CONEXAO COM O JOGO:',e?.message||e);
    return null;
  }
}

async function sendRelay(event,data){return post('/api/relay',{event,data})}

async function rememberGift(gift){
  if(!gift?.id||!gift?.name)return;
  const r=await sendRelay('giftCatalog',{gifts:[gift]});
  if(r?.count!=null)console.log(`🧠 Catalogo atualizado | ${gift.name} | ID ${gift.id} | total salvo ${r.count}`);
}

async function relayGift(data){
  console.log(`🎁 RECEBIDO TikTok | ID ${data.giftId||'?'} | ${data.giftName||'sem nome'} | x${data.repeatCount} | ${data.user?.nickname||data.user?.uniqueId||'Usuario'}`);
  if(data.giftId&&data.giftName)rememberGift({id:data.giftId,name:data.giftName,image:data.giftImage||''}).catch(()=>{});
  const body=await sendRelay('gift',data);
  if(!body)return;
  const q=Math.max(1,Number(data.repeatCount)||1);
  if(body.matched)console.log(`✅ CONTABILIZADO | ${data.giftName} x${q} → ${body.option?.name||'opcao'} | total ${body.option?.count??'?'}`);
  else console.log(`⚠️ NAO CONTABILIZADO | "${data.giftName}" | ID ${data.giftId||'?'} | configure este ID no Admin`);
}

async function relayComment(data){
  const body=await sendRelay('comment',data);
  if(body?.matched)console.log(`💬 VOTO: ${data.user?.nickname||'Usuario'} → ${body.option?.name}`);
}

function user(u={}){
  return{
    uniqueId:String(u.uniqueId??u.userId??''),
    userId:String(u.userId??u.uniqueId??''),
    nickname:String(u.nickname??u.uniqueId??'TikTok'),
    avatar:u?.profilePicture?.urls?.[0]??u?.avatarThumb?.urlList?.[0]??''
  };
}

const connection=new TikTokLiveConnection(cfg.username,{
  ...(cfg.signApiKey?{signApiKey:cfg.signApiKey}:{}),
  enableExtendedGiftInfo:false
});

function resolveGift(d){
  const details=d?.giftDetails??{};
  const giftId=str(d?.giftId??details?.giftId??d?.extendedGiftInfo?.id);
  const giftType=Number(details?.giftType??d?.giftType??0);
  const giftName=str(details?.giftName)||str(d?.giftName)||str(d?.extendedGiftInfo?.name)||`Presente ID ${giftId||'desconhecido'}`;
  const giftImage=str(d?.extendedGiftInfo?.pictureUrl)||str(d?.extendedGiftInfo?.image?.urlList?.[0])||str(details?.image?.urlList?.[0])||str(details?.image?.url_list?.[0]);
  return{giftId,giftType,giftName,giftImage};
}

connection.on(WebcastEvent.GIFT,d=>{
  const g=resolveGift(d);
  const repeatEnd=d?.repeatEnd===true;
  const repeatCount=Math.max(1,Number(d?.repeatCount??1)||1);
  if(g.giftType===1&&!repeatEnd)return;
  relayGift({
    user:user(d?.user),
    giftId:g.giftId,
    giftType:g.giftType,
    giftName:g.giftName,
    giftImage:g.giftImage,
    repeatCount,
    diamondCount:Number(d?.giftDetails?.diamondCount??d?.diamondCount??0)
  }).catch(e=>console.error('Falha ao enviar presente:',e?.message||e));
});

connection.on(WebcastEvent.CHAT,d=>{
  const comment=str(d?.comment??d?.message);
  if(comment)relayComment({user:user(d?.user),comment}).catch(e=>console.error('Falha ao enviar comentario:',e?.message||e));
});

connection.on(ControlEvent.CONNECTED,()=>console.log('✅ WebSocket TikTok conectado.'));
connection.on(ControlEvent.ERROR,e=>console.error('TikTok:',e?.message||e));
connection.on(ControlEvent.DISCONNECTED,()=>console.log('⚠️ LIVE desconectada.'));

try{
  const state=await connection.connect();
  console.log(`✅ CONECTADO A @${cfg.username}`);
  console.log(`Room ID: ${state?.roomId||connection.roomId||'detectado'}`);
  console.log('✅ Modo gratuito ativo: nao busca a lista completa de presentes.');
  console.log('Cada presente recebido salva automaticamente Nome + Gift ID no Admin.');
  console.log('Presentes e comentarios da LIVE estao sendo monitorados.');
}catch(e){
  console.error('Falha ao conectar:',e?.message||e);
  process.exit(1);
}
