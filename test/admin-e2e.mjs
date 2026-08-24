// 后台管理 E2E：新端点全量验证（概览/解散/公告/改名/删除）
import { io } from 'socket.io-client';

const BASE = 'http://localhost:8080';
const rnd = () => Math.random().toString(36).slice(2, 8);
let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
};

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function mkUser(name, pass = 'pass1234') {
  const r = await jfetch('/api/register', { method: 'POST', body: { username: name, password: pass } });
  return r.data;
}
const authHeaders = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

// --- 管理员登录（admin/admin123 或已改密的 88888888 兜底）---
let admin;
for (const pw of ['admin123', 'admin12345', 'pass1234']) {
  const r = await jfetch('/api/login', { method: 'POST', body: { username: 'admin', password: pw } });
  if (r.data.token) { admin = r.data; break; }
}
if (!admin) {
  // admin 用户名可能被改过（用户曾改名为 88888888）；用数据库里第一个 admin 角色账号尝试常见密码
  const r2 = await jfetch('/api/login', { method: 'POST', body: { username: '88888888', password: pw0() } });
  admin = r2.data.token ? r2.data : null;
}
function pw0() { return 'admin123'; }
ok('管理员登录', !!admin, admin ? admin.user.username : 'admin/88888888 常见密码均失败');
if (!admin) process.exit(1);
const A = { headers: { Authorization: 'Bearer ' + admin.token } };

// --- 概览增强 ---
const ov = await jfetch('/api/admin/overview', { method: 'GET', ...A });
ok('概览含新字段', ov.status === 200 && ov.data.battles !== undefined && ov.data.uptime !== undefined && ov.data.memMB !== undefined,
  `battles=${ov.data.battles} uptime=${ov.data.uptime}s mem=${ov.data.memMB}MB`);

// --- 建房（socket）并验证 adminList 成员 ---
const host = await mkUser('admh_' + rnd());
const H = io(BASE, { auth: { token: host.token } });
await new Promise(r => H.on('connect', r));
const createRes = await new Promise(r => H.emit('room:create', { mode: 'solo', scenery: 'day' }, r));
ok('建房', createRes.ok, createRes.id);
const roomId = createRes.id;

const ov2 = await jfetch('/api/admin/overview', { method: 'GET', ...A });
const room = ov2.data.rooms.find(r => r.id === roomId);
ok('房间成员列表', !!room && Array.isArray(room.members) && room.members.some(m => m.name === host.user.username),
  room ? 'members=' + room.members.map(m => m.name).join(',') : '房间不在列表');

// --- 解散房间：等待页玩家被送回大厅 ---
let gotEmptyRoom = false;
H.on('room', (m) => { if (m && Array.isArray(m.players) && m.players.length === 0) gotEmptyRoom = true; });
let gotToast = false;
H.on('toast', () => { gotToast = true; });
const dis = await jfetch('/api/admin/room/dissolve', { method: 'POST', ...A, body: { id: roomId } });
ok('解散返回 ok', dis.status === 200 && dis.data.ok);
await new Promise(r => setTimeout(r, 500));
ok('成员收到踢回大厅事件', gotEmptyRoom);
ok('成员收到解散提示', gotToast);
const ov3 = await jfetch('/api/admin/overview', { method: 'GET', ...A });
ok('房间已销毁', !ov3.data.rooms.some(r => r.id === roomId));
const dis2 = await jfetch('/api/admin/room/dissolve', { method: 'POST', ...A, body: { id: 'R999' } });
ok('解散不存在房间报错', dis2.status === 200 && !dis2.data.ok);

// --- 公告 ---
const ann = await jfetch('/api/admin/announce', { method: 'POST', ...A, body: { text: '维护测试公告' } });
ok('公告发送', ann.status === 200 && ann.data.ok);
const annEmpty = await jfetch('/api/admin/announce', { method: 'POST', ...A, body: { text: '' } });
ok('空公告被拒', annEmpty.status === 400);

// --- 用户改名/删除 ---
const victim = await mkUser('admv_' + rnd());
const rn = await jfetch('/api/admin/user', { method: 'POST', ...A, body: { id: victim.user.id, action: 'rename', value: 'renamed_' + rnd() } });
ok('管理员改名', rn.status === 200 && /^renamed_/.test(rn.data.user?.username || ''), rn.data.user?.username);
const rnBad = await jfetch('/api/admin/user', { method: 'POST', ...A, body: { id: victim.user.id, action: 'rename', value: 'x' } });
ok('非法用户名被拒', rnBad.status === 400);
const del = await jfetch('/api/admin/user', { method: 'POST', ...A, body: { id: victim.user.id, action: 'del' } });
ok('删除用户', del.status === 200);
const users = await jfetch('/api/admin/users', { method: 'GET', ...A });
ok('用户已不存在', !users.data.users.some(u => u.id === victim.user.id));
const delSelf = await jfetch('/api/admin/user', { method: 'POST', ...A, body: { id: admin.user.id, action: 'del' } });
ok('不能删除自己', delSelf.status === 400);

// --- 权限：普通用户访问后台被拒 ---
const norm = await mkUser('admn_' + rnd());
const noAuth = await jfetch('/api/admin/overview', { method: 'GET', headers: { Authorization: 'Bearer ' + norm.token } });
ok('普通用户被拒', noAuth.status === 403);

// --- 商店 cfg 保存 parts ---
const cfg = await jfetch('/api/admin/cfg/shop', { method: 'GET', ...A });
const item = cfg.data.items[0];
const origParts = JSON.parse(JSON.stringify(item.parts || {}));
item.parts = { torso: '#112233', arms: '#223344', legs: '#334455', pack: '#445566' };
const save = await jfetch('/api/admin/cfg/shop', { method: 'POST', ...A, body: { item } });
ok('商店 parts 保存', save.status === 200 && save.data.items.find(x => x.id === item.id).parts.torso === '#112233');
// 还原原始配色
item.parts = origParts;
await jfetch('/api/admin/cfg/shop', { method: 'POST', ...A, body: { item } });

H.disconnect();
console.log(failed ? `\nADMIN-E2E FAILED (${failed})` : '\nADMIN-E2E OK');
process.exit(failed ? 1 : 0);
