import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });

const PORT = Number(process.env.PORT || 3000);
const PASS = String(process.env.ADMIN_PASSWORD || '');
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

app.use(express.json({ limit: '160mb' }));
app.use(express.static('.', { index: 'index.html' }));

const FONT_IDS = ['Bangers','Luckiest Guy','Bowlby One SC','Black Ops One','Russo One','Titan One','Anton','Lilita One'];
const recentGiftIds = new Map();
const recentSingleGifts = new Map();
const comboState = new Map();

function defaults() {
  return {
    battle: {
      title: 'BATALHA DAS OPÇÕES',
      subtitle: 'Envie presentes para a sua opção favorita!',
      backgroundImage: '',
      titleFont: 'Bangers',
      titleSize: 40,
      championLabel: '★ VENCEDOR DA BATALHA ★',
      showTimer: false,
      commentVoting: false
    },
    timer: { elapsedMs: 0, running: false, startedAt: null },
    options: [
      { id: crypto.randomUUID(), name: 'Opção A', image: '', giftIcon: '', color: '#ffcc00', gifts: 'Rosa, Coração', giftIds: '', count: 0 },
      { id: crypto.randomUUID(), name: 'Opção B', image: '', giftIcon: '', color: '#9aa7b3', gifts: 'Café, Perfume', giftIds: '', count: 0 }
    ],
    lastGift: null,
    giftHistory: [],
    giftCatalog: []
  };
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const d = defaults();
    return {
      ...d,
      ...saved,
      battle: { ...d.battle, ...(saved.battle || {}), showTimer: false },
      timer: { elapsedMs: Math.max(0, Number(saved.timer?.elapsedMs) || 0), running: false, startedAt: null },
      giftHistory: Array.isArray(saved.giftHistory) ? saved.giftHistory : [],
      giftCatalog: Array.isArray(saved.giftCatalog) ? saved.giftCatalog : []
    };
  } catch {
    return defaults();
  }
}

let state = load();

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('Não foi possível persistir estado:', e.message);
  }
}

function auth(req, res, next) {
  if (!PASS && !PROD) return next();
  if (!PASS) return res.status(503).send('ADMIN_PASSWORD não configurada');
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Batalha Admin"');
    return res.status(401).end();
  }
  try {
    const d = Buffer.from(h.slice(6), 'base64').toString();
    const i = d.indexOf(':');
    const u = d.slice(0, i);
    const p = d.slice(i + 1);
    const a = Buffer.from(p);
    const b = Buffer.from(PASS);
    if (u === 'admin' && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  } catch {}
  res.set('WWW-Authenticate', 'Basic realm="Batalha Admin"');
  res.status(401).end();
}

function send(type, payload = {}) {
  const msg = JSON.stringify({ type, ...payload, at: Date.now() });
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function norm(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function giftNames(s = '') { return String(s).split(',').map(norm).filter(Boolean); }
function giftIds(s = '') { return String(s).split(',').map(x => String(x).trim()).filter(Boolean); }

function cleanOption(o = {}) {
  return {
    id: String(o.id || crypto.randomUUID()),
    name: String(o.name || 'Opção').trim().slice(0, 80),
    image: String(o.image || '').slice(0, 12000000),
    giftIcon: String(o.giftIcon || '').slice(0, 5000000),
    color: /^#[0-9a-f]{6}$/i.test(String(o.color || '')) ? String(o.color) : '#2f7cff',
    gifts: String(o.gifts || '').trim().slice(0, 1500),
    giftIds: String(o.giftIds || '').replace(/[^0-9, ]/g, '').slice(0, 1500),
    count: Math.max(0, Number(o.count) || 0)
  };
}

function cleanBattle(b = {}) {
  const f = FONT_IDS.includes(String(b.titleFont)) ? String(b.titleFont) : 'Bangers';
  const sz = Math.max(24, Math.min(48, Number(b.titleSize) || 40));
  return {
    title: String(b.title || 'BATALHA DAS OPÇÕES').trim().slice(0, 100),
    subtitle: String(b.subtitle || 'Envie presentes para a sua opção favorita!').trim().slice(0, 180),
    backgroundImage: String(b.backgroundImage || '').slice(0, 12000000),
    titleFont: f,
    titleSize: sz,
    championLabel: String(b.championLabel || '★ VENCEDOR DA BATALHA ★').trim().slice(0, 80),
    showTimer: b.showTimer === true,
    commentVoting: b.commentVoting === true
  };
}

function validateGiftMap(options) {
  const usedNames = new Map(), usedIds = new Map();
  for (const o of options) {
    for (const g of giftNames(o.gifts)) {
      if (usedNames.has(g) && usedNames.get(g) !== o.name) return `O presente "${g}" está configurado em mais de uma opção.`;
      usedNames.set(g, o.name);
    }
    for (const id of giftIds(o.giftIds)) {
      if (usedIds.has(id) && usedIds.get(id) !== o.name) return `O Gift ID "${id}" está configurado em mais de uma opção.`;
      usedIds.set(id, o.name);
    }
  }
  return null;
}

function validateOptionNames(options) {
  const used = new Map();
  for (const o of options) {
    const n = norm(o.name);
    if (!n) return 'Todas as opções precisam ter nome.';
    if (used.has(n)) return `Existem duas opções com o mesmo nome: "${o.name}".`;
    used.set(n, true);
  }
  return null;
}

function timerSnapshot() {
  return {
    elapsedMs: state.timer.elapsedMs + (state.timer.running && state.timer.startedAt ? Date.now() - state.timer.startedAt : 0),
    running: state.timer.running,
    startedAt: state.timer.startedAt
  };
}

function countSnapshot() {
  return state.options.map(o => ({ id: o.id, count: Math.max(0, Number(o.count) || 0) }));
}

function cleanupDedupeMaps(now = Date.now()) {
  if (recentGiftIds.size > 2000) for (const [k, t] of recentGiftIds) if (now - t > 120000) recentGiftIds.delete(k);
  if (recentSingleGifts.size > 2000) for (const [k, t] of recentSingleGifts) if (now - t > 5000) recentSingleGifts.delete(k);
  if (comboState.size > 2000) for (const [k, v] of comboState) if (now - v.at > 15000) comboState.delete(k);
}

function giftIncrement(data, giftId, giftName, user) {
  const now = Date.now();
  cleanupDedupeMaps(now);

  const explicitId = String(data.eventId || data.msgId || data.messageId || data.logId || data.event_id || '').trim();
  if (explicitId) {
    if (recentGiftIds.has(explicitId)) return 0;
    recentGiftIds.set(explicitId, now);
  }

  const who = String(user.userId || user.uniqueId || user.nickname || 'anon');
  const what = giftId || norm(giftName) || 'gift';
  const repeat = Math.max(1, Number(data.repeatCount || 1) || 1);
  const comboKey = `${who}|${what}`;

  if (repeat > 1) {
    const prev = comboState.get(comboKey);
    let delta = repeat;
    if (prev && now - prev.at < 10000 && repeat >= prev.repeat) delta = repeat - prev.repeat;
    comboState.set(comboKey, { repeat, at: now });
    return Math.max(0, delta);
  }

  comboState.set(comboKey, { repeat: 1, at: now });

  if (!explicitId) {
    const sourceTime = String(data.createTime || data.timestamp || data.eventTime || '').trim();
    const key = `${who}|${what}|${repeat}|${sourceTime}`;
    const prev = recentSingleGifts.get(key);
    if (prev && now - prev < 450) return 0;
    recentSingleGifts.set(key, now);
  }

  return 1;
}

function registerGift(data = {}) {
  const giftName = String(data.giftName || '').trim();
  const giftId = String(data.giftId || '').trim();
  if (!giftName && !giftId) return { matched: false };

  let opt = giftId ? state.options.find(o => giftIds(o.giftIds).includes(giftId)) : null;
  if (!opt && giftName) opt = state.options.find(o => giftNames(o.gifts).includes(norm(giftName)));
  if (!opt) return { matched: false, giftName, giftId };

  const u = data.user || {};
  const increment = giftIncrement(data, giftId, giftName, u);
  if (increment <= 0) {
    console.log('🎁 PRESENTE DUPLICADO IGNORADO |', u.nickname || u.uniqueId || 'TikTok', '|', giftName || giftId);
    return { matched: true, duplicate: true, ignored: true, option: opt };
  }

  const entry = {
    id: crypto.randomUUID(),
    source: 'gift',
    optionId: opt.id,
    optionName: opt.name,
    giftId,
    giftName: giftName || `Gift ${giftId}`,
    giftImage: String(data.giftImage || ''),
    repeatCount: increment,
    user: {
      uniqueId: String(u.uniqueId || ''),
      userId: String(u.userId || ''),
      nickname: String(u.nickname || u.uniqueId || 'TikTok'),
      avatar: String(u.avatar || '')
    },
    at: Date.now()
  };

  opt.count += increment;
  state.lastGift = entry;
  state.giftHistory.unshift(entry);
  if (state.giftHistory.length > 500) state.giftHistory.length = 500;
  persist();
  send('gift', { counts: countSnapshot(), timer: timerSnapshot(), lastGift: entry });
  return { matched: true, option: opt, lastGift: entry, increment };
}

function registerCommentVote(data = {}) {
  if (state.battle.commentVoting !== true) return { matched: false, disabled: true };
  const comment = String(data.comment || '').trim();
  if (!comment) return { matched: false };
  const opt = state.options.find(o => norm(o.name) === norm(comment));
  if (!opt) return { matched: false, comment };
  const u = data.user || {};
  const entry = {
    id: crypto.randomUUID(), source: 'comment', optionId: opt.id, optionName: opt.name,
    giftId: '', giftName: 'Comentário', giftImage: '', repeatCount: 1, comment,
    user: { uniqueId: String(u.uniqueId || ''), userId: String(u.userId || ''), nickname: String(u.nickname || u.uniqueId || 'TikTok'), avatar: String(u.avatar || '') },
    at: Date.now()
  };
  opt.count++;
  state.giftHistory.unshift(entry);
  if (state.giftHistory.length > 500) state.giftHistory.length = 500;
  persist();
  send('commentVote', { counts: countSnapshot(), timer: timerSnapshot(), vote: entry });
  return { matched: true, option: opt, vote: entry };
}

function saveCatalog(data = {}) {
  const incoming = Array.isArray(data.gifts) ? data.gifts : [];
  const byId = new Map((state.giftCatalog || []).map(g => [String(g.id), g]));
  let added = 0, updated = 0;
  for (const raw of incoming) {
    const g = { id: String(raw.id || raw.giftId || '').trim(), name: String(raw.name || raw.giftName || '').trim(), image: String(raw.image || '') };
    if (!g.id || !g.name) continue;
    const old = byId.get(g.id);
    if (!old) { byId.set(g.id, g); added++; }
    else { byId.set(g.id, { ...old, ...g, image: g.image || old.image || '' }); updated++; }
  }
  state.giftCatalog = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).slice(0, 3000);
  persist();
  send('giftCatalog', { giftCatalog: state.giftCatalog });
  return { ok: true, count: state.giftCatalog.length, added, updated };
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: 21, giftDedupe: true }));
app.get('/api/state', (req, res) => res.json({ ...state, timer: timerSnapshot() }));
app.get('/api/gifts', auth, (req, res) => res.json({ ok: true, gifts: state.giftCatalog || [] }));
app.get('/api/gift-history', auth, (req, res) => res.json({ ok: true, history: state.giftHistory || [] }));

app.post('/api/relay', auth, (req, res) => {
  const event = String(req.body?.event || '');
  if (event === 'gift') return res.json({ ok: true, ...registerGift(req.body?.data || {}) });
  if (event === 'comment') return res.json({ ok: true, ...registerCommentVote(req.body?.data || {}) });
  if (event === 'giftCatalog') return res.json(saveCatalog(req.body?.data || {}));
  return res.status(400).json({ ok: false, error: 'Evento não suportado' });
});

app.post('/api/config', auth, (req, res) => {
  const raw = Array.isArray(req.body?.options) ? req.body.options : [];
  if (!raw.length) return res.status(400).json({ ok: false, error: 'Crie pelo menos uma opção' });
  if (raw.length > 6) return res.status(400).json({ ok: false, error: 'O máximo é 6 opções' });
  const options = raw.map(cleanOption);
  const battle = cleanBattle(req.body?.battle || {});
  const mapError = validateGiftMap(options);
  if (mapError) return res.status(400).json({ ok: false, error: mapError });
  if (battle.commentVoting === true) {
    const nameError = validateOptionNames(options);
    if (nameError) return res.status(400).json({ ok: false, error: nameError });
  } else {
    for (const o of options) if (!norm(o.name)) return res.status(400).json({ ok: false, error: 'Todas as opções precisam ter nome.' });
  }
  state.battle = battle;
  state.options = options;
  persist();
  send('state', { ...state, timer: timerSnapshot() });
  res.json({ ok: true, savedOptions: state.options.length, ...state, timer: timerSnapshot() });
});

app.post('/api/cleanup', auth, (req, res) => {
  const mode = String(req.body?.mode || 'safe');
  const before = Buffer.byteLength(JSON.stringify(state), 'utf8');
  state.lastGift = null;
  state.giftHistory = [];
  state.giftCatalog = (state.giftCatalog || []).map(g => ({ ...g, image: '' }));
  if (mode === 'heavy') {
    state.battle = { ...state.battle, backgroundImage: '' };
    state.options = (state.options || []).map(o => ({ ...o, image: '', giftIcon: '' }));
  }
  persist();
  const after = Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (mode === 'heavy') send('state', { ...state, timer: timerSnapshot() });
  res.json({ ok: true, mode, beforeBytes: before, afterBytes: after, freedBytes: Math.max(0, before - after) });
});

app.post('/api/reset', auth, (req, res) => {
  for (const o of state.options) o.count = 0;
  state.lastGift = null;
  state.giftHistory = [];
  recentGiftIds.clear(); recentSingleGifts.clear(); comboState.clear();
  persist();
  send('state', { ...state, timer: timerSnapshot() });
  res.json({ ok: true });
});

app.post('/api/reset-all', auth, (req, res) => {
  const catalog = state.giftCatalog || [];
  state = defaults();
  state.giftCatalog = catalog;
  recentGiftIds.clear(); recentSingleGifts.clear(); comboState.clear();
  persist();
  send('state', { ...state, timer: timerSnapshot() });
  res.json({ ok: true, ...state, timer: timerSnapshot() });
});

app.post('/api/manual', auth, (req, res) => {
  const id = String(req.body?.id || '');
  const amount = Math.max(1, Math.min(999, Number(req.body?.amount || 1)));
  const opt = state.options.find(o => o.id === id);
  if (!opt) return res.status(404).json({ ok: false, error: 'Opção não encontrada' });
  opt.count += amount;
  const giftName = String(opt.gifts || '').split(',')[0]?.trim() || 'Presente de teste';
  const giftId = giftIds(opt.giftIds)[0] || 'admin-test';
  const entry = {
    id: crypto.randomUUID(), source: 'gift', optionId: opt.id, optionName: opt.name,
    giftId, giftName, giftImage: opt.giftIcon || '', repeatCount: amount,
    user: { uniqueId: 'admin-teste', userId: 'admin-teste', nickname: 'Teste Admin', avatar: '' }, at: Date.now()
  };
  state.lastGift = entry;
  persist();
  send('gift', { counts: countSnapshot(), timer: timerSnapshot(), lastGift: entry });
  res.json({ ok: true, option: opt, lastGift: entry });
});

app.post('/api/timer', auth, (req, res) => {
  const action = String(req.body?.action || '');
  if (action === 'play') {
    if (!state.timer.running) { state.timer.running = true; state.timer.startedAt = Date.now(); }
  } else if (action === 'pause') {
    if (state.timer.running && state.timer.startedAt) state.timer.elapsedMs += Date.now() - state.timer.startedAt;
    state.timer.running = false; state.timer.startedAt = null;
  } else if (action === 'reset') {
    state.timer.elapsedMs = 0; state.timer.running = false; state.timer.startedAt = null;
  } else return res.status(400).json({ ok: false, error: 'Ação inválida' });
  persist();
  const timer = timerSnapshot();
  send('timer', { timer });
  res.json({ ok: true, timer });
});

app.post('/api/champion', auth, (req, res) => {
  if (!state.options.length) return res.status(400).json({ ok: false, error: 'Sem opções' });
  const max = Math.max(...state.options.map(o => Number(o.count) || 0));
  const leaders = state.options.filter(o => (Number(o.count) || 0) === max);
  if (max <= 0) return res.status(400).json({ ok: false, error: 'Ainda não há pontos' });
  if (leaders.length !== 1) return res.status(400).json({ ok: false, error: 'Há empate no primeiro lugar' });
  const champion = { ...leaders[0], championLabel: state.battle.championLabel };
  send('champion', { champion });
  res.json({ ok: true, champion });
});

wss.on('connection', ws => ws.send(JSON.stringify({ type: 'state', ...state, timer: timerSnapshot() })));
server.listen(PORT, '0.0.0.0', () => {
  persist();
  console.log(`Batalha de Opções rodando na porta ${PORT} | anti-duplicação de presentes ATIVA`);
});
