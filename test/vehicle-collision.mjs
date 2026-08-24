// 载具碰撞测试：开车冲向最近建筑，验证车辆不会穿墙进入房内
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
const self = { x: 0, y: 400, z: 0, st: 'p', landed: false, yaw: 0 };
let vehicles = [], entered = false, myVeh = null, targetB = null;
let insideCount = 0, minWallDist = 1e9, droveMeters = 0, lastPos = null;
let started = false, startTs = 0;

socket.on('battle', (m) => {
  terrain = new Terrain(m.map.seed, m.map.size);
  setTimeout(() => socket.emit('jump'), 4000);
});
socket.on('battle:you', (m) => { myId = m.id; });
socket.on('snap', (m) => {
  const me = m.e.find(r => r[0] === myId);
  if (me) {
    self.x = me[1]; self.y = me[2]; self.z = me[3];
    const order = { p: 0, f: 1, c: 2, g: 3, v: 4 };
    if ((order[me[5]] ?? 0) > (order[self.st] ?? 0)) self.st = me[5];
    if (me[5] === 'g') self.landed = true;
  }
  vehicles = m.v || [];
});

function insideBuilding(x, z, margin) {
  for (const b of terrain.buildings()) {
    if (Math.abs(x - b.x) < b.w / 2 + margin && Math.abs(z - b.z) < b.d / 2 + margin) return b;
  }
  return null;
}
function wallDist(x, z) {
  let d = 1e9;
  for (const w of terrain.buildingWalls()) {
    const dx = Math.max(Math.abs(x - w.x) - w.w / 2, 0);
    const dz = Math.max(Math.abs(z - w.z) - w.d / 2, 0);
    d = Math.min(d, Math.hypot(dx, dz));
  }
  return d;
}

setInterval(() => {
  if (!terrain || !myId) return;
  if (!self.landed) {
    if (self.st === 'p') return;
    const g = Math.max(terrain.height(self.x, self.z), -0.6);
    if (self.st === 'f') self.y = Math.max(self.y - 2.75, g);
    else if (self.st === 'c') self.y = Math.max(self.y - 0.35, g);
    if (self.y <= g + 0.001) { self.y = g; self.st = 'g'; self.landed = true; socket.emit('gm', { cmd: 'god' }); }
  } else if (!entered) {
    self.y = Math.max(terrain.height(self.x, self.z), -0.6);
    if (!myVeh) {
      const v = vehicles.filter(v => v.hp > 0 && !v.drv)
        .sort((a, b) => Math.hypot(a.x - self.x, a.z - self.z) - Math.hypot(b.x - self.x, b.z - self.z))[0];
      if (v) myVeh = v;
    }
    if (myVeh) {
      const d = Math.hypot(myVeh.x - self.x, myVeh.z - self.z);
      if (d > 3) {
        const step = Math.min(d, 0.28);
        self.x += (myVeh.x - self.x) / d * step;
        self.z += (myVeh.z - self.z) / d * step;
      } else {
        socket.emit('act', { kind: 'enter', id: myVeh.id });
      }
    }
  } else {
    // 驾驶：朝目标建筑转向冲刺
    const v = vehicles.find(x => x.id === myVeh.id);
    if (!v) { finish('车辆消失'); return; }
    if (lastPos) droveMeters += Math.hypot(v.x - lastPos.x, v.z - lastPos.z);
    lastPos = { x: v.x, z: v.z };
    // 监测穿墙
    const ib = insideBuilding(v.x, v.z, -1.2); // 车中心进入墙体内部（内缩1.2m）
    if (ib) insideCount++;
    minWallDist = Math.min(minWallDist, wallDist(v.x, v.z));

    if (!targetB) {
      targetB = terrain.buildings()
        .sort((a, b) => Math.hypot(a.x - v.x, a.z - v.z) - Math.hypot(b.x - v.x, b.z - v.z))[0];
      log('→ 目标建筑:', targetB.x.toFixed(0), targetB.z.toFixed(0), '距离', Math.hypot(targetB.x - v.x, targetB.z - v.z).toFixed(0) + 'm');
    }
    const want = Math.atan2(targetB.x - v.x, targetB.z - v.z); // forward=(sin,cos)
    let diff = want - v.yaw;
    diff = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const steer = Math.abs(diff) < 0.05 ? 0 : (diff > 0 ? -1 : 1); // yaw -= st*k → 加 yaw 用负
    socket.emit('s', { x: v.x, y: v.y, z: v.z, yaw: v.yaw, pitch: 0, st: 'v', cr: false, mv: false, veh: { th: 1, st: steer } });
    const distB = Math.hypot(targetB.x - v.x, targetB.z - v.z);
    if (Date.now() - startTs > 14000 || (droveMeters > 30 && distB < Math.max(targetB.w, targetB.d) / 2 + 6)) {
      finish(`行驶${droveMeters.toFixed(0)}m 距目标${distB.toFixed(0)}m`);
    }
  }
  if (self.st !== 'v') {
    socket.emit('s', { x: +self.x.toFixed(2), y: +self.y.toFixed(2), z: +self.z.toFixed(2), yaw: 0, pitch: 0, st: self.st, cr: false, mv: !self.landed });
  }
}, 50);

socket.on('err', (m) => { log('!!', m.msg); });

function finish(info) {
  log('===== 载具碰撞测试 =====');
  log(`${info} | 穿墙帧数=${insideCount} 最近墙距=${minWallDist.toFixed(2)}m`);
  const pass = insideCount === 0 && minWallDist < 6; // 没穿墙 && 确实贴近过墙体（碰撞生效）
  log(pass ? '✅ 车辆被墙挡住，未穿墙' : insideCount > 0 ? '❌ 车辆穿墙进入建筑' : '⚠️ 未贴近墙体（ inconclusive）');
  socket.disconnect();
  process.exit(pass ? 0 : 1);
}

socket.on('snap', () => {}); // 已在上面处理
// 上车确认
const origHandler = socket.io ? null : null;
socket.on('snap', () => {});
setTimeout(() => {
  const check = setInterval(() => {
    if (self.st === 'v' && !started) {
      started = true; startTs = Date.now(); entered = true;
      log('✓ 已上车，冲向建筑…');
      clearInterval(check);
    }
  }, 200);
}, 12000);

socket.emit('room:create', { mode: 'squad', scenery: 'day' }, (r) => log('房间:', r.ok ? r.id : r.msg));
setTimeout(() => finish('超时'), 200000);
