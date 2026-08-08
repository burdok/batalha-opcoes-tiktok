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
function saveConfig(cfg){fs.writeFileSync(CONFIG_FILE,JSON.stringify(cfg,null,2),'utf8')}
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
if(!cfg.server||!cfg.username||!cfg.adminPassword){console.error('Dados obrigatorios ausentes.');process.exit(1)}
saveConfig(cfg);
console.log(`Configuracao salva em: ${CONFIG_FILE}`);

const auth='Basic '+Buffer.from(`admin:${cfg.adminPassword}`).toString('base64');
async function sendRelay(event,data){
  const r=await fetch(`${cfg.server}/api/relay`,{method:'POST',headers:{'content-type':'application/json','authorization':auth},body:JSON.stringify({event,data})});
  const body=await r.json().catch(async()=>({error:await r.text().catch(()=>String(r.status))}));
  if(!r.ok){console.error(`ERRO RELAY ${r.status}:`,body.error||body);return null}
  return body;
}
async function relayGift(data){
  const body=await sendRelay('gift',data);if(!body)return;
  const q=Math.max(1,Number(data.repeatCount)||1);
  if(body.matched)console.log(`✅ ${data.user?.nickname||data.user?.uniqueId||'Usuario'} | ${data.giftName} x${q} → ${body.option?.name||'opcao'} | total ${body.option?.count??'?'}`);
  else console.log(`⚠️ Presente sem opcao configurada: ${data.giftName} x${q}`);
}
async function relayComment(data){
  const body=await sendRelay('comment',data);if(!body)return;
  if(body.matched)console.log(`💬 VOTO POR COMENTARIO: ${data.user?.nickname||data.user?.uniqueId||'Usuario'} → ${body.option?.name||'opcao'} | total ${body.option?.count??'?'}`);
}
function user(u={}){return{uniqueId:String(u.uniqueId??u.userId??''),userId:String(u.userId??u.uniqueId??''),nickname:String(u.nickname??u.uniqueId??'TikTok'),avatar:u?.profilePicture?.urls?.[0]??u?.avatarThumb?.urlList?.[0]??''}}

const connection=new TikTokLiveConnection(cfg.username,{...(cfg.signApiKey?{signApiKey:cfg.signApiKey}:{}),enableExtendedGiftInfo:true});
connection.on(WebcastEvent.GIFT,d=>{
  const details=d.giftDetails??{};
  const giftType=Number(details.giftType??d.giftType??0);
  if(giftType===1 && d.repeatEnd!==true)return;
  const repeatCount=Math.max(1,Number(d.repeatCount??1)||1);
  const giftName=String(details.giftName??d.extendedGiftInfo?.name??d.giftName??'Presente').trim();
  const giftImage=d.extendedGiftInfo?.pictureUrl??d.extendedGiftInfo?.image?.urlList?.[0]??'';
  relayGift({user:user(d.user),giftId:String(d.giftId??details.giftId??''),giftType,giftName,giftImage,repeatCount,diamondCount:Number(details.diamondCount??d.extendedGiftInfo?.diamondCount??0)}).catch(e=>console.error('Falha ao enviar presente:',e?.message||e));
});
connection.on(WebcastEvent.CHAT,d=>{
  const comment=String(d.comment??d.message??'').trim();
  if(!comment)return;
  relayComment({user:user(d.user),comment}).catch(e=>console.error('Falha ao enviar comentario:',e?.message||e));
});
connection.on(ControlEvent.CONNECTED,()=>console.log('✅ WebSocket TikTok conectado.'));
connection.on(ControlEvent.ERROR,e=>console.error('TikTok:',e?.message||e));
connection.on(ControlEvent.DISCONNECTED,()=>console.log('⚠️ LIVE desconectada.'));

try{
  const state=await connection.connect();
  console.log(`✅ CONECTADO A @${cfg.username}`);
  console.log(`Room ID: ${state?.roomId||connection.roomId||'detectado'}`);
  console.log('Presentes e comentarios da LIVE estão sendo monitorados.');
  console.log('Votos por comentário só contam quando a opção estiver habilitada no Admin.');
  console.log('Deixe esta janela aberta durante a LIVE.');
}catch(e){console.error('Falha ao conectar:',e?.message||e);process.exit(1)}
