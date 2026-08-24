// GM 授权 E2E：管理员给普通玩家开 GM → 玩家 gm 指令生效；关掉 → 指令被拒
import { io } from 'socket.io-client';

const BASE = 'http://localhost:8080';
let failed = 0;
const ok = (n, c, e = '') => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (e ? ' — ' + e : '')); if (!c) failed++; };
const j = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined })).json();
const ack = (s, ev, d) => new Promise(r => s.emit(ev, d, r));

const admin = await j('/api/login', { method: 'POST', body: { username: '88888888', password: 'admin123' } });
const A = { headers: { Authorization: 'Bearer ' + admin.token } };

// 普通玩家建房开局（GM 指令需要战斗内才有意义，但权限校验在 socket 层，
// 直接测指令是否被接受：锁血 god 会回 toast）
const name = 'gmtest_' + Date.now().toString(36);
const reg = await j('/api/register', { method: 'POST', body: { username: name, password: 'pass1234' } });
const P = io(BASE, { auth: { token: reg.token } });
await new Promise(r => P.on('connect', r));
const created = await ack(P, 'room:create', { mode: 'solo', scenery: 'day' });
ok('建房', created.ok);

// 1) 未授权时发 GM 指令 → 无效（没有 toast 回执）
let toasts = [];
P.on('toast', (m) => toasts.push(m.msg));
P.emit('gm', { cmd: 'god' });
await new Promise(r => setTimeout(r, 600));
ok('未授权 GM 指令被忽略', toasts.length === 0);

// 2) 管理员开 GM
const grant = await j('/api/admin/user', { method: 'POST', ...A, body: { id: reg.user.id, action: 'gm', value: true } });
ok('开通 GM', grant.ok && grant.user.gm === true);

// 3) 开局进入战斗（GM 指令的回执只在战斗内发）
const youPromise = new Promise(r => P.once('battle:you', r));
const startRes = await ack(P, 'room:start', {});
ok('房主开始', startRes.ok);
await Promise.race([youPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('开局超时')), 8000))]);
await new Promise(r => setTimeout(r, 500)); // 等战斗 tick 就绪

toasts = [];
P.emit('gm', { cmd: 'god' });
await new Promise(r => setTimeout(r, 800));
ok('授权后 GM 指令生效', toasts.some(t => /锁血/.test(t)), toasts.join('|'));

// 4) 关闭 GM（战斗中）
await j('/api/admin/user', { method: 'POST', ...A, body: { id: reg.user.id, action: 'gm', value: false } });
toasts = [];
P.emit('gm', { cmd: 'god' });
await new Promise(r => setTimeout(r, 800));
ok('关闭后 GM 指令再次被忽略', toasts.length === 0);

// 清理：解散房间（强制结束战斗）→ 删除测试用户
const dis = await j('/api/admin/room/dissolve', { method: 'POST', ...A, body: { id: created.id } });
ok('清理：解散房间', dis.ok);
await j('/api/admin/user', { method: 'POST', ...A, body: { id: reg.user.id, action: 'del' } });
P.disconnect();
console.log(failed ? `\nGM-GRANT FAILED (${failed})` : '\nGM-GRANT OK');
process.exit(failed ? 1 : 0);
