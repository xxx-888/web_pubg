// FIREZONE 服务器入口：静态资源 + REST API + Socket.io 战斗
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { loadDb, saveNow } from './db.js';
import { RoomManager } from './game.js';
import { createApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const db = loadDb();

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// 静态资源
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.get('/vendor/three.module.js', (req, res) => {
  res.sendFile(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.min.js'));
});
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 局域网地址列表（客户端用来生成房间邀请链接）
app.get('/api/lan', (req, res) => {
  const addrs = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  res.json({ port: PORT, addrs });
});

const rooms = new RoomManager(io);
app.use('/api', createApi(io, rooms));

// ---------- Socket.io ----------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('未登录'));
  try {
    const payload = jwt.verify(token, db.settings.secret);
    const user = db.users.find(u => u.id === payload.id);
    if (!user) return next(new Error('账号不存在'));
    if (user.banned) return next(new Error('账号已被封禁'));
    socket.data.user = user;
    next();
  } catch {
    next(new Error('登录已过期'));
  }
});

const lastChat = new Map();

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.join('lobby');
  rooms.broadcastLobby();

  const chatOk = () => {
    const now = Date.now();
    const last = lastChat.get(socket.id) || 0;
    if (now - last < 600) return false;
    lastChat.set(socket.id, now);
    return true;
  };

  // ---------- 房间 ----------
  socket.on('room:create', (m = {}, cb) => {
    try {
      if (rooms.roomOf(socket.id)) return cb && cb({ ok: false, msg: '你已在房间中' });
      const res = rooms.create({ name: m.name, mode: m.mode, scenery: m.scenery }, user, socket);
      cb && cb(res);
    } catch (e) { console.error('[socket] room:create', e); cb && cb({ ok: false, msg: '服务器异常' }); }
  });

  socket.on('room:join', (m = {}, cb) => {
    try {
      const res = rooms.join(m.id, user, socket);
      cb && cb(res);
    } catch (e) { console.error('[socket] room:join', e); cb && cb({ ok: false, msg: '服务器异常' }); }
  });

  socket.on('room:leave', (m, cb) => {
    try { rooms.leave(socket); cb && cb({ ok: true }); } catch (e) { console.error('[socket] room:leave', e); }
  });

  socket.on('room:ready', (m = {}) => {
    try {
      const room = rooms.roomOf(socket.id);
      if (room) room.setReady(socket.id, !!m.ready);
    } catch (e) { console.error('[socket] room:ready', e); }
  });

  socket.on('room:start', (m, cb) => {
    try {
      const room = rooms.roomOf(socket.id);
      if (!room || room.hostUserId !== user.id) return cb && cb({ ok: false, msg: '只有房主可以开始' });
      if (!room.allReady()) return cb && cb({ ok: false, msg: '还有玩家未准备，等全员准备后再开始' });
      room.startBattle();
      cb && cb({ ok: true });
    } catch (e) { console.error('[socket] room:start', e); cb && cb({ ok: false, msg: '服务器异常' }); }
  });

  socket.on('room:chat', (m = {}) => {
    try { if (chatOk() && m.text) rooms.lobbyChat(socket, user, m.text); } catch (e) { /* 忽略 */ }
  });

  // ---------- 战斗 ----------
  socket.on('s', (m) => {
    try {
      if (!m || typeof m !== 'object') return;
      const b = rooms.battleOf(socket.id);
      if (!b || b.ended) return;
      const f = [...b.entities.values()].find(x => x.socketId === socket.id);
      if (f && f.alive) b.onState(f, m);
    } catch (e) { /* 单条状态异常不影响整体 */ }
  });

  socket.on('shoot', (m) => {
    try {
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (b && f && m && Array.isArray(m.d) && m.d.length === 3) b.onShoot(f, m);
    } catch (e) { console.error('[socket] shoot', e); }
  });

  socket.on('jump', () => {
    try {
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (b && f) b.onJump(f);
    } catch (e) { /* 忽略 */ }
  });

  socket.on('reload', () => {
    try {
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (b && f) b.onReload(f);
    } catch (e) { /* 忽略 */ }
  });

  socket.on('switch', (m) => {
    try {
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (b && f && m) b.onSwitch(f, m);
    } catch (e) { /* 忽略 */ }
  });

  socket.on('act', (m) => {
    try {
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (b && f && m) b.onAct(f, m);
    } catch (e) { console.error('[socket] act', e); }
  });

  socket.on('chat', (m = {}) => {
    try {
      if (!chatOk() || !m.text) return;
      const room = rooms.roomOf(socket.id);
      if (room && room.battle) {
        const f = rooms.fighterOf(socket.id);
        room.battle.chat(f, m.ch === 'team' ? 'team' : 'all', m.text);
      } else if (room) {
        room.chat(socket.id, m.text);
      }
    } catch (e) { /* 忽略 */ }
  });

  socket.on('gm', (m = {}) => {
    try {
      if (user.role !== 'admin' || !m || !m.cmd) return;
      const b = rooms.battleOf(socket.id);
      const f = b && rooms.fighterOf(socket.id);
      if (!b || !f) return;
      if (m.cmd === 'god') { f.god = !f.god; socket.emit('toast', { msg: f.god ? '锁血：开' : '锁血：关' }); }
      else if (m.cmd === 'infammo') { f.infAmmo = !f.infAmmo; socket.emit('toast', { msg: f.infAmmo ? '无限子弹：开' : '无限子弹：关' }); }
      else if (m.cmd === 'airstrike' && typeof m.x === 'number' && typeof m.z === 'number') b.airstrike(f, m.x, m.z);
    } catch (e) { console.error('[socket] gm', e); }
  });

  socket.on('disconnect', () => {
    try { rooms.leave(socket); } catch (e) { console.error('[socket] disconnect', e); }
    lastChat.delete(socket.id);
  });
});

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ========================================');
  console.log('   FIREZONE 烽区 服务器已启动');
  console.log(`   本机访问:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   局域网:    http://${net.address}:${PORT}  (手机横屏访问)`);
      }
    }
  }
  console.log('   后台管理:  http://localhost:' + PORT + '/admin.html');
  console.log('  ========================================');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用。请关闭占用程序，或设置环境变量 PORT 换端口后重开 start.bat`);
    process.exit(1);
  }
  console.error('[错误] 服务器异常:', e.message);
});

// 优雅退出：保存数据库
function shutdown() {
  console.log('\n[服务器] 正在保存数据并退出...');
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常]', e);
  saveNow();
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理 Promise 拒绝]', e);
});
