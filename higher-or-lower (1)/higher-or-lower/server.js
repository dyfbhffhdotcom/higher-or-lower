const express = require('express'), http = require('http'), fs = require('fs');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static('public'));

const boards = JSON.parse(fs.readFileSync('boards.json', 'utf8'));
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin';
const TEAMS = ['red', 'blue', 'green'];

let S = { phase: 'lobby', b: 0, players: {}, placed: [], wrong: [], pool: [], turn: null, resolved: false, ranking: null, hist: [], last: null };
const P = () => Object.values(S.players);
const item = id => boards[S.b].items.find(i => i.id === id);

// nächstes Team, das noch Spieler mit Herzen hat
function nextTurn(from) {
  const alive = TEAMS.filter(t => P().some(p => p.team === t && p.hearts > 0));
  const i = TEAMS.indexOf(from);
  for (let k = 1; k <= 3; k++) { const t = TEAMS[(i + k + 3) % 3]; if (alive.includes(t)) return t; }
  return null;
}
function initBoard() {
  const b = boards[S.b];
  S.placed = [b.start]; S.wrong = []; S.resolved = false; S.hist = [];
  S.pool = b.items.map(i => i.id).filter(id => id !== b.start);
  S.turn = nextTurn(null);
}
function snap() {
  S.hist.push(JSON.stringify({ placed: S.placed, wrong: S.wrong, pool: S.pool, turn: S.turn, resolved: S.resolved,
    hearts: Object.fromEntries(Object.entries(S.players).map(([t, p]) => [t, p.hearts])) }));
  if (S.hist.length > 50) S.hist.shift();
}

function view(token, admin) {
  const b = boards[S.b], reveal = S.resolved || S.phase === 'finished';
  return {
    phase: S.phase, round: S.b + 1, total: boards.length, category: b.category, label: b.label || '',
    items: b.items.map(i => ({ id: i.id, name: i.name, img: i.img,
      pub: reveal || i.id === b.start, value: (reveal || i.id === b.start || admin) ? i.value : null })),
    placed: S.placed, wrong: S.wrong, pool: S.pool, turn: S.turn, resolved: S.resolved, ranking: S.ranking,
    canUndo: S.hist.length > 0, last: S.last, admin,
    players: Object.entries(S.players).map(([t, p]) => ({ token: admin ? t : undefined, name: p.name, team: p.team, hearts: p.hearts, points: p.points })),
    me: S.players[token] || null
  };
}
function push() { for (const [, s] of io.sockets.sockets) s.emit('state', view(s.data.token, !!s.data.admin)); }

io.on('connection', sock => {
  sock.on('hello', token => { sock.data.token = token; push(); });
  sock.on('join', ({ token, name, team }) => {
    if (!token || !TEAMS.includes(team)) return;
    name = String(name || '').trim().slice(0, 20); if (!name) return;
    sock.data.token = token;
    const p = S.players[token];
    if (p) { p.name = name; p.team = team; } else S.players[token] = { name, team, hearts: 2, points: 0 };
    if (S.phase === 'playing' && !S.turn) S.turn = nextTurn(null);
    push();
  });
  sock.on('auth', pw => { if (pw === ADMIN_PW) { sock.data.admin = true; sock.emit('adminOk'); push(); } else sock.emit('adminFail'); });

  // ---- nur Admin ----
  sock.on('admin', ({ a, id, gap, token, points, hearts, team }) => {
    if (!sock.data.admin) return;
    if (a !== 'place') S.last = null;
    if (a === 'start') { S.b = 0; P().forEach(p => { p.hearts = 2; }); S.phase = 'playing'; S.ranking = null; initBoard(); }
    if (a === 'place' && S.phase === 'playing' && !S.resolved && S.pool.includes(id) && Number.isInteger(gap) && gap >= 0 && gap <= S.placed.length) {
      snap();
      const v = item(id).value;
      const left = S.placed[gap - 1], right = S.placed[gap];
      const correct = (!left || item(left).value <= v) && (!right || v <= item(right).value);
      if (correct) { S.placed.splice(gap, 0, id); S.pool = S.pool.filter(x => x !== id); }
      else P().filter(p => p.team === S.turn && p.hearts > 0).forEach(p => p.hearts--);
      S.last = { name: item(id).name, correct, team: S.turn };
      S.turn = nextTurn(S.turn) || S.turn;
    }
    if (a === 'undo' && S.hist.length) {
      const h = JSON.parse(S.hist.pop());
      Object.assign(S, { placed: h.placed, wrong: h.wrong, pool: h.pool, turn: h.turn, resolved: h.resolved });
      for (const [t, hh] of Object.entries(h.hearts)) if (S.players[t]) S.players[t].hearts = hh;
    }
    if (a === 'setTurn' && TEAMS.includes(team)) S.turn = team;
    if (a === 'resolve' && S.phase === 'playing' && !S.resolved) {
      snap();
      S.placed = S.placed.concat(S.pool).sort((x, y) => item(x).value - item(y).value);
      S.pool = []; S.wrong = []; S.resolved = true;
    }
    if (a === 'endBoard' && S.phase === 'playing') {
      const levels = [...new Set(P().map(p => p.hearts))].sort((x, y) => y - x);
      P().forEach(p => { p.points += Math.max(5 - levels.indexOf(p.hearts), 0); });
      S.ranking = P().map(p => ({ name: p.name, hearts: p.hearts })).sort((x, y) => y.hearts - x.hearts);
      P().forEach(p => { p.hearts = 2; });
      if (S.b + 1 < boards.length) { S.b++; initBoard(); } else { S.phase = 'finished'; S.turn = null; }
    }
    if (a === 'setPlayer' && S.players[token]) {
      if (Number.isFinite(points)) S.players[token].points = points;
      if (Number.isFinite(hearts)) S.players[token].hearts = Math.max(0, Math.min(2, hearts));
      if (!S.turn && S.phase === 'playing') S.turn = nextTurn(null);
    }
    if (a === 'kick') delete S.players[token];
    if (a === 'reset') { P().forEach(p => { p.hearts = 2; p.points = 0; }); S = { ...S, phase: 'lobby', b: 0, placed: [], wrong: [], pool: [], turn: null, resolved: false, ranking: null, hist: [] }; }
    push();
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('läuft'));
