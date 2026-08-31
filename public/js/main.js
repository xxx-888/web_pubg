// 客户端主流程：登录 / 大厅 / 商店 / 房间 / 战斗调度
import { Game, makeCharacterMesh } from './game.js?v=31';
import { Assets, makeHumanoid, WEAPON_DEFS } from './models.js?v=31';

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('fz_token') || null,
  user: null,
  cfg: null,
  socket: null,
  game: null,
  mode: 'squad',
  scenery: 'day',
  rooms: [],
  room: null,
  pendingBattle: null,
};

window.toast = (msg, type = '') => {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function showPage(name) {
  for (const p of ['login', 'lobby', 'room', 'battle']) {
    $('page-' + p).classList.toggle('hidden', p !== name);
  }
}

// ---------- 登录 ----------
function bindAuth() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
      $('register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
    };
  });
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    $('login-err').textContent = '';
    try {
      const data = await api('/login', {
        method: 'POST',
        body: { username: $('li-username').value, password: $('li-password').value },
      });
      onAuthed(data);
    } catch (err) { $('login-err').textContent = err.message; }
  };
  $('register-form').onsubmit = async (e) => {
    e.preventDefault();
    $('register-err').textContent = '';
    try {
      const data = await api('/register', {
        method: 'POST',
        body: { username: $('rg-username').value, password: $('rg-password').value },
      });
      onAuthed(data);
    } catch (err) { $('register-err').textContent = err.message; }
  };
  $('btn-logout').onclick = () => {
    localStorage.removeItem('fz_token');
    location.reload();
  };
}

function onAuthed(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('fz_token', data.token);
  enterLobby();
}

// ---------- 大厅 ----------
function enterLobby() {
  showPage('lobby');
  renderLobby();
  loadCfg();
  loadLeaderboard();
  connectSocket();
  // 登录后立刻后台预载 3D 素材（真人角色/枪械/载具），进对局时即取即用
  Assets.load((p) => {
    const el = document.getElementById('asset-preload');
    if (el) el.textContent = p < 1 ? `3D 素材加载中 ${(p * 100) | 0}%` : '';
  });
}

async function loadCfg() {
  try {
    state.cfg = await api('/cfg');
    renderShop();
  } catch (e) { toast('配置加载失败：' + e.message, 'error'); }
}

async function loadLeaderboard() {
  try {
    const { top } = await api('/leaderboard');
    $('leaderboard').innerHTML = top.map((u, i) =>
      `<li><b>${escapeHtml(u.username)}</b> — ${u.kills} 杀 / ${u.wins} 鸡 / ${u.games} 场</li>`
    ).join('') || '<li class="muted">暂无数据</li>';
  } catch { /* 忽略 */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLobby() {
  const u = state.user;
  $('lobby-username').textContent = u.username + (u.role === 'admin' ? ' · 管理员' : '');
  $('lobby-coins').textContent = '💰 ' + u.coins;
  const s = u.stats || { kills: 0, deaths: 0, wins: 0, games: 0 };
  $('st-games').textContent = s.games;
  $('st-kills').textContent = s.kills;
  $('st-wins').textContent = s.wins;
  $('st-kd').textContent = s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills;
  const skin = (state.cfg?.shop || []).find(x => x.id === u.skin);
  const o = skin ? (skin.parts || { torso: skin.color, arms: skin.color }) : { torso: '#7a8a5a', arms: '#6d7c50' };
  $('lobby-skin-preview').innerHTML = `<div class="mini-man" style="filter:none">
    <div style="position:absolute;left:9px;top:0;width:10px;height:10px;border-radius:50%;background:#d8b48f"></div>
    <div style="position:absolute;left:7px;top:11px;width:14px;height:24px;border-radius:4px;background:${o.torso}"></div>
    <div style="position:absolute;left:7px;top:36px;width:6px;height:16px;background:${o.legs}"></div>
    <div style="position:absolute;left:15px;top:36px;width:6px;height:16px;background:${o.legs}"></div>
  </div>`;
}

// ---------- 商店 3D 预览 ----------
let skinPreview = null;
let previewItemId = null;

function outfitOf(item) {
  return item.parts || { torso: item.color, arms: item.color, legs: '#3f4450', pack: '#4a4336' };
}

function initSkinPreview() {
  if (skinPreview) return;
  const canvas = $('skin-canvas');
  if (!canvas) return;
  // 动态加载 three 模块（与战斗客户端共用同一份）
  import('/vendor/three.module.js').then((THREE) => {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(220, 240, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 220 / 240, 0.1, 20);
    camera.position.set(0.15, 1.15, 2.75);
    camera.lookAt(0, 0.95, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5a6a, 1.6));
    const dir = new THREE.DirectionalLight(0xfff2dd, 2.0);
    dir.position.set(2, 3, 2.5);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xbcd0ff, 1.0);
    dir2.position.set(-2.5, 1.5, -1);
    scene.add(dir2);
    let mesh = null;
    let lastT = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      if ($('page-lobby').classList.contains('hidden')) { requestAnimationFrame(loop); return; }
      if (mesh) {
        mesh.group.rotation.y += 0.014;
        if (mesh.updateAnim) mesh.updateAnim(dt, { st: 'g', moving: false, sprint: false, crouch: false, wid: 'm4' });
      }
      renderer.render(scene, camera);
      requestAnimationFrame(loop);
    };
    skinPreview = {
      setOutfit(item) {
        if (mesh) scene.remove(mesh.group);
        // 真人模型（带待机动画 + 手持 M4）；素材未就绪时退回方块人
        if (Assets.soldierReady) {
          mesh = makeHumanoid(outfitOf(item));
          mesh.setWeapon('m4', WEAPON_DEFS.m4);
        } else {
          mesh = makeCharacterMesh(outfitOf(item));
          mesh.armL.rotation.x = -1.05;
          mesh.armR.rotation.x = -1.3;
          mesh.gun.visible = true;
        }
        scene.add(mesh.group);
        // 素材晚到：下一次选择皮肤时自动用上真人模型
      },
    };
    // 素材加载完成后自动把预览刷新成真人（若商店已打开）
    Assets.load().then(() => {
      if (skinPreview && previewItemId) {
        const it = (state.cfg?.shop || []).find(s => s.id === previewItemId);
        if (it) skinPreview.setOutfit(it);
      }
    });
    // 默认显示已装备的
    const equipped = (state.cfg?.shop || []).find(s => s.id === state.user?.skin);
    if (equipped) skinPreview.setOutfit(equipped);
    loop();
  }).catch((e) => console.error('皮肤预览初始化失败:', e));
}

function selectShopItem(item) {
  previewItemId = item.id;
  skinPreview && skinPreview.setOutfit(item);
  $('skin-preview-name').textContent = item.name;
  const owned = state.user.bought.includes(item.id);
  const equipped = state.user.skin === item.id;
  const btn = $('skin-preview-btn');
  btn.textContent = equipped ? '使用中' : owned ? '装备' : item.price === 0 ? '免费领取' : `购买 💰${item.price}`;
  btn.disabled = equipped;
  document.querySelectorAll('.shop-item').forEach(el => el.classList.toggle('active', el.dataset.id === item.id));
}

function renderShop() {
  const grid = $('shop-grid');
  const shop = state.cfg?.shop || [];
  grid.innerHTML = '';
  for (const item of shop) {
    const owned = state.user.bought.includes(item.id);
    const equipped = state.user.skin === item.id;
    const o = outfitOf(item);
    const div = document.createElement('div');
    div.className = 'shop-item' + (owned ? ' owned' : '') + (equipped ? ' active' : '');
    div.dataset.id = item.id;
    div.innerHTML = `
      <div class="swatch">
        <i style="background:${o.torso}"></i><i style="background:${o.arms}"></i><i style="background:${o.legs}"></i><i style="background:${o.pack}"></i>
      </div>
      <div>${escapeHtml(item.name)}</div>
      <div class="price">${equipped ? '使用中' : owned ? '已拥有' : item.price === 0 ? '免费' : '💰 ' + item.price}</div>`;
    div.onclick = async () => {
      selectShopItem(item);
      // 已拥有的衣服：点卡片直接穿上
      if (state.user.bought.includes(item.id) && state.user.skin !== item.id) {
        try {
          const data = await api('/shop/equip', { method: 'POST', body: { id: item.id } });
          state.user = data.user;
          renderLobby();
          renderShop();
          toast('已装备 ' + item.name);
        } catch (e) { toast(e.message, 'error'); }
      }
    };
    grid.appendChild(div);
  }
  initSkinPreview();
  // 默认选中已装备的
  const equippedItem = shop.find(s => s.id === state.user.skin) || shop[0];
  if (equippedItem) selectShopItem(equippedItem);
}

function renderRooms() {
  const box = $('room-list');
  if (!state.rooms.length) { box.innerHTML = '<p class="muted">暂无房间，创建一个吧</p>'; return; }
  box.innerHTML = '';
  for (const r of state.rooms) {
    const div = document.createElement('div');
    div.className = 'room-item';
    const modeName = { solo: '单人', duo: '双人', squad: '四人' }[r.mode] || r.mode;
    div.innerHTML = `
      <span class="rname">${escapeHtml(r.name)}</span>
      <span class="rmeta">${modeName} · ${r.scenery === 'day' ? '白天' : r.scenery === 'dawn' ? '黎明' : r.scenery === 'dusk' ? '黄昏' : '夜晚'} · ${r.players}/${r.max}人 · ${r.state === 'battle' ? '⚔战斗中' : '等待中'}</span>
      <button class="btn small share-btn" title="复制邀请链接">分享</button>
      <button class="btn small" ${r.state === 'battle' ? 'disabled' : ''}>加入</button>`;
    div.querySelector('.share-btn').onclick = (e) => { e.stopPropagation(); openShareModal(r.id); };
    div.querySelector('button:not(.share-btn)').onclick = () => joinRoom(r.id);
    box.appendChild(div);
  }
}

function bindLobby() {
  $('mode-row').querySelectorAll('.mode-btn').forEach(b => {
    b.onclick = () => {
      $('mode-row').querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.mode = b.dataset.mode;
    };
  });
  $('scenery-row').querySelectorAll('.mode-btn').forEach(b => {
    b.onclick = () => {
      $('scenery-row').querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.scenery = b.dataset.sc;
    };
  });
  $('btn-quick').onclick = quickJoin;
  $('btn-create').onclick = () => createRoom();
  $('btn-refresh').onclick = () => { /* lobby 事件每 2 秒自动推送 */ toast('房间列表已刷新'); };
  $('btn-rename').onclick = async () => {
    const name = prompt('输入新昵称（2-16 位，支持中文/字母/数字/下划线）：', state.user.username);
    if (!name || name.trim() === state.user.username) return;
    try {
      const data = await api('/rename', { method: 'POST', body: { username: name.trim() } });
      state.user = data.user;
      renderLobby();
      toast('昵称已改为 ' + data.user.username);
    } catch (e) { toast(e.message, 'error'); }
  };
  $('btn-join-id').onclick = () => {
    const id = $('join-room-id').value.trim();
    if (!id) { toast('请输入房间号，例如 R1', 'error'); return; }
    joinRoom(id);
  };
  $('join-room-id').onkeydown = (e) => {
    if (e.key === 'Enter') $('btn-join-id').click();
  };
  // 商店预览的 购买/装备 按钮
  $('skin-preview-btn').onclick = async () => {
    const item = (state.cfg?.shop || []).find(s => s.id === previewItemId);
    if (!item) return;
    const owned = state.user.bought.includes(item.id);
    try {
      if (owned) {
        const data = await api('/shop/equip', { method: 'POST', body: { id: item.id } });
        state.user = data.user;
      } else {
        await api('/shop/buy', { method: 'POST', body: { id: item.id } });
        const data = await api('/shop/equip', { method: 'POST', body: { id: item.id } }); // 买完自动穿上
        state.user = data.user;
      }
      renderLobby();
      renderShop();
      toast(owned ? '已装备 ' + item.name : '已购买并装备 ' + item.name);
    } catch (e) { toast(e.message, 'error'); }
  };
  $('lobby-chat-input').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      state.socket?.emit('room:chat', { text: e.target.value.trim() });
      e.target.value = '';
    }
  };
}

async function createRoom() {
  const res = await new Promise(resolve => {
    state.socket.emit('room:create', { mode: state.mode, scenery: state.scenery }, resolve);
  });
  if (!res.ok) toast(res.msg || '创建失败', 'error');
  else openShareModal(res.id); // 创建成功顺手弹邀请链接
}

async function joinRoom(id) {
  const res = await new Promise(resolve => {
    state.socket.emit('room:join', { id }, resolve);
  });
  if (!res.ok) toast(res.msg || '加入失败', 'error');
}

function quickJoin() {
  const target = state.rooms.find(r => r.state !== 'battle' && r.mode === state.mode && r.players < r.max);
  if (target) joinRoom(target.id);
  else createRoom();
}

// ---------- 邀请链接 ----------
function copyText(text) {
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  };
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacy());
  }
  return Promise.resolve(legacy());
}

// 生成所有可用的邀请链接（公网部署给域名，本地开发给局域网网卡）
async function buildShareLinks(roomId) {
  const links = [];
  const port = location.port ? ':' + location.port : '';
  const proto = location.protocol === 'https:' ? 'https:' : 'http:';
  const mk = (hostname) => `${proto}//${hostname}${port}/?room=${roomId}`;
  if (!/^(localhost|127\.|0\.)/.test(location.hostname)) {
    // 公网/域名部署：直接给当前域名链接
    links.push({ label: '邀请链接', url: mk(location.hostname) });
    return links;
  }
  try {
    const d = await api('/lan');
    for (const addr of d.addrs || []) links.push({ label: '局域网 ' + addr, url: mk(addr) });
  } catch { /* 拿不到就只用当前地址 */ }
  if (!links.length) links.push({ label: '本机', url: mk(location.hostname) });
  return links;
}

async function openShareModal(roomId) {
  if (!roomId) return;
  const modal = $('share-modal');
  const box = $('share-links');
  box.innerHTML = '<p class="muted">生成中…</p>';
  modal.classList.remove('hidden');
  const links = await buildShareLinks(roomId);
  box.innerHTML = '';
  links.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `<div class="share-info"><b>${l.label}</b><span>${l.url}</span></div><button class="btn small">复制</button>`;
    row.querySelector('button').onclick = () => copyText(l.url).then(ok =>
      toast(ok ? '链接已复制，发给好友吧（需同一 WiFi/局域网）' : '复制失败，请手动长按/选中链接复制', ok ? '' : 'error'));
    box.appendChild(row);
    if (i === 0) copyText(l.url); // 自动复制首选链接
  });
}

// 通过 ?room= 链接进来的自动加入
let autoJoinTries = 0;
function maybeAutoJoin() {
  if (!state.pendingRoom || state.room || state.game) return;
  if ($('page-lobby').classList.contains('hidden')) return;
  const target = state.rooms.find(r => r.id === state.pendingRoom);
  if (target && target.state !== 'battle') {
    const id = state.pendingRoom;
    state.pendingRoom = null;
    joinRoom(id);
  } else if (++autoJoinTries > 6) { // 大厅约2秒推一次，等不到就放弃
    toast('邀请的房间不存在或已开始战斗', 'error');
    state.pendingRoom = null;
  }
}

// ---------- 房间 ----------
function renderRoom(room) {
  state.room = room;
  $('room-name').textContent = room.name;
  const modeName = { solo: '单人', duo: '双人', squad: '四人' }[room.mode] || room.mode;
  const scName = { dawn: '黎明', day: '白天', dusk: '黄昏', night: '夜晚' }[room.scenery] || room.scenery;
  $('room-meta').textContent = `${modeName} · ${scName} · 房间号 ${room.id} · ${room.players.length}/${room.max}人`;
  const allReady = room.players.every(p => p.ready || p.id === room.hostUserId);
  $('room-hint').textContent = allReady
    ? '全员已准备，房主可点击"立即开始"（机器人补位）'
    : '等待所有玩家准备，全员准备后房主才能开始';
  const box = $('room-players');
  box.innerHTML = '';
  // 按小队分组显示（同队一起打）
  const squadSize = { solo: 1, duo: 2, squad: 4 }[room.mode] || 4;
  const teams = [];
  room.players.forEach((p, i) => {
    const t = Math.floor(i / squadSize);
    (teams[t] = teams[t] || []).push(p);
  });
  teams.forEach((members, ti) => {
    if (room.mode !== 'solo') {
      const label = document.createElement('div');
      label.className = 'team-label';
      label.textContent = members.some(m => m.id === state.user.id) ? `小队 ${ti + 1}（你的队伍）` : `小队 ${ti + 1}`;
      box.appendChild(label);
    }
    for (const p of members) {
      const div = document.createElement('div');
      div.className = 'rp-item';
      const isHost = p.id === room.hostUserId;
      const me = p.id === state.user.id;
      div.innerHTML = `
        <span class="rname">${escapeHtml(p.name)}${me ? '（你）' : ''}</span>
        ${isHost ? '<span class="tag host">房主</span>' : ''}
        ${!isHost ? `<span class="tag ${p.ready ? 'ready' : 'unready'}">${p.ready ? '已准备' : '未准备'}</span>` : ''}`;
      box.appendChild(div);
    }
  });
  if (room.mode !== 'solo' && teams.length > 1) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.style.fontSize = '12px';
    hint.textContent = `按加入顺序自动分队（每队 ${squadSize} 人），想和好友同队就一起进房吧`;
    box.appendChild(hint);
  }
  const mePlayer = room.players.find(p => p.id === state.user.id);
  const isHost = mePlayer && mePlayer.id === room.hostUserId;
  $('btn-ready').textContent = mePlayer && mePlayer.ready ? '取消准备' : '准备';
  $('btn-ready').classList.toggle('primary', !(mePlayer && mePlayer.ready));
  $('btn-room-start').classList.toggle('hidden', !isHost);
  $('btn-room-start').disabled = !room.players.every(p => p.ready || p.id === room.hostUserId);
}

function bindRoom() {
  $('btn-ready').onclick = () => {
    const ready = !(state.room?.players.find(p => p.id === state.user.id)?.ready);
    state.socket.emit('room:ready', { ready });
  };
  $('btn-room-start').onclick = () => {
    state.socket.emit('room:start', {}, (res) => { if (res && !res.ok) toast(res.msg, 'error'); });
  };
  $('btn-room-leave').onclick = leaveRoom;
  $('btn-copy-invite').onclick = () => openShareModal(state.room?.id);
  $('room-chat-input').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      state.socket.emit('chat', { ch: 'room', text: e.target.value.trim() });
      e.target.value = '';
    }
  };
}

function leaveRoom() {
  state.socket?.emit('room:leave');
  state.room = null;
  showPage('lobby');
}

// ---------- Socket ----------
function connectSocket() {
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('lobby', (m) => {
    state.rooms = m.rooms || [];
    $('online-count').textContent = '在线 ' + m.online;
    if (!state.room && !$('page-lobby').classList.contains('hidden')) renderRooms();
    maybeAutoJoin();
  });

  socket.on('room', (room) => {
    if (state.game) return; // 战斗中忽略
    const meIn = room.players.some(p => p.id === state.user.id);
    if (!meIn) { state.room = null; showPage('lobby'); return; }
    if ($('page-room').classList.contains('hidden')) showPage('room');
    renderRoom(room);
  });

  socket.on('chat', (m) => {
    const log = m.ch === 'lobby' ? $('lobby-chatlog')
      : m.ch === 'room' ? $('room-chatlog')
      : state.game ? null : null;
    if (log) appendChat(log, m);
    else if (state.game) state.game.onChat(m);
  });

  socket.on('battle', (m) => { state.pendingBattle = m; });
  socket.on('battle:you', (m) => { launchGame(m); });
  socket.on('battle:over', () => { /* 结算由 end 事件处理 */ });

  socket.on('toast', (m) => toast(m.msg || ''));

  socket.on('err', (m) => {
    toast(m.msg || '发生错误', 'error');
    if (/过期|封禁|移出/.test(m.msg || '')) {
      if (state.game) { state.game.dispose(); state.game = null; }
      if (/过期|封禁/.test(m.msg)) { localStorage.removeItem('fz_token'); location.reload(); }
    }
  });

  socket.on('connect_error', (e) => {
    if (/过期|封禁|未登录|账号/.test(e.message || '')) {
      localStorage.removeItem('fz_token');
      toast('登录已失效，请重新登录', 'error');
      setTimeout(() => location.reload(), 1200);
    }
  });

  socket.on('disconnect', () => {
    if (state.game) {
      toast('与服务器断开连接', 'error');
      exitBattle();
    }
  });
}

function appendChat(log, m) {
  const p = document.createElement('p');
  const who = m.ch === 'team' ? '[队伍] ' : m.ch === 'lobby' ? '[大厅] ' : '';
  p.innerHTML = `<b>${who}${escapeHtml(m.from)}</b>: ${escapeHtml(m.text)}`;
  log.appendChild(p);
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

// ---------- 战斗 ----------
function launchGame(youData) {
  if (!state.pendingBattle) return;
  showPage('battle');
  $('battle-loading').classList.remove('hidden');
  if (state.game) { state.game.dispose(); state.game = null; }
  // 必须同步创建：开局后服务器还会推一次房间状态，若此时 Game 未创建，
  // 房间事件会把页面翻回房间页，战斗就"看不见"了
  try {
    state.game = new Game({
      socket: state.socket,
      user: state.user,
      cfg: state.cfg || { weapons: [], vehicles: [], shop: [] },
      battle: state.pendingBattle,
      you: youData,
      onExit: exitBattle,
    });
  } catch (e) {
    console.error('战斗初始化失败:', e);
    toast('战斗初始化失败：' + e.message, 'error');
    exitBattle();
  }
  state.pendingBattle = null;
  // 后台刷新账号信息（GM 授权等），不阻塞开局；GM 能力变化时热更新
  api('/me').then((d) => {
    state.user = d.user;
    if (state.game && !state.game.disposed) {
      state.game.isAdmin = d.user.role === 'admin' || !!d.user.gm;
      const panel = document.querySelector('#gm-panel');
      if (panel) panel.classList.toggle('hidden', !state.game.isAdmin);
    }
  }).catch(() => {});
}

function exitBattle() {
  if (state.game) { state.game.dispose(); state.game = null; }
  state.socket?.emit('room:leave');
  state.room = null;
  showPage('lobby');
  renderLobby();
  loadLeaderboard();
  // 刷新用户数据（金币/战绩）
  api('/me').then(d => { state.user = d.user; renderLobby(); }).catch(() => {});
}

// ---------- 启动 ----------
function boot() {
  bindAuth();
  bindLobby();
  bindRoom();
  // 邀请链接：/?room=R1 自动加入
  const qp = new URLSearchParams(location.search);
  const roomParam = qp.get('room');
  if (roomParam) {
    state.pendingRoom = roomParam;
    history.replaceState(null, '', location.pathname);
  }
  const shareModal = $('share-modal');
  $('share-close').onclick = () => shareModal.classList.add('hidden');
  shareModal.onclick = (e) => { if (e.target === shareModal) shareModal.classList.add('hidden'); };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (state.token) {
    api('/me')
      .then(d => { state.user = d.user; enterLobby(); })
      .catch(() => { localStorage.removeItem('fz_token'); state.token = null; showPage('login'); });
  } else {
    showPage('login');
  }
}
boot();
