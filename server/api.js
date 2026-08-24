// REST API：登录注册 / 个人信息 / 商店 / 排行榜 / 后台管理
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDb, markDirty, saveNow, publicUser } from './db.js';

export function createApi(io, rooms) {
  const api = express.Router();
  api.use(express.json());

  const db = getDb();
  const sign = (u) => jwt.sign({ id: u.id, username: u.username }, db.settings.secret, { expiresIn: '7d' });
  const auth = (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      const payload = jwt.verify(token, db.settings.secret);
      const u = db.users.find(x => x.id === payload.id);
      if (!u) return res.status(401).json({ error: '账号不存在' });
      if (u.banned) return res.status(403).json({ error: '账号已被封禁' });
      req.user = u;
      next();
    } catch { return res.status(401).json({ error: '登录已过期，请重新登录' }); }
  };
  const adminOnly = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  };

  // ---------- 公共配置 ----------
  api.get('/cfg', (req, res) => {
    res.json({ weapons: db.weapons, vehicles: db.vehicles, shop: db.shop, maps: db.maps, settings: { totalPlayers: db.settings.totalPlayers } });
  });

  // ---------- 登录 ----------
  const attempts = new Map(); // ip -> {n, t}
  function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, t: now };
    if (now - a.t > 60000) { a.n = 0; a.t = now; }
    a.n++;
    attempts.set(ip, a);
    if (a.n > 30) return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
    next();
  }

  api.post('/register', rateLimit, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(username)) return res.status(400).json({ error: '用户名需 2-16 位（字母数字下划线中文）' });
    if (password.length < 4 || password.length > 32) return res.status(400).json({ error: '密码需 4-32 位' });
    if (db.users.some(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });
    const u = {
      id: db.nextUserId++, username, password: bcrypt.hashSync(password, 10), role: 'user',
      coins: 500, skin: 'skin_default', bought: ['skin_default'],
      stats: { kills: 0, deaths: 0, wins: 0, games: 0 }, banned: false, createdAt: Date.now(),
    };
    db.users.push(u);
    markDirty();
    res.json({ token: sign(u), user: publicUser(u) });
  });

  api.post('/login', rateLimit, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = db.users.find(x => x.username === username);
    if (!u || !bcrypt.compareSync(password, u.password)) return res.status(400).json({ error: '用户名或密码错误' });
    if (u.banned) return res.status(403).json({ error: '账号已被封禁，请联系管理员' });
    res.json({ token: sign(u), user: publicUser(u) });
  });

  api.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  // 修改昵称
  api.post('/rename', auth, (req, res) => {
    const username = String(req.body.username || '').trim();
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(username)) return res.status(400).json({ error: '昵称需 2-16 位（字母数字下划线中文）' });
    if (db.users.some(u => u.username === username && u.id !== req.user.id)) return res.status(400).json({ error: '该昵称已被使用' });
    req.user.username = username;
    markDirty();
    res.json({ user: publicUser(req.user) });
  });

  api.post('/logout', auth, (req, res) => res.json({ ok: true }));

  // ---------- 商店 ----------
  api.post('/shop/buy', auth, (req, res) => {
    const item = db.shop.find(s => s.id === req.body.id);
    if (!item) return res.status(400).json({ error: '商品不存在' });
    const u = req.user;
    if (u.bought.includes(item.id)) return res.status(400).json({ error: '已拥有该外观' });
    if (u.coins < item.price) return res.status(400).json({ error: '金币不足' });
    u.coins -= item.price;
    u.bought.push(item.id);
    markDirty();
    res.json({ user: publicUser(u) });
  });

  api.post('/shop/equip', auth, (req, res) => {
    const item = db.shop.find(s => s.id === req.body.id);
    if (!item) return res.status(400).json({ error: '商品不存在' });
    if (!req.user.bought.includes(item.id)) return res.status(400).json({ error: '尚未拥有该外观' });
    req.user.skin = item.id;
    markDirty();
    res.json({ user: publicUser(req.user) });
  });

  api.get('/leaderboard', (req, res) => {
    const top = [...db.users].sort((a, b) => (b.stats.kills || 0) - (a.stats.kills || 0)).slice(0, 10)
      .map(u => ({ username: u.username, kills: u.stats.kills, wins: u.stats.wins, games: u.stats.games }));
    res.json({ top });
  });

  // ---------- 后台管理 ----------
  api.get('/admin/overview', auth, adminOnly, (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      users: db.users.length,
      online: rooms.onlineCount(),
      rooms: rooms.adminList(),
      weapons: db.weapons.length,
      battles: rooms.adminList().filter(r => r.state === 'battle').length,
      uptime: Math.round(process.uptime()),
      memMB: Math.round(mem.rss / 1048576),
    });
  });

  // 用户列表：支持搜索（用户名/ID）、分页、在线状态
  api.get('/admin/users', auth, adminOnly, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, parseInt(req.query.pageSize) || 20));
    const onlineIds = rooms.onlineUserIds();
    let list = db.users;
    if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || String(u.id) === q);
    const total = list.length;
    const start = (page - 1) * pageSize;
    const users = list.slice(start, start + pageSize).map(u => ({ ...publicUser(u), online: onlineIds.has(u.id) }));
    res.json({ users, total, page, pageSize, onlineTotal: onlineIds.size });
  });

  api.post('/admin/user', auth, adminOnly, (req, res) => {
    const u = db.users.find(x => x.id === req.body.id);
    if (!u) return res.status(400).json({ error: '用户不存在' });
    const { action, value } = req.body;
    const usableAdmins = () => db.users.filter(x => x.role === 'admin' && !x.banned).length;
    switch (action) {
      case 'ban':
        if (u.id === req.user.id) return res.status(400).json({ error: '不能封禁自己，否则将无法进入后台' });
        if (u.role === 'admin' && usableAdmins() <= 1) return res.status(400).json({ error: '不能封禁最后一个可用的管理员' });
        u.banned = true; break;
      case 'unban': u.banned = false; break;
      case 'coins': u.coins = Math.max(0, parseInt(value) || 0); break;
      case 'role':
        if (u.id === req.user.id && value !== 'admin') return res.status(400).json({ error: '不能降级自己的管理员角色' });
        if (u.role === 'admin' && value !== 'admin' && usableAdmins() <= 1) return res.status(400).json({ error: '不能降级最后一个可用的管理员' });
        u.role = value === 'admin' ? 'admin' : 'user'; break;
      case 'resetpw':
        if (!value || String(value).length < 4) return res.status(400).json({ error: '密码至少 4 位' });
        u.password = bcrypt.hashSync(String(value), 10);
        break;
      case 'giveskin':
        for (const s of db.shop) if (!u.bought.includes(s.id)) u.bought.push(s.id);
        break;
      case 'gm': u.gm = !!value; break; // 给普通玩家开放 GM（透视/自瞄/锁血/无限弹/轰炸）
      case 'rename': {
        const name = String(value || '').trim();
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) return res.status(400).json({ error: '用户名需 2-16 位（字母数字下划线中文）' });
        if (db.users.some(x => x.username === name && x.id !== u.id)) return res.status(400).json({ error: '该用户名已被使用' });
        u.username = name;
        break;
      }
      case 'del': {
        if (u.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
        if (u.role === 'admin' && db.users.filter(x => x.role === 'admin' && !x.banned).length <= 1) {
          return res.status(400).json({ error: '至少保留一个管理员' });
        }
        db.users = db.users.filter(x => x.id !== u.id);
        break;
      }
      default: return res.status(400).json({ error: '未知操作' });
    }
    markDirty();
    res.json({ user: db.users.find(x => x.id === req.body.id) ? publicUser(u) : null, ok: true });
  });

  api.post('/admin/kick', auth, adminOnly, (req, res) => {
    const room = rooms.rooms.get(req.body.roomId);
    if (!room) return res.status(400).json({ error: '房间不存在' });
    const p = [...room.players.values()].find(x => x.user.id === req.body.userId);
    if (!p) return res.status(400).json({ error: '玩家不在该房间' });
    room.kick(p.sid, '管理员将你移出房间');
    res.json({ ok: true });
  });

  // 解散房间（战斗中的对局也会被强制结束并结算）
  api.post('/admin/room/dissolve', auth, adminOnly, (req, res) => {
    res.json(rooms.dissolve(req.body.id, req.body.reason));
  });

  // 全服公告：所有人弹提示，大厅聊天也发一条
  api.post('/admin/announce', auth, adminOnly, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 120);
    if (!text) return res.status(400).json({ error: '公告内容不能为空' });
    io.emit('toast', { msg: '📢 ' + text });
    io.to('lobby').emit('chat', { ch: 'lobby', from: '📢 公告', text });
    res.json({ ok: true });
  });

  // 通用配置 CRUD：kind = weapons | vehicles | maps | shop
  api.get('/admin/cfg/:kind', auth, adminOnly, (req, res) => {
    const kind = req.params.kind;
    if (!db[kind]) return res.status(400).json({ error: '未知配置类型' });
    res.json({ items: db[kind] });
  });

  api.post('/admin/cfg/:kind', auth, adminOnly, (req, res) => {
    const kind = req.params.kind;
    if (!db[kind]) return res.status(400).json({ error: '未知配置类型' });
    const item = req.body.item;
    if (!item || !item.id) return res.status(400).json({ error: '数据不合法' });
    const idx = db[kind].findIndex(x => x.id === item.id);
    if (idx >= 0) db[kind][idx] = item;
    else db[kind].push(item);
    saveNow();
    res.json({ items: db[kind] });
  });

  api.delete('/admin/cfg/:kind/:id', auth, adminOnly, (req, res) => {
    const kind = req.params.kind;
    if (!db[kind]) return res.status(400).json({ error: '未知配置类型' });
    if (db[kind].length <= 1) return res.status(400).json({ error: '至少保留一项' });
    db[kind] = db[kind].filter(x => x.id !== req.params.id);
    saveNow();
    res.json({ items: db[kind] });
  });

  api.get('/admin/settings', auth, adminOnly, (req, res) => res.json({ settings: db.settings }));
  api.post('/admin/settings', auth, adminOnly, (req, res) => {
    const s = req.body.settings || {};
    if (s.totalPlayers !== undefined) db.settings.totalPlayers = Math.min(100, Math.max(2, parseInt(s.totalPlayers) || 60));
    if (s.botAcc !== undefined) db.settings.botAcc = Math.min(0.95, Math.max(0.1, parseFloat(s.botAcc) || 0.65));
    if (s.rewards) db.settings.rewards = { ...db.settings.rewards, ...s.rewards };
    saveNow();
    res.json({ settings: db.settings });
  });

  api.use((err, req, res, next) => {
    console.error('[api] 异常:', err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return api;
}
