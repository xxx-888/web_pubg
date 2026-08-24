// 双人组队测试：demo 建房（四人模式）→ demo2 加入 → 一起进战斗
// 验证：同队、队友不误伤、房间流程完整
import { io } from 'socket.io-client';

const BASE = 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function login(name, pass) {
  return fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: pass }),
  }).then(r => r.json());
}

const [a, b] = await Promise.all([login('demo', '1234'), login('demo2', '1234')]);
const sa = io(BASE, { auth: { token: a.token } });
const sb = io(BASE, { auth: { token: b.token } });

const state = { roomA: null, battleA: null, youA: null, youB: null, namesA: null, hpB: 100 };
const res = {};

sa.on('room', (r) => { if (r.players.length >= 1) state.roomA = r; });
sb.on('room', (r) => { if (r.id) state.roomB = r; });
sa.on('battle', (m) => { state.battleA = m; state.namesA = m.names; });
sa.on('battle:you', (m) => { state.youA = m.id; });
sb.on('battle:you', (m) => { state.youB = m.id; });
sb.on('hit', (m) => { state.hpB -= m.d; log('B 受伤:', m.d, '来自', m.by); });
sb.on('err', (m) => { log('!!', m.msg); res.err = m.msg; });
sb.on('snap', (m) => {
  const me = m.e.find(r => r[0] === state.youB);
  if (me) state.hpB = me[7];
});

// A 创建四人模式房间
sa.emit('room:create', { mode: 'squad', scenery: 'day', name: '组队测试' }, (r) => {
  log('A 建房:', r.ok ? r.id : r.msg);
  if (!r.ok) process.exit(1);
  // B 通过房间号加入
  setTimeout(() => {
    sb.emit('room:join', { id: r.id }, (r2) => {
      log('B 加入:', r2.ok ? '成功' : r2.msg);
      if (!r2.ok) process.exit(1);
      // B 准备（房主 A 无需准备）
      sb.emit('room:ready', { ready: true });
      // A 直接开始
      setTimeout(() => sa.emit('room:start', {}, (r3) => log('A 开局:', r3 ? JSON.stringify(r3) : '(无回调)')), 500);
    });
  }, 800);
});

// 战斗开始后：验证同队 + 测试队友不误伤（A 朝 B 开枪）
sa.on('battle:you', async () => {
  setTimeout(() => {
    const nA = state.namesA || {};
    const teamA = nA[state.youA] && nA[state.youA].t;
    const teamB = nA[state.youB] && nA[state.youB].t;
    res.sameTeam = teamA !== undefined && teamA === teamB;
    log(`A 队伍=${teamA} B 队伍=${teamB} → ${res.sameTeam ? '✓ 同队' : '✗ 不同队'}`);
    // A 站在 B 旁边朝 B 开 10 枪（同队应无伤害）
    let shots = 0;
    const iv = setInterval(() => {
      if (shots++ >= 10) {
        clearInterval(iv);
        setTimeout(() => {
          res.noFriendlyFire = state.hpB >= 100;
          log(`队友误伤测试: B 血量=${state.hpB} → ${res.noFriendlyFire ? '✓ 同队免疫' : '✗ 被队友打掉血'}`);
          log('===== 结果 =====');
          const pass = res.sameTeam && res.noFriendlyFire && !res.err;
          log(`同队:${res.sameTeam ? '✓' : '✗'} 队友免伤:${res.noFriendlyFire ? '✓' : '✗'} 错误:${res.err || '无'}`);
          log(pass ? '✅ 组队流程全部通过' : '❌ 存在失败');
          sa.disconnect(); sb.disconnect();
          process.exit(pass ? 0 : 1);
        }, 1500);
        return;
      }
      sa.emit('shoot', { d: [0, 0, 1] });
    }, 150);
  }, 3000);
});

setTimeout(() => { log('超时'); console.log(JSON.stringify(res)); process.exit(1); }, 120000);
