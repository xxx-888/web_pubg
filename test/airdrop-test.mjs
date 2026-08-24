// 空投落地检测测试：等待空投落下，验证箱子停在地面上（不低于地形/建筑地面）
import { io } from 'socket.io-client';
import { Terrain } from '../shared/terrain.js';

const BASE = 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
}).then(r => r.json());

const socket = io(BASE, { auth: { token: login.token } });
let terrain = null, myId = null;
const self = { x: 0, y: 400, z: 0, st: 'p', landed: false };
let crates = [];
let tested = 0, bad = 0, good = 0;

socket.on('battle', (m) => {
  terrain = new Terrain(m.map.seed, m.map.size);
  setTimeout(() => socket.emit('jump'), 4000);
});
socket.on('battle:you', (m) => { myId = m.id; });
socket.on('snap', (m) => {
  crates = m.air || [];
  const me = m.e.find(r => r[0] === myId);
  if (me) {
    self.x = me[1]; self.y = me[2]; self.z = me[3];
    const order = { p: 0, f: 1, c: 2, g: 3, v: 4 };
    if ((order[me[5]] ?? 0) > (order[self.st] ?? 0)) self.st = me[5];
    if (me[5] === 'g') self.landed = true;
  }
  // 检查已落地的空投：y 不得低于有效地面
  for (const row of crates) {
    const [id, x, y, z, landed] = row;
    if (!landed) continue;
    const key = id + ':landed';
    if (testedKeys.has(key)) continue;
    testedKeys.add(key);
    tested++;
    const hRaw = terrain.height(x, z);
    const inB = terrain.buildings().some(b => Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2);
    const floorY = inB ? Math.max(...terrain.buildings().filter(b => Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2).map(b => Math.max(b.y, hRaw))) : hRaw;
    const ok = y >= floorY - 0.15 && y >= hRaw - 0.15;
    if (ok) { good++; log(`✓ 空投${id} 落地 y=${y} 地形=${hRaw.toFixed(1)}${inB ? ' (建筑上)' : ''}`); }
    else { bad++; log(`✗ 空投${id} 陷入地面: y=${y} 地形=${hRaw.toFixed(1)} 有效地面=${floorY.toFixed(1)} inBuilding=${inB}`); }
  }
});
const testedKeys = new Set();

// 保持存活（挂机在地面）
setInterval(() => {
  if (!terrain || !myId) return;
  if (!self.landed) {
    if (self.st === 'p') return;
    const g = Math.max(terrain.height(self.x, self.z), -0.6);
    if (self.st === 'f') self.y = Math.max(self.y - 2.75, g);
    else if (self.st === 'c') self.y = Math.max(self.y - 0.35, g);
    if (self.y <= g + 0.001) { self.y = g; self.st = 'g'; self.landed = true; socket.emit('gm', { cmd: 'god' }); }
  } else {
    self.y = Math.max(terrain.height(self.x, self.z), -0.6);
  }
  socket.emit('s', { x: +self.x.toFixed(2), y: +self.y.toFixed(2), z: +self.z.toFixed(2), yaw: 0, pitch: 0, st: self.st, cr: false, mv: false });
}, 50);

socket.emit('room:create', { mode: 'squad', scenery: 'day' }, (r) => log('房间:', r.ok ? r.id : r.msg));

// 空投首投在开局 75 秒后，等 3 个空投或 5 分钟
setTimeout(() => {
  log('===== 空投落地测试 =====');
  log(`检测到落地空投 ${tested} 个：正常 ${good} / 陷入地面 ${bad}`);
  const pass = tested >= 1 && bad === 0;
  log(pass ? '✅ 空投全部停在地面之上' : tested === 0 ? '⚠️ 未等到空投落地' : '❌ 有空投陷入地面');
  socket.disconnect();
  process.exit(0);
}, 300000);
