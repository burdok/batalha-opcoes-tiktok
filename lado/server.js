import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });
const PORT = Number(process.env.PORT || 3100);

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public', { index: 'index.html' }));

const attacks = {
  drone: { label: 'DRONE', damage: 150, icon: '🚁' },
  bomb: { label: 'BOMBA', damage: 300, icon: '💣' },
  missile: { label: 'MÍSSIL', damage: 500, icon: '🚀' },
  air: { label: 'ATAQUE AÉREO', damage: 250, icon: '✈️' },
  special: { label: 'ATAQUE ESPECIAL', damage: 800, icon: '☢️' }
};

let state = {
  title: 'BATALHA',
  maxHp: 10000,
  winner: null,
  sides: {
    A: { name: 'LADO A', hp: 10000, color: '#1597ff', image: '' },
    B: { name: 'LADO B', hp: 10000, color: '#ff3131', image: '' }
  },
  lastAttack: null,
  history: []
};

function broadcast(type, extra = {}) {
  const msg = JSON.stringify({ type, state, ...extra, at: Date.now() });
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function attack(from, type) {
  if (!['A', 'B'].includes(from)) throw new Error('Lado inválido');
  if (!attacks[type]) throw new Error('Ataque inválido');
  if (state.winner) throw new Error('A batalha já terminou');
  const to = from === 'A' ? 'B' : 'A';
  const atk = attacks[type];
  state.sides[to].hp = Math.max(0, state.sides[to].hp - atk.damage);
  state.lastAttack = { from, to, type, ...atk, at: Date.now() };
  state.history.unshift(state.lastAttack);
  state.history = state.history.slice(0, 20);
  if (state.sides[to].hp <= 0) state.winner = from;
  broadcast('attack', { attack: state.lastAttack });
  return state.lastAttack;
}

app.get('/api/state', (req, res) => res.json({ state, attacks }));
app.post('/api/attack', (req, res) => {
  try { res.json({ ok: true, attack: attack(String(req.body?.from || ''), String(req.body?.type || '')) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/reset', (req, res) => {
  state.sides.A.hp = state.maxHp;
  state.sides.B.hp = state.maxHp;
  state.winner = null;
  state.lastAttack = null;
  state.history = [];
  broadcast('state');
  res.json({ ok: true, state });
});
app.post('/api/config', (req, res) => {
  const body = req.body || {};
  state.title = String(body.title || state.title).slice(0, 60);
  state.maxHp = Math.max(100, Math.min(100000, Number(body.maxHp || state.maxHp)));
  for (const key of ['A', 'B']) {
    const s = body.sides?.[key] || {};
    state.sides[key].name = String(s.name || state.sides[key].name).slice(0, 40);
    state.sides[key].color = /^#[0-9a-f]{6}$/i.test(String(s.color || '')) ? s.color : state.sides[key].color;
    state.sides[key].image = String(s.image || state.sides[key].image || '').slice(0, 4000000);
    state.sides[key].hp = Math.min(state.sides[key].hp, state.maxHp);
  }
  broadcast('state');
  res.json({ ok: true, state });
});

wss.on('connection', ws => ws.send(JSON.stringify({ type: 'state', state, attacks })));
server.listen(PORT, '0.0.0.0', () => console.log(`LADO rodando em http://0.0.0.0:${PORT}`));
