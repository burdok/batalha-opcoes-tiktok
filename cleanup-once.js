import fs from 'fs';
import path from 'path';

const DATA_DIR=process.env.DATA_DIR||path.join(process.cwd(),'data');
const STATE_FILE=path.join(DATA_DIR,'state.json');
const MARKER_FILE=path.join(DATA_DIR,'.emergency-cleanup-v1');

function bytes(v){try{return Buffer.byteLength(JSON.stringify(v),'utf8')}catch{return 0}}

try{
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(fs.existsSync(MARKER_FILE)){
    console.log('[cleanup] Limpeza de emergencia ja executada anteriormente.');
    process.exit(0);
  }

  if(!fs.existsSync(STATE_FILE)){
    fs.writeFileSync(MARKER_FILE,new Date().toISOString(),'utf8');
    console.log('[cleanup] Nenhum state.json encontrado. Nada para limpar.');
    process.exit(0);
  }

  const state=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
  const before=bytes(state);

  state.lastGift=null;
  state.giftHistory=[];
  state.giftCatalog=Array.isArray(state.giftCatalog)?state.giftCatalog.map(g=>({...g,image:''})):[];

  if(state.battle) state.battle={...state.battle,backgroundImage:''};
  state.options=Array.isArray(state.options)?state.options.map(o=>({...o,image:'',giftIcon:''})):[];
  state.savedPresets=Array.isArray(state.savedPresets)?state.savedPresets.map(p=>({
    ...p,
    battle:{...(p.battle||{}),backgroundImage:''},
    options:Array.isArray(p.options)?p.options.map(o=>({...o,image:'',giftIcon:''})):[]
  })):[];

  fs.writeFileSync(STATE_FILE,JSON.stringify(state),'utf8');
  fs.writeFileSync(MARKER_FILE,new Date().toISOString(),'utf8');

  const after=bytes(state);
  const freed=Math.max(0,before-after);
  console.log(`[cleanup] LIMPEZA DE EMERGENCIA CONCLUIDA. Liberados aproximadamente ${(freed/1048576).toFixed(2)} MB do estado.`);
}catch(e){
  console.error('[cleanup] Falha na limpeza de emergencia:',e.message);
  process.exitCode=1;
}
