// 房间规则 E2E：不自动开局 / 未全员准备不能开始 / 只有房主能开始 / 晚加入可进房
import { io } from 'socket.io-client';

const BASE = 'http://localhost:8080';
let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
};

const mk = async () => {
  const r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'rr_' + Math.random().toString(36).slice(2, 8), password: 'pass1234' }),
  });
  return (await r.json()).token;
};
const sock = (t) => io(BASE, { auth: { token: t } });
const wait = (s, ev) => new Promise(r => s.on(ev, r));
const ack = (s, ev, d) => new Promise(r => s.emit(ev, d, r));

// A 建房，B 未准备加入
const A = sock(await mk());
await wait(A, 'connect');
const created = await ack(A, 'room:create', { mode: 'duo', scenery: 'day' });
ok('建房', created.ok, created.id);
const roomId = created.id;

const B = sock(await mk());
await wait(B, 'connect');
ok('晚加入可进房（等待中）', (await ack(B, 'room:join', { id: roomId })).ok);

// 1) 非房主开始 → 拒绝
const nonHost = await ack(B, 'room:start', {});
ok('非房主开始被拒', !nonHost.ok && /房主/.test(nonHost.msg), nonHost.msg);

// 2) 房主在 B 未准备时开始 → 拒绝
const notReady = await ack(A, 'room:start', {});
ok('未全员准备开始被拒', !notReady.ok && /准备/.test(notReady.msg), notReady.msg);

// 3) 无自动开局：原倒计时 10 秒，等 13 秒确认不会自己开
await new Promise(r => setTimeout(r, 13000));
let battleStarted = false;
A.on('battle:you', () => { battleStarted = true; });
const lobbyState = await new Promise(r => {
  A.emit('room:ready', { ready: true }); // 触发一次房间状态推送
  A.once('room', (room) => r(room.state));
});
ok('等待期间不自动开局', lobbyState === 'waiting' && !battleStarted, 'state=' + lobbyState);

// 4) B 也准备后，房主开始 → 成功
B.emit('room:ready', { ready: true });
await new Promise(r => B.once('room', r)); // 等准备状态同步
const youPromise = wait(A, 'battle:you'); // 先挂监听再触发（事件随 start 应答即到）
const started = await ack(A, 'room:start', {});
ok('全员准备后房主可开始', started.ok, started.msg || '');
const youEvent = await Promise.race([youPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('开局超时')), 8000))]);
ok('战斗已开始', !!youEvent);

A.disconnect(); B.disconnect();
console.log(failed ? `\nROOM-RULES FAILED (${failed})` : '\nROOM-RULES OK');
process.exit(failed ? 1 : 0);
