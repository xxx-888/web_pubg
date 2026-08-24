// JSON 文件数据库：读取/保存 + 首次运行种子数据
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_WEAPONS = [
  { id: 'fists',   name: '拳头',   type: 'melee',   dmg: 22,  rate: 420,  mag: 0,  reload: 0,    range: 2.6, ammo: '',      spread: 0,    color: 0xcccccc },
  { id: 'p92',     name: 'P92',    type: 'pistol',  dmg: 24,  rate: 240,  mag: 15, reload: 1600, range: 80,  ammo: 'light', spread: 0.02, color: 0x4a4a52 },
  { id: 'vector',  name: 'Vector', type: 'smg',     dmg: 17,  rate: 80,   mag: 25, reload: 2200, range: 120, ammo: 'light', spread: 0.028, color: 0x3d4a55 },
  { id: 'm4',      name: 'M4',     type: 'ar',      dmg: 27,  rate: 115,  mag: 30, reload: 2400, range: 320, ammo: 'heavy', spread: 0.014, color: 0x35403a },
  { id: 'ak',      name: 'AK47',   type: 'ar',      dmg: 34,  rate: 135,  mag: 30, reload: 2600, range: 320, ammo: 'heavy', spread: 0.02, color: 0x5a3d28 },
  { id: 'mini14',  name: 'Mini14', type: 'dmr',     dmg: 40,  rate: 300,  mag: 20, reload: 2600, range: 520, ammo: 'heavy', spread: 0.006, color: 0x6b5335 },
  { id: 's686',    name: 'S686',   type: 'shotgun', dmg: 11,  rate: 900,  mag: 2,  reload: 2800, range: 45,  ammo: 'shell', spread: 0.075, pellets: 8, color: 0x702d2d },
  { id: 'awm',     name: 'AWM',    type: 'sniper',  dmg: 110, rate: 1600, mag: 5,  reload: 3600, range: 800, ammo: 'sniper', spread: 0.001, color: 0x2e3440 },
];

const DEFAULT_VEHICLES = [
  { id: 'buggy',   name: '越野摩托', speed: 26, hp: 420, color: 0xc2a23a },
  { id: 'sedan',   name: '轿车',     speed: 23, hp: 620, color: 0x3a6ac2 },
  { id: 'pickup',  name: '皮卡',     speed: 21, hp: 760, color: 0x8a4a2a },
];

const DEFAULT_MAPS = [
  { id: 'island', name: '烽区岛', size: 800, seed: 20260821 },
];

const DEFAULT_SHOP = [
  { id: 'skin_default', name: '新兵（默认）', color: '#7a8a5a', price: 0,   parts: { torso: '#7a8a5a', arms: '#6d7c50', legs: '#3f4450', pack: '#4a4336' } },
  { id: 'skin_red',     name: '赤焰',   color: '#c23b3b', price: 300,  parts: { torso: '#c23b3b', arms: '#a53333', legs: '#57272a', pack: '#6e2f2f' } },
  { id: 'skin_blue',    name: '深海',   color: '#3b6ac2', price: 300,  parts: { torso: '#3b6ac2', arms: '#33589f', legs: '#26375c', pack: '#2f4a7a' } },
  { id: 'skin_green',   name: '丛林',   color: '#3a8a4a', price: 500,  parts: { torso: '#3a8a4a', arms: '#2f7040', legs: '#2c4632', pack: '#37452e' } },
  { id: 'skin_gold',    name: '沙金',   color: '#c2a23a', price: 800,  parts: { torso: '#c2a23a', arms: '#a8892f', legs: '#6e5c26', pack: '#8a6e2a' } },
  { id: 'skin_black',   name: '夜行',   color: '#2c2c34', price: 800,  parts: { torso: '#2c2c34', arms: '#232329', legs: '#1a1a20', pack: '#33302a' } },
  { id: 'skin_desert',  name: '荒漠',   color: '#c8ad7a', price: 1000, parts: { torso: '#c8ad7a', arms: '#b89a68', legs: '#8a734e', pack: '#6e5c3e' } },
  { id: 'skin_pink',    name: '樱花',   color: '#d98ab0', price: 1200, parts: { torso: '#d98ab0', arms: '#c07a9c', legs: '#7a4a60', pack: '#9c6480' } },
  { id: 'skin_white',   name: '雪地',   color: '#d8d8de', price: 1500, parts: { torso: '#d8d8de', arms: '#c5c5cc', legs: '#8a8a94', pack: '#a8a8b2' } },
  { id: 'skin_swat',    name: '特勤黑金', color: '#23262d', price: 2000, parts: { torso: '#23262d', arms: '#1d2026', legs: '#191c22', pack: '#5a4a22' } },
];

function defaultDb() {
  return {
    settings: {
      secret: crypto.randomBytes(24).toString('hex'),
      totalPlayers: 60,       // 每局总人数（人 + 机器人补位），上限 100
      tickHz: 20,
      botAcc: 0.65,           // 机器人命中系数
      rewards: { kill: 10, win: 200, top10: 50, join: 10 },
    },
    users: [
      {
        id: 1, username: 'admin', password: bcrypt.hashSync('admin123', 10), role: 'admin',
        coins: 99999, skin: 'skin_default', bought: ['skin_default'],
        stats: { kills: 0, deaths: 0, wins: 0, games: 0 }, banned: false, createdAt: Date.now(),
      },
      {
        id: 2, username: 'demo', password: bcrypt.hashSync('1234', 10), role: 'user',
        coins: 1200, skin: 'skin_blue', bought: ['skin_default', 'skin_blue'],
        stats: { kills: 3, deaths: 5, wins: 0, games: 5 }, banned: false, createdAt: Date.now(),
      },
      {
        id: 3, username: 'demo2', password: bcrypt.hashSync('1234', 10), role: 'user',
        coins: 800, skin: 'skin_red', bought: ['skin_default', 'skin_red'],
        stats: { kills: 1, deaths: 2, wins: 0, games: 2 }, banned: false, createdAt: Date.now(),
      },
    ],
    nextUserId: 4,
    weapons: DEFAULT_WEAPONS,
    vehicles: DEFAULT_VEHICLES,
    maps: DEFAULT_MAPS,
    shop: DEFAULT_SHOP,
  };
}

let db = null;
let dirty = false;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const bak = DB_FILE + '.bak.' + Date.now();
      fs.copyFileSync(DB_FILE, bak);
      console.error('[db] db.json 解析失败，已备份到 ' + bak + '，使用新数据库');
      db = defaultDb();
      saveNow();
    }
  } else {
    db = defaultDb();
    saveNow();
  }
  // 补齐缺失字段（升级兼容）
  const def = defaultDb();
  for (const k of Object.keys(def)) if (db[k] === undefined) db[k] = def[k];
  // 老皮肤数据迁移：补多部件配色 parts
  for (const item of db.shop) {
    if (!item.parts) {
      const d = def.shop.find(s => s.id === item.id);
      if (d && d.parts) item.parts = d.parts;
    }
  }
  // 新增商品合并进来（老库没有的新衣服）
  for (const d of def.shop) {
    if (!db.shop.some(s => s.id === d.id)) db.shop.push(d);
  }
  return db;
}

export function markDirty() {
  dirty = true;
  if (!saveTimer) saveTimer = setTimeout(saveNow, 3000);
}

export function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!db) return;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
  } catch (e) {
    console.error('[db] 保存失败:', e.message);
  }
}

export function getDb() { return loadDb(); }

export function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}
