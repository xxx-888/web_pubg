// 邀请链接 E2E：A 建房 → 模拟 B 通过 ?room= 链接加入 → 房间内可见两人
import { io } from 'socket.io-client';

const BASE = 'http://localhost:8080';
const rnd = () => Math.random().toString(36).slice(2, 8);

async function mkUser(name) {
  const r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'pass1234' }),
  });
  const d = await r.json();
  if (!d.token) throw new Error('注册失败: ' + JSON.stringify(d));
  return d.token;
}

const waitAck = (sock, ev, data) => new Promise(res => sock.emit(ev, data, res));

const tokA = await mkUser('shareA_' + rnd());
const tokB = await mkUser('shareB_' + rnd());

const A = io(BASE, { auth: { token: tokA } });
await new Promise(r => A.on('connect', r));

// A 创建房间（模拟点击"创建房间"）
const createRes = await waitAck(A, 'room:create', { mode: 'duo', scenery: 'day' });
if (!createRes.ok) { console.error('FAIL 建房:', createRes); process.exit(1); }
const roomId = createRes.id;
console.log('A 建房成功:', roomId);

// 模拟 B 打开分享链接：客户端逻辑是收到 lobby 列表后 emit room:join
const B = io(BASE, { auth: { token: tokB } });
const bRoom = new Promise(r => B.on('room', r));
await new Promise(r => B.on('connect', r));
const joinRes = await waitAck(B, 'room:join', { id: roomId });
if (!joinRes.ok) { console.error('FAIL 链接加入:', joinRes); process.exit(1); }
console.log('B 通过链接加入成功');

// 验证 B 收到的房间快照里有 A 和 B 两人
const roomSnap = await Promise.race([bRoom, new Promise((_, rej) => setTimeout(() => rej(new Error('room 事件超时')), 3000))]);
const names = roomSnap.players.map(p => p.name);
console.log('房间成员:', names.join(', '), '模式:', roomSnap.mode);
if (roomSnap.players.length !== 2) { console.error('FAIL 应有2人'); process.exit(1); }

// 验证 /api/lan 返回可用地址
const lan = await (await fetch(BASE + '/api/lan')).json();
if (!Array.isArray(lan.addrs) || !lan.addrs.length) { console.error('FAIL /api/lan'); process.exit(1); }
console.log('LAN 地址:', lan.addrs.join(', '), '端口:', lan.port);

A.disconnect(); B.disconnect();
console.log('SHARE-OK');
process.exit(0);
