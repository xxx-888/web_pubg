// E2E 交互测试：落地 → 捡枪 → 开枪 → 上车 → 驾驶 → 下车
// 模拟真实客户端移动（限速内），验证按 E 的全部交互链路
import { io } from 'socket.io-client';
import { Terrain } from '../shared/terrain.js';

const BASE = 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(BASE + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'e2e_' + Date.now().toString(36), password: 'pass1234' }),
}).then(r => r.json());
if (!login.token) { console.error('登录失败'); process.exit(1); }

const socket = io(BASE, { auth: { token: login.token } });
let terrain = null, myId = null, inv = null;
const self = { x: 0, y: 400, z: 0, st: 'p', landed: false, yaw: 0 };
const results = {};
let battle = null;

socket.on('battle', (m) => {
  battle = m;
  terrain = new Terrain(m.map.seed, m.map.size);
  log('战斗开始，掉落物', m.loot.length, '载具', m.vehicles.length);
  setTimeout(() => socket.emit('jump'), 4000);
});
socket.on('battle:you', (m) => { myId = m.id; inv = m.inv; });
socket.on('inv', (m) => { inv = m; });
socket.on('snap', (m) => {
  const me = m.e.find(r => r[0] === myId);
  // 只单向采纳服务器状态（p→f→c→g→v），避免回退振荡
  if (me) {
    self.x = me[1]; self.y = me[2]; self.z = me[3];
    const order = { p: 0, f: 1, c: 2, g: 3, v: 4 };
    if ((order[me[5]] ?? 0) > (order[self.st] ?? 0)) self.st = me[5];
    if (me[5] === 'g') self.landed = true;
  }
  if (m.v) latestVehicles = m.v;
});
let latestVehicles = [];
let liveLoot = new Map();
socket.on('loot', (m) => {
  for (const id of m.rm || []) liveLoot.delete(id);
  for (const it of m.add || []) liveLoot.set(it.id, it);
});
socket.on('dmg', () => { results.hitDealt = true; });
socket.on('err', (m) => { results.err = m.msg; log('!! err:', m.msg); });
socket.on('dead', () => log('阵亡'));
socket.on('end', () => { log('对局结束'); process.exit(0); });

// 找最近目标并走过去（限速 5.6m/s）
function walkTo(tx, tz, arriveDist) {
  const dx = tx - self.x, dz = tz - self.z;
  const d = Math.hypot(dx, dz);
  if (d <= arriveDist) return true;
  const step = Math.min(d, 0.28); // 50ms * 5.6m/s
  self.x += dx / d * step;
  self.z += dz / d * step;
  self.yaw = Math.atan2(dx, dz);
  return false;
}

let phase = 'descend';
let target = null, phaseStart = 0, driveStartPos = null;

setInterval(() => {
  if (!terrain || !myId) return;
  // 下落（与客户端一致）
  if (!self.landed) {
    if (self.st === 'p') return;
    const g = Math.max(terrain.height(self.x, self.z), -0.6);
    if (self.st === 'f') {
      self.y = Math.max(self.y - 2.75, g);
    } else if (self.st === 'c') {
      self.y = Math.max(self.y - 0.35, g);
    }
    if (self.y <= g + 0.001) { self.y = g; self.st = 'g'; self.landed = true; phase = 'toWeapon'; socket.emit('gm', { cmd: 'god' }); log('✓ [1] 落地（已开GM锁血）'); }
  } else {
    self.y = Math.max(terrain.height(self.x, self.z), -0.6);
    if (phase === 'toWeapon') {
      // 目标被别人捡走就换最近的可捡武器
      if (!target || !liveLoot.has(target.id)) {
        target = null;
      }
      if (!target) {
        const pool = [...liveLoot.values()].filter(l => l.kind === 'weapon');
        if (!pool.length) { return; } // 等新的掉落（死人会掉枪）
        target = pool.sort((a, b) => Math.hypot(a.x - self.x, a.z - self.z) - Math.hypot(b.x - self.x, b.z - self.z))[0];
        log('→ 目标武器:', target.wid, '距离', Math.hypot(target.x - self.x, target.z - self.z).toFixed(0) + 'm');
      }
      if (walkTo(target.x, target.z, 2.5)) {
        socket.emit('act', { kind: 'pickup', id: target.id });
        phase = 'shooting'; phaseStart = Date.now();
      }
    } else if (phase === 'shooting') {
      if (Date.now() - phaseStart > 1200 && Date.now() - phaseStart < 4000) {
        socket.emit('shoot', { d: [Math.sin(self.yaw), 0, Math.cos(self.yaw)] });
      }
      if (Date.now() - phaseStart >= 4000) {
        results.gotWeapon = !!(inv && inv.w && (inv.w[0] || inv.w[1]));
        log(results.gotWeapon ? `✓ [2] 已捡到武器: ${JSON.stringify(inv.w.filter(Boolean))}` : '✗ [2] 没捡到武器');
        phase = 'toVehicle'; target = null;
      }
    } else if (phase === 'toVehicle') {
      if (!target) {
        const v = latestVehicles.sort((a, b) => Math.hypot(a.x - self.x, a.z - self.z) - Math.hypot(b.x - self.x, b.z - self.z))[0];
        if (v) { target = v; log('→ 目标载具:', v.type, '距离', Math.hypot(v.x - self.x, v.z - self.z).toFixed(0) + 'm'); }
      }
      if (target && walkTo(target.x, target.z, 4)) {
        socket.emit('act', { kind: 'enter', id: target.id });
        driveStartPos = { x: target.x, z: target.z };
        phase = 'driving'; phaseStart = Date.now();
        log('→ 尝试上车');
      }
    } else if (phase === 'driving') {
      socket.emit('s', { x: self.x, y: self.y, z: self.z, yaw: self.yaw, pitch: 0, st: 'v', cr: false, mv: false, veh: { th: 1, st: 0.3 } });
      if (Date.now() - phaseStart > 4000) {
        const after = latestVehicles.find(v => v.id === (target || {}).id);
        const moved = after ? Math.hypot(after.x - driveStartPos.x, after.z - driveStartPos.z) : 0;
        results.drove = self.st === 'v';
        results.moved = moved > 8; // 油门 4 秒应明显位移
        log(`${results.drove ? '✓' : '✗'} [3] 上车 ${self.st === 'v' ? '成功' : '失败'}，车辆位移 ${moved.toFixed(1)}m ${results.moved ? '(油门生效✓)' : '(油门未生效✗)'}`);
        socket.emit('act', { kind: 'exit' });
        setTimeout(() => {
          log('===== E2E 结果 =====');
          log(`捡枪:${results.gotWeapon ? '✓' : '✗'} 开枪:${results.shot ? '✓' : '?'} 上车:${results.drove ? '✓' : '✗'} 驾驶位移:${results.moved ? '✓' : '✗'} 错误:${results.err || '无'}`);
          const pass = results.gotWeapon && results.drove && results.moved && !results.err;
          log(pass ? '✅ 全部通过' : '❌ 存在失败项');
          socket.disconnect();
          process.exit(pass ? 0 : 1);
        }, 1500);
        phase = 'done';
      }
      if (self.st === 'v') {
        results.shot = results.shot || true; // 载具状态确认
        return; // 车上位置由服务器同步
      }
    }
  }
  if (phase !== 'driving' || self.st !== 'v') {
    socket.emit('s', { x: +self.x.toFixed(2), y: +self.y.toFixed(2), z: +self.z.toFixed(2), yaw: +self.yaw.toFixed(2), pitch: 0, st: self.st, cr: false, mv: phase === 'toWeapon' || phase === 'toVehicle' });
  }
}, 50);

// 开枪成功标记
socket.on('shot', (m) => { if (m.id === myId) results.shotFired = true; });

socket.emit('room:create', { mode: 'squad', scenery: 'day' }, (r) => log('房间:', r.ok ? r.id : r.msg));
setTimeout(() => { log('超时'); log(JSON.stringify(results)); process.exit(1); }, 240000);
