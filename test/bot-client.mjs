// 自动化测试客户端：模拟玩家完整对局流程（node test/bot-client.mjs）
import { io } from 'socket.io-client';
import { Terrain } from '../shared/terrain.js';

const BASE = 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const login = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: '1234' }),
}).then(r => r.json());
if (!login.token) { console.error('登录失败', login); process.exit(1); }
log('登录成功:', login.user.username);

const socket = io(BASE, { auth: { token: login.token } });
let self = { st: 'p', x: 0, y: 400, z: 0, landed: false };
let battle = null, myId = null, kills = 0, dead = false;
let lastLoot = [];
const stats = { snaps: 0, shots: 0, kills: 0, loot: 0, zone: [], errors: [] };

socket.on('connect', () => log('socket 已连接', socket.id));
socket.on('connect_error', (e) => { log('连接错误:', e.message); process.exit(1); });
socket.on('err', (m) => { stats.errors.push(m); log('服务器错误:', m); });

socket.on('lobby', (m) => { if (stats.snaps === 0) log('大厅推送: 房间', m.rooms.length, '在线', m.online); });

socket.on('room', (r) => log(`房间 [${r.name}] 玩家${r.players.length} 状态${r.state} 倒计时${r.countdown ?? '-'}`));

socket.on('battle', (m) => {
  battle = m;
  terrain = new Terrain(m.map.seed, m.map.size);
  log(`战斗开始! 实体名单 ${Object.keys(m.names).length} 人, 掉落物 ${m.loot.length}, 载具 ${m.vehicles.length}, 地图 seed=${m.map.seed}`);
  // 战斗开始 3 秒后跳伞
  setTimeout(() => { if (!dead && self.st === 'p') { socket.emit('jump'); log('→ 跳伞'); } }, 3000);
});
socket.on('rubber', (m) => { self.x = m.x; self.y = m.y; self.z = m.z; });
socket.on('battle:you', (m) => { myId = m.id; log('我的实体:', myId, '初始装备:', JSON.stringify(m.inv.w)); });

socket.on('snap', (m) => {
  stats.snaps++;
  if (stats.snaps % 100 === 0) {
    const me = m.e.find(r => r[0] === myId);
    log(`快照#${stats.snaps} 存活${m.ac} 我的HP=${me ? me[7] : '已死'} 状态=${me ? me[5] : '-'} 位置=(${me ? me[1] + ',' + me[2] + ',' + me[3] : '-'}) 区state=${m.z ? m.z[7] + '/' + m.z[8] + 's' : '-'}`);
  }
  if (m.z) { const z = m.z; stats.zone = z; }
  const me = m.e.find(r => r[0] === myId);
  if (me && !dead) {
    self.x = me[1]; self.y = me[2]; self.z = me[3];
    self.st = me[5];
    if (me[5] === 'g' && !self.landed) { self.landed = true; log('✓ 已落地', self.x.toFixed(0), self.y.toFixed(0), self.z.toFixed(0)); }
  }
});

socket.on('loot', (m) => { if (m.add) { stats.loot += m.add.length; lastLoot = m.add; } });
socket.on('shot', () => {});
socket.on('dmg', (m) => { stats.shots > 0 && log(`  我造成伤害 ${m.d} ${m.hs ? '(爆头)' : ''}`); });
socket.on('hit', (m) => log('  我受到伤害', m.d, '来自', m.by));
socket.on('kill', (m) => { if (m.kid === myId) { kills++; stats.kills++; log('✓ 我淘汰了', m.v); } });
socket.on('dead', (m) => { dead = true; log(`✗ 我阵亡了 排名#${m.rank} 被 ${m.by} 淘汰`); });
socket.on('end', (m) => {
  log(`========== 对局结算 ========== 排名#${m.rank} 击杀${m.kills} 伤害${m.dmg} 金币+${m.coins} 胜者[${m.winners}]`);
  finish();
});
socket.on('boom', () => {});
socket.on('toast', (m) => log('提示:', m.msg));

// ---------- 流程 ----------
socket.emit('room:create', { mode: 'squad', scenery: 'day', name: '测试房间' }, (res) => {
socket.emit('room:start', {}, () => {}); // 房主即全员就绪，直接开局
  log('创建房间:', JSON.stringify(res));
});

// 模拟下落 + 落地后行为
let stateTimer = setInterval(() => {
  if (!battle || !myId || dead) return;
  if (terrain) groundHint = Math.max(terrain.height(self.x, self.z), 0);
  const snapMe = self;
  if (self.st === 'p') return;
  // 简单模拟：直接向地面坠落（服务器信任客户端位置，只要速率合理）
  if (!self.landed) {
    self.st = self.y - groundHint < 125 ? 'c' : 'f';
    self.y = Math.max(self.y - (self.st === 'c' ? 0.35 : 2.7), groundHint);
    if (self.y <= groundHint + 0.01) { self.y = groundHint; self.st = 'g'; }
  }
  socket.emit('s', {
    x: +snapMe.x.toFixed(2), y: +self.y.toFixed(2), z: +snapMe.z.toFixed(2),
    yaw: 0, pitch: 0, st: self.st, cr: false, mv: false,
  });
}, 50);

let groundHint = 0;
let terrain = null;
// 落地后：捡枪 + 射击
let behaviorTimer = setInterval(() => {
  if (!battle || dead) return;
  if (self.landed) {
    // 找最近的武器掉落去捡
    const weapons = lastLoot.filter(l => l.kind === 'weapon');
    if (weapons.length) {
      const w = weapons[0];
      if (Math.hypot(w.x - self.x, w.z - self.z) < 2.5) {
        socket.emit('act', { kind: 'pickup', id: w.id });
        log('→ 拾取武器', w.wid);
      } else {
        const dx = w.x - self.x, dz = w.z - self.z, d = Math.hypot(dx, dz) || 1;
        self.x += dx / d * 0.28; self.z += dz / d * 0.28;
      }
    }
    // 有枪就朝随机方向开几枪（服务器校验射线）
    if (Math.random() < 0.15) {
      socket.emit('shoot', { d: [Math.random() - 0.5, 0, 1] });
      stats.shots++;
    }
    socket.emit('reload');
  }
}, 200);

function finish() {
  clearInterval(stateTimer);
  clearInterval(behaviorTimer);
  setTimeout(async () => {
    const me = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + login.token } }).then(r => r.json());
    log('战后金币:', me.user.coins, '战绩:', JSON.stringify(me.user.stats));
    log('===== 测试统计 =====');
    log(`快照${stats.snaps} 射击${stats.shots} 拾取事件${stats.loot} 击杀${stats.kills} 错误${stats.errors.length}`);
    socket.disconnect();
    process.exit(0);
  }, 1500);
}

// 15 分钟保险退出
setTimeout(() => { log('超时退出（未收到结算）'); finish(); }, 15 * 60 * 1000);
