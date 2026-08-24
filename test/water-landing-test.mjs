// 回归测试：模拟真实客户端水面降落行为，验证不会被反作弊踢出
// （复现 bug：落在水边时客户端钳制在 -0.6m 水面，与服务端水下地形校验冲突）
import { io } from 'socket.io-client';
import { Terrain } from '../shared/terrain.js';

const BASE = 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: '1234' }),
}).then(r => r.json());
if (!login.token) { console.error('登录失败'); process.exit(1); }

const socket = io(BASE, { auth: { token: login.token } });
let battle = null, terrain = null, myId = null;
const self = { x: 0, y: 400, z: 0, st: 'p', landed: false };
let rubberCount = 0, errSeen = [];
let deepWaterSpot = null;

socket.on('battle', (m) => {
  battle = m; terrain = new Terrain(m.map.seed, m.map.size);
  log('战斗开始，寻找深水降落点…');
  // 找一个深水点（terrain < -4）
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * Math.PI * 2, r = 300 + Math.random() * 80;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (terrain.height(x, z) < -4) { deepWaterSpot = { x, z }; break; }
  }
  log('深水点:', deepWaterSpot);
  setTimeout(() => socket.emit('jump'), 3000);
});
socket.on('battle:you', (m) => { myId = m.id; });
socket.on('rubber', () => { rubberCount++; });
socket.on('err', (m) => { errSeen.push(m.msg); log('!! 收到错误:', m.msg); });
socket.on('snap', (m) => {
  const me = m.e.find(r => r[0] === myId);
  if (me) { self.x = me[1]; self.y = me[2]; self.z = me[3]; self.st = me[5]; }
});
socket.on('dead', (m) => log('阵亡:', m.rank, m.by));
socket.on('end', (m) => { log('结算: 排名', m.rank); finish(); });

// 模拟客户端物理（与 game.js 一致的关键行为：水面钳制 -0.6）
setInterval(() => {
  if (!battle || !myId || self.st === 'p') return;
  if (!self.landed) {
    const g = terrain.height(self.x, self.z);
    const landY = Math.max(g, -0.6);
    if (self.st === 'f') {
      self.y = Math.max(self.y - 2.7, landY);
      if (self.y - g < 125) self.st = 'c';
    } else if (self.st === 'c') {
      self.y = Math.max(self.y - 0.35, landY);
    }
    if (self.y <= landY + 0.001) { self.y = landY; self.st = 'g'; self.landed = true; log('✓ 落水（水面漂浮）位置', self.x.toFixed(0), self.z.toFixed(0)); }
  } else {
    self.y = Math.max(terrain.height(self.x, self.z), -0.6); // 游泳钳制
    // 缓慢朝岸边游
    const d = Math.hypot(self.x, self.z) || 1;
    self.x -= self.x / d * 0.2;
    self.z -= self.z / d * 0.2;
  }
  socket.emit('s', { x: +self.x.toFixed(2), y: +self.y.toFixed(2), z: +self.z.toFixed(2), yaw: 0, pitch: 0, st: self.st, cr: false, mv: !self.landed });
}, 50);

socket.emit('room:create', { mode: 'solo', scenery: 'day' }, (r) => log('房间:', r.ok, r.id || r.msg));
socket.emit('room:start', {}, () => {}); // 房主即全员就绪，直接开局

function finish() {
  setTimeout(() => {
    log('===== 结果 =====');
    log('rubber 次数:', rubberCount, '| 错误:', errSeen.length ? errSeen : '无', '| 被踢:', errSeen.some(e => e.includes('移出')));
    socket.disconnect();
    process.exit(errSeen.some(e => e.includes('移出')) ? 1 : 0);
  }, 1000);
}
setTimeout(() => { log('测试窗口结束'); finish(); }, 120000);
