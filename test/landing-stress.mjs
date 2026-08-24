// 落地全场景回归测试：早跳重试 / 正常落地 / 后台标签页冻结 / 水面降落
// 模拟真实客户端物理（与 public/js/game.js 一致），验证绝不出现回弹死循环或被踢
import { io } from 'socket.io-client';
import { Terrain } from '../shared/terrain.js';

const BASE = 'http://localhost:8080';
const SCENARIO = process.argv[2] || 'normal'; // normal | early | freeze | water | lag
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: '1234' }),
}).then(r => r.json());
if (!login.token) { console.error('登录失败'); process.exit(1); }

const socket = io(BASE, { auth: { token: login.token } });
let terrain = null, myId = null;
const self = { x: 0, y: 400, z: 0, st: 'p', vy: 0, landed: false };
let rubberCount = 0, kicked = false, landedAt = 0, groundY = 0;

socket.on('battle', (m) => {
  terrain = new Terrain(m.map.seed, m.map.size);
  log(`[${SCENARIO}] 战斗开始`);
  if (SCENARIO === 'early') socket.emit('jump'); // 战斗一开始就跳（服务器可能还没就绪）
  else setTimeout(() => socket.emit('jump'), 4000); // 模拟真实玩家：4 秒后跳伞
});
socket.on('battle:you', (m) => { myId = m.id; });
socket.on('rubber', (m) => {
  rubberCount++;
  const d = Math.hypot(m.x - self.x, m.y - self.y, m.z - self.z);
  if (d > 2) { // 客户端回弹处理（同 game.js：恢复下落姿态）
    self.x = m.x; self.y = m.y; self.z = m.z;
    const g = terrain.height(m.x, m.z);
    if (self.st !== 'p' && m.y - Math.max(g, -0.6) > 3) {
      self.st = m.y - g < 135 ? 'c' : 'f';
      self.vy = self.st === 'c' ? -7 : -15;
      log(`  回弹恢复下落姿态 st=${self.st} y=${m.y.toFixed(0)}`);
    }
  }
});
socket.on('err', (m) => { if (m.msg.includes('移出')) { kicked = true; log('!! 被踢:', m.msg); } });
socket.on('snap', (m) => {
  const me = m.e.find(r => r[0] === myId);
  if (me) {
    // 客户端只参考服务器状态机（f→c→g 单向），不信服务器位置
    if (me[5] === 'f' && self.st === 'p') self.st = 'f';
    if (me[5] === 'c' && self.st === 'f') self.st = 'c';
  }
});
let ended = false;
socket.on('dead', () => {});
socket.on('end', () => { ended = true; finish('对局结束'); });

let frozen = false;
let freezeUntil = 0;

// lag 场景：随机卡顿（0.3~2 秒冻结，模拟低配机器/人多掉帧/网络抖动）
function lagGate() {
  if (SCENARIO !== 'lag') return false;
  if (frozen) {
    if (Date.now() < freezeUntil) return true;
    frozen = false;
    // 冻结期间物理照走（画面卡但游戏时间流逝），回来时位置已前进
    const g = Math.max(terrain.height(self.x, self.z), -0.6);
    if (!self.landed) {
      const drop = (freezeUntil - self._frzAt) / 1000 * (self.st === 'f' ? 40 : 7);
      self.y = Math.max(self.y - drop, g);
      if (self.y <= g + 0.001) { self.y = g; self.st = 'g'; self.landed = true; landedAt = Date.now(); log(`✓ (冻结中)落地 y=${g.toFixed(1)}`); }
    }
    return false;
  }
  if (Math.random() < 0.06) {
    frozen = true; self._frzAt = Date.now();
    freezeUntil = Date.now() + 300 + Math.random() * 1700;
  }
  return false;
}

// 客户端物理循环（20Hz 上报，60Hz 物理 → 合并为 50ms 步进近似）
setInterval(() => {
  if (!terrain || !myId) return;
  const now = Date.now();

  if (self.st === 'p') {
    if (SCENARIO === 'early') socket.emit('jump'); // 重试跳伞
    return;
  }
  if (lagGate()) return; // 卡顿冻结中不上报
  if (frozen) {
    if (now < freezeUntil) return; // 模拟后台标签页：rAF 停止，不上报
    frozen = false;
    log('  解除冻结（模拟回到前台），客户端已在地面继续上报');
    self.st = 'g'; // 冻结期间"掉落完成"
    self.y = Math.max(terrain.height(self.x, self.z), -0.6);
  }

  if (!self.landed) {
    const g = terrain.height(self.x, self.z);
    const landY = Math.max(g, -0.6);
    if (SCENARIO === 'freeze' && self.st === 'c' && self.y < g + 60 && !frozen && freezeUntil === 0) {
      // 快落地时切后台 8 秒：回来时人已在地面
      frozen = true; freezeUntil = now + 8000;
      self.y = landY; // 冻结期间继续落完（页面看不见但物理没跑——回来时直接在地面）
      log('  冻结开始（模拟切后台 8s）');
      return;
    }
    if (self.st === 'f') {
      self.vy = Math.max(self.vy - 1.5, -2.75);
      self.y = Math.max(self.y + self.vy, landY);
      if (self.y - g < 125) self.st = 'c';
    } else if (self.st === 'c') {
      self.y = Math.max(self.y - 0.35, landY);
    }
    if (self.y <= landY + 0.001) {
      self.y = landY; self.st = 'g'; self.landed = true; landedAt = now; groundY = landY;
      log(`✓ 落地 y=${landY.toFixed(1)} 地形=${g.toFixed(1)} ${g < 0 ? '(水面)' : '(陆地)'}`);
    }
  } else {
    self.y = Math.max(terrain.height(self.x, self.z), -0.6);
  }
  socket.emit('s', {
    x: +self.x.toFixed(2), y: +self.y.toFixed(2), z: +self.z.toFixed(2),
    yaw: 0, pitch: 0, st: self.st, cr: false, mv: false,
  });
  // 落地 20 秒后仍稳定 → 通过
  if (self.landed && now - landedAt > 20000) finish('落地后稳定存活 20s');
}, 50);

function finish(reason) {
  log('===== 结果 =====');
  log(`场景=${SCENARIO} ${reason}`);
  log(`回弹次数=${rubberCount} 被踢=${kicked} 最终状态=${self.st} y=${self.y.toFixed(1)}`);
  const pass = !kicked && rubberCount < 15 && (self.landed || ended);
  log(pass ? '✅ 通过' : '❌ 失败');
  socket.disconnect();
  process.exit(pass ? 0 : 1);
}

socket.emit('room:create', { mode: 'solo', scenery: 'day' }, (r) => log('房间:', r.ok ? r.id : r.msg));
setTimeout(() => finish('超时'), 150000);
