// 战斗核心：房间管理 + 战斗引擎（机器人 AI / 毒圈 / 空投 / 载具 / 命中校验）
import { Terrain } from '../shared/terrain.js';
import { getDb, markDirty } from './db.js';

const TICK_MS = 50;
const PLANE_Y = 380;
const PLANE_SPEED = 85;
const EYE_STAND = 1.62, EYE_CROUCH = 1.15;
const ZONE_PHASES = [
  { wait: 50, shrink: 55, dps: 1,  r: 0.62 },
  { wait: 45, shrink: 45, dps: 2,  r: 0.45 },
  { wait: 35, shrink: 35, dps: 4,  r: 0.32 },
  { wait: 30, shrink: 30, dps: 7,  r: 0.22 },
  { wait: 25, shrink: 25, dps: 10, r: 0.14 },
  { wait: 20, shrink: 20, dps: 14, r: 0.08 },
  { wait: 15, shrink: 15, dps: 20, r: 0.02 },
];
const AMMO_GIVE = { light: 30, heavy: 30, shell: 8, sniper: 5 };
const VEST_REDUCE = [0, 0.10, 0.20, 0.30];
const HELMET_REDUCE = [0, 0.15, 0.30, 0.45];

const BOT_NAMES = [
  '孤狼Kira', '夜雨声烦', '平底锅战神', '老六蹲草', '快递员小张', '伏地魔本魔', '98K上头', '刚枪小王',
  '毒圈钉子户', '天命圈皇', '三级头哥哥', '医疗兵阿花', '东北虎哥', '海南鸡饭', '沙漠之鹰', '雨林莽夫',
  '空投猎人', '载具杀手', '趴地战术大师', '一枪一个', '苟到决赛圈', '跑毒冠军', '平底锅護體', '手雷忘拿了',
  '落地成盒', '天选之人', '零杀吃鸡', '海景房房东', '桥头守望者', '麦田守望者', '加油站站长', '灯塔看守',
  '山頂洞人', '峡谷之巅', '海滨漫步者', '码头渔夫', '工厂保安', '哨塔观察员', '小镇理发师', '废墟探险家',
  '子弹不够用', '换弹癌晚期', '开镜手抖', '腰射大神', '闪身枪王', '拜佛枪法', '秒蹲达人', '跳枪少年',
  ' zipline', 'M4稳如狗', 'AK泼水怪', '狙神本神', '盲狙选手', '移动靶', '固定靶', '人体描边',
  '幸运儿', '倒霉蛋', '天降正义', '轰炸区常客', '油箱中弹', '翻车现场', '安全区边缘', '决赛圈舞王',
];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = (v) => Math.round(v * 100) / 100;

function dist2(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

// ---------- 射线工具 ----------
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t;
}

function rayBox(ox, oy, oz, dx, dy, dz, b) {
  // slab 法，轴对齐建筑
  const min = [b.x - b.w / 2, b.y, b.z - b.d / 2];
  const max = [b.x + b.w / 2, b.y + b.h, b.z + b.d / 2];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
    } else {
      let t1 = (min[i] - o[i]) / d[i], t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// ---------- 战斗实体 ----------
let entSeq = 1;

class Fighter {
  constructor(opts) {
    this.id = 'e' + (entSeq++);
    this.name = opts.name;
    this.isBot = !!opts.isBot;
    this.team = opts.team;
    this.socketId = opts.socketId || null;
    this.userId = opts.userId || null;
    this.role = opts.role || 'user';
    this.skin = opts.skin || '#7a8a5a';
    // 位置/朝向（服务端权威副本）
    this.x = 0; this.y = PLANE_Y; this.z = 0;
    this.yaw = 0; this.pitch = 0;
    this.vx = 0; this.vy = 0; // 机器人/载具用
    this.hp = 100;
    this.st = 'p'; // p飞机 f跳伞 c伞 g地面 v载具 d死亡
    this.cr = false; // 蹲
    this.moving = false;
    this.alive = true;
    this.vehId = null;
    this.weapons = [null, null]; // {wid, mag}
    this.cur = 0;
    this.ammo = { light: 0, heavy: 0, shell: 0, sniper: 0 };
    this.meds = { bandage: 0, medkit: 0 };
    this.vest = 0; this.helmet = 0;
    this.kills = 0; this.dmg = 0; this.rank = 0;
    this.nextShotAt = 0; this.reloadEnd = 0; this.healEnd = 0; this.healItem = null;
    this.god = false; this.infAmmo = false;
    this.lastStateAt = 0; this.viol = 0;
    this.ai = opts.isBot ? {
      nextThink: 0, moveTarget: null, enemy: null, enemySince: 0, reactMs: rnd(500, 1300),
      jumpT: rnd(0.1, 0.85), acc: 0, burstLeft: 0, nextBurstAt: 0, strafeDir: 1, strafeAt: 0, lootT: null,
    } : null;
    if (this.isBot) this.ai.acc = clamp(getDb().settings.botAcc + rnd(-0.18, 0.18), 0.2, 0.95);
  }

  get weapon() {
    if (this.st === 'v') return null;
    const w = this.weapons[this.cur];
    return w ? this.wdef(w.wid) : this.wdef('fists');
  }
  wdef(wid) { return getDb().weapons.find(w => w.id === wid) || null; }
  eyeY() { return this.y + (this.cr ? EYE_CROUCH : EYE_STAND); }
  invPayload() {
    return {
      w: this.weapons.map(w => w ? { wid: w.wid, mag: w.mag } : null),
      cur: this.cur, am: this.ammo, md: this.meds, vest: this.vest, helmet: this.helmet,
    };
  }
}

// ---------- 战斗 ----------
export class Battle {
  constructor(room, mapDef) {
    this.room = room;
    this.io = room.io;
    this.mapDef = mapDef;
    this.terrain = new Terrain(mapDef.seed, mapDef.size);
    this.entities = new Map();
    this.vehicles = new Map();
    this.loot = new Map();
    this.crates = new Map(); // 空投箱
    this.lootAdd = []; this.lootRm = [];
    this.booms = [];
    this.startedAt = Date.now();
    this.ended = false;
    this.tickCount = 0;
    this.nextLootId = 1;
    this.nextVehId = 1;
    this.zoneDmgAt = 0;
    this.nextAirAt = 0;
    this.airSeq = 1;

    // 毒圈
    const s = mapDef.size;
    this.zone = {
      cx: rnd(-90, 90), cz: rnd(-90, 90), r: s * 0.54,
      nx: 0, nz: 0, nr: s * 0.54,
      phase: -1, st: 'wait', t: 8,
    };
    this._advanceZonePhase();

    // 飞机航线（终点落在岛屿边缘内，防自动弹射到深水）
    const ang = Math.random() * Math.PI * 2;
    const R = s * 0.38;
    this.plane = {
      fx: Math.cos(ang) * R, fz: Math.sin(ang) * R,
      tx: -Math.cos(ang) * R, tz: -Math.sin(ang) * R,
      t: -3.5, // 起飞前缓冲
      dur: (2 * R) / PLANE_SPEED,
      active: true,
      x: 0, y: PLANE_Y, z: 0,
    };
  }

  start() {
    const db = getDb();
    const settings = db.settings;
    const total = clamp(settings.totalPlayers, 2, 100);
    const squadSize = this.room.squadSize();
    const humans = [...this.room.players.values()];
    const teams = [];

    // 人类按进房顺序分队伍
    humans.forEach((p, i) => teams.push(Math.floor(i / squadSize)));
    let maxTeam = humans.length ? Math.max(...teams) : -1;
    const fighters = humans.map((p, i) => new Fighter({
      name: p.user.username, team: teams[i], socketId: p.sid, userId: p.user.id,
      role: p.user.role, skin: this._skinOutfit(p.user.skin), isBot: false,
    }));
    const botCount = Math.max(0, total - fighters.length);
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < botCount; i++) {
      // 先填满人类残队，再新建机器人队伍
      let team;
      const used = fighters.filter(f => !f.isBot || f.team <= maxTeam).map(f => f.team);
      const counts = new Map();
      for (const t of new Set(used)) counts.set(t, used.filter(x => x === t).length);
      const open = [...counts.entries()].find(([, c]) => c < squadSize);
      if (open) team = open[0];
      else { maxTeam += 1; team = maxTeam; }
      fighters.push(new Fighter({
        name: names[i % names.length] + (i >= names.length ? i : ''), team, isBot: true,
        skin: this._skinOutfit(pick(getDb().shop).id), // 机器人穿商城服装
      }));
    }
    for (const f of fighters) this.entities.set(f.id, f);

    this._spawnLoot();
    this._spawnVehicles();
    this.nextAirAt = Date.now() + 75000;

    // 开局数据包
    const payload = {
      you: null, map: { seed: this.mapDef.seed, size: this.mapDef.size },
      scenery: this.room.scenery, mode: this.room.mode,
      plane: { fx: this.plane.fx, fz: this.plane.fz, tx: this.plane.tx, tz: this.plane.tz, dur: this.plane.dur },
      total: fighters.length, now: Date.now(),
      names: this._namesPayload(),
      loot: [...this.loot.values()],
      vehicles: [...this.vehicles.values()].map(v => this._vRow(v)),
    };
    this.io.to(this.room.id).emit('battle', payload);
    for (const f of fighters) {
      if (!f.isBot && f.socketId) {
        this.io.to(f.socketId).emit('battle:you', { id: f.id, inv: f.invPayload() });
      }
    }

    this.timer = setInterval(() => {
      try { this.tick(); }
      catch (e) { console.error('[battle] tick 异常:', e); }
    }, TICK_MS);
    // 保险：最长 25 分钟强制结算
    this.hardStop = setTimeout(() => { if (!this.ended) this._finish(); }, 25 * 60 * 1000);
  }

  _skinOutfit(skinId) {
    const it = getDb().shop.find(s => s.id === skinId);
    if (!it) return { torso: '#7a8a5a', arms: '#6d7c50', legs: '#3f4450', pack: '#4a4336' };
    if (it.parts) return it.parts;
    return { torso: it.color, arms: it.color, legs: '#3a3f4a', pack: '#4a4336' };
  }

  _namesPayload() {
    const m = {};
    for (const f of this.entities.values()) m[f.id] = { n: f.name, t: f.team, b: f.isBot, sk: f.skin };
    return m;
  }

  _vRow(v) {
    return { id: v.id, type: v.type, x: r2(v.x), y: r2(v.y), z: r2(v.z), yaw: r2(v.yaw), hp: Math.round(v.hp), drv: v.driver || null };
  }

  _spawnLoot() {
    const spots = this.terrain.lootSpots();
    const wPool = [
      ['p92', 22], ['vector', 18], ['m4', 18], ['ak', 16], ['mini14', 12], ['s686', 10], ['awm', 4],
    ];
    const wTotal = wPool.reduce((a, b) => a + b[1], 0);
    const pickW = () => {
      let r = Math.random() * wTotal;
      for (const [id, w] of wPool) { r -= w; if (r <= 0) return id; }
      return 'p92';
    };
    for (const s of spots) {
      if (Math.random() > 0.85) continue;
      const roll = Math.random();
      if (roll < 0.33) {
        const wid = pickW();
        const w = getDb().weapons.find(x => x.id === wid);
        this._addLoot({ kind: 'weapon', wid, x: s.x, y: s.y, z: s.z });
        if (Math.random() < 0.6) this._addLoot({ kind: 'ammo', at: w.ammo, cnt: AMMO_GIVE[w.ammo], x: s.x + rnd(-2, 2), y: s.y, z: s.z + rnd(-2, 2) });
      } else if (roll < 0.60) {
        const at = pick(['light', 'heavy', 'heavy', 'shell', 'sniper']);
        this._addLoot({ kind: 'ammo', at, cnt: AMMO_GIVE[at], x: s.x, y: s.y, z: s.z });
      } else if (roll < 0.82) {
        const med = Math.random() < 0.72 ? 'bandage' : 'medkit';
        this._addLoot({ kind: 'med', med, cnt: med === 'bandage' ? 2 : 1, x: s.x, y: s.y, z: s.z });
      } else {
        const ar = Math.random() < 0.5 ? 'vest' : 'helmet';
        const lv = Math.random() < 0.5 ? 1 : Math.random() < 0.75 ? 2 : 3;
        this._addLoot({ kind: 'armor', ar, lv, x: s.x, y: s.y, z: s.z });
      }
    }
  }

  _addLoot(base) {
    const id = 'L' + (this.nextLootId++);
    const y = base.y != null ? base.y : this.terrain.height(base.x, base.z) + 0.15;
    const item = { id, x: r2(base.x), y: r2(y), z: r2(base.z), ...base };
    this.loot.set(id, item);
    this.lootAdd.push(item);
    return item;
  }

  _spawnVehicles() {
    const types = getDb().vehicles;
    const towns = this.terrain.towns();
    for (let i = 0; i < 20; i++) {
      let ok = false, x = 0, z = 0, tries = 0;
      while (!ok && tries++ < 40) {
        if (Math.random() < 0.6 && towns.length) {
          // 城镇附近优先，玩家更容易找到车
          const t = pick(towns);
          x = t.x + rnd(-45, 45); z = t.z + rnd(-45, 45);
        } else {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.mapDef.size * 0.4;
          x = Math.cos(a) * r; z = Math.sin(a) * r;
        }
        const h = this.terrain.height(x, z);
        ok = h > 1.2 && h < 30 && !this._vehHitsWall(x, z, 3) && !this.terrain.hitsObstacle(x, z, 3); // 不刷在墙体/大石头里
      }
      if (!ok) continue;
      const type = pick(types);
      const id = 'V' + (this.nextVehId++);
      this.vehicles.set(id, {
        id, type: type.id, x, z, y: this.terrain.height(x, z),
        yaw: Math.random() * Math.PI * 2, speed: 0, hp: type.hp, maxHp: type.hp, driver: null,
      });
    }
  }

  // ---------- 主循环 ----------
  tick() {
    if (this.ended) return;
    const now = Date.now();
    const dt = TICK_MS / 1000;
    this.tickCount++;

    this._tickPlane(dt);
    this._tickZone(now, dt);
    this._tickBots(now, dt);
    this._tickVehicles(dt);
    this._tickFighters(now, dt);
    this._tickAirdrops(now, dt);
    this._tickBooms(now);
    this._checkEnd();

    this._broadcast(now);
  }

  _tickPlane(dt) {
    const p = this.plane;
    if (!p.active) return;
    p.t += dt;
    const k = clamp(p.t / p.dur, 0, 1);
    p.x = p.fx + (p.tx - p.fx) * k;
    p.z = p.fz + (p.tz - p.fz) * k;
    p.y = PLANE_Y;
    for (const f of this.entities.values()) {
      if (f.st !== 'p') continue;
      f.x = p.x; f.y = p.y; f.z = p.z;
      if (f.isBot && p.t >= f.ai.jumpT) this._eject(f);
    }
    if (p.t >= p.dur) {
      for (const f of this.entities.values()) if (f.st === 'p') this._eject(f);
      p.active = false;
    }
  }

  _eject(f) {
    if (f.st !== 'p') return;
    f.st = 'f'; f.vy = -10;
    if (f.isBot) {
      const spots = this.terrain.buildings();
      let tx, tz;
      if (Math.random() < 0.65 && spots.length) {
        const b = pick(spots);
        tx = b.x + rnd(-30, 30); tz = b.z + rnd(-30, 30);
      } else {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.mapDef.size * 0.4;
        tx = Math.cos(a) * r; tz = Math.sin(a) * r;
      }
      f.ai.landTarget = { x: tx, z: tz };
    }
  }

  _tickZone(now, dt) {
    const z = this.zone;
    z.t -= dt;
    if (z.st === 'wait' && z.t <= 0) {
      z.st = 'shrink'; z.t = ZONE_PHASES[z.phase].shrink;
      this._pickNextCircle();
    } else if (z.st === 'shrink') {
      const ph = ZONE_PHASES[z.phase];
      const k = clamp(1 - z.t / ph.shrink, 0, 1);
      z.r = z.r0 + (z.nr - z.r0) * k;
      z.cx = z.cx0 + (z.nx - z.cx0) * k;
      z.cz = z.cz0 + (z.nz - z.cz0) * k;
      if (z.t <= 0) { this._advanceZonePhase(); }
    }
    // 圈外伤害（每秒）
    if (now >= this.zoneDmgAt) {
      this.zoneDmgAt = now + 1000;
      const dps = ZONE_PHASES[Math.max(0, z.phase)].dps;
      for (const f of this.entities.values()) {
        if (!f.alive || f.st === 'p') continue;
        if (dist2(f.x, f.z, z.cx, z.cz) > z.r) {
          this._damage(f, dps, null, '毒圈', false);
        }
        const th = this.terrain.height(f.x, f.z);
        if (f.st !== 'v' && f.y < th - 0.4) f.y = th; // 防钻地
        if (th < -1.6 && f.st !== 'v' && f.y < 0.2) this._damage(f, 5, null, '溺水', false); // 深水
      }
    }
  }

  _advanceZonePhase() {
    const z = this.zone;
    z.phase++;
    if (z.phase >= ZONE_PHASES.length) { z.st = 'done'; z.t = 999; z.nr = z.r; z.nx = z.cx; z.nz = z.cz; return; }
    z.st = 'wait';
    z.t = ZONE_PHASES[z.phase].wait;
    z.nr = ZONE_PHASES[z.phase].r * this.mapDef.size * 0.54;
  }

  _pickNextCircle() {
    const z = this.zone;
    z.r0 = z.r; z.cx0 = z.cx; z.cz0 = z.cz;
    // 下一圈圆心在当前圈内
    const maxOff = Math.max(0, z.r - z.nr);
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * maxOff * 0.8;
    z.nx = clamp(z.cx + Math.cos(a) * d, -this.mapDef.size * 0.45, this.mapDef.size * 0.45);
    z.nz = clamp(z.cz + Math.sin(a) * d, -this.mapDef.size * 0.45, this.mapDef.size * 0.45);
  }

  _tickBots(now, dt) {
    for (const f of this.entities.values()) {
      if (!f.isBot || !f.alive) continue;
      if (f.st === 'p') continue;
      const ai = f.ai;
      const h = this.terrain.height(f.x, f.z);

      if (f.st === 'f' || f.st === 'c') {
        // 降落
        const target = ai.landTarget || { x: 0, z: 0 };
        if (f.st === 'f') {
          f.vy = Math.max(f.vy - 30 * dt, -55);
          if (f.y - h < 130) f.st = 'c';
        } else {
          f.vy = -7;
        }
        const dx = target.x - f.x, dz = target.z - f.z;
        const d = Math.hypot(dx, dz);
        if (d > 2) {
          const sp = f.st === 'f' ? 9 : 11;
          f.x += (dx / d) * sp * dt; f.z += (dz / d) * sp * dt;
          f.yaw = Math.atan2(dx, dz);
          f.moving = true;
        } else f.moving = false;
        f.y += f.vy * dt;
        if (f.y <= h + 0.1) { f.y = h; f.st = 'g'; f.moving = false; }
        continue;
      }
      if (f.st !== 'g') continue;

      // 决策（节流）
      if (now >= ai.nextThink) {
        ai.nextThink = now + rnd(280, 560);
        this._botThink(f, now);
      }

      // 落水则朝岛心游
      if (this.terrain.height(f.x, f.z) < 0.4) {
        const d = Math.hypot(f.x, f.z) || 1;
        ai.moveTarget = { x: f.x - f.x / d * 40, z: f.z - f.z / d * 40 };
        f.moving = true;
      }

      // 移动
      if (ai.moveTarget) {
        const dx = ai.moveTarget.x - f.x, dz = ai.moveTarget.z - f.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.6) {
          ai.moveTarget = null; f.moving = false;
        } else {
          const sp = ai.enemy ? 4.4 : 5.6;
          f.x += (dx / d) * sp * dt; f.z += (dz / d) * sp * dt;
          if (!ai.enemy) f.yaw = Math.atan2(dx, dz);
          f.moving = true;
        }
      } else f.moving = false;

      // 边界/地形/建筑
      f.x = clamp(f.x, -this.mapDef.size * 0.49, this.mapDef.size * 0.49);
      f.z = clamp(f.z, -this.mapDef.size * 0.49, this.mapDef.size * 0.49);
      const pushed = this._pushOutWalls(f.x, f.z, 0.5, f.y); // 机器人不能穿墙
      f.x = pushed.x; f.z = pushed.z;
      const obsBot = this.terrain.pushOutObstacle(f.x, f.z, 0.5); // 也不能穿树/石头
      f.x = obsBot.x; f.z = obsBot.z;
      f.y = Math.max(this._groundY(f.x, f.z, f.y), -0.4); // 屋内跟随地板，水里浮在水面

      // 卡死检测：3 秒没挪动就换目标（被墙挡住等）
      if (ai.moveTarget) {
        if (ai.stuckCheckAt === undefined) { ai.stuckCheckAt = now + 3000; ai.stuckPos = { x: f.x, z: f.z }; }
        if (now >= ai.stuckCheckAt) {
          if (Math.hypot(f.x - ai.stuckPos.x, f.z - ai.stuckPos.z) < 1.2) {
            ai.moveTarget = null; ai.lootT = null; ai.enemy = null; // 换个方向
          }
          ai.stuckCheckAt = now + 3000; ai.stuckPos = { x: f.x, z: f.z };
        }
      }

      // 战斗射击
      if (ai.enemy && now >= f.nextShotAt) this._botShoot(f, now);

      // 治疗
      if (f.healEnd && now >= f.healEnd) this._finishHeal(f);
    }
  }

  _botThink(f, now) {
    const ai = f.ai;
    // 找敌人（180m 内 + 需要反应时间才开火，避免开局秒杀混战）
    let best = null, bestD = 180;
    for (const e of this.entities.values()) {
      if (!e.alive || e.team === f.team || e.st === 'p' || e.st === 'd') continue;
      const d = Math.hypot(e.x - f.x, e.z - f.z);
      if (d < bestD && this._los(f.x, f.eyeY(), f.z, e.x, e.y + 1.1, e.z)) { best = e; bestD = d; }
    }
    if (best !== ai.enemy) {
      ai.enemy = best;
      ai.enemySince = now; // 新目标：进入反应时间
    }

    const w = f.weapon;
    const hasGun = w && w.type !== 'melee';
    const ammoOk = hasGun && (f.weapons[f.cur].mag > 0 || f.ammo[w.ammo] > 0);

    if (best && hasGun && ammoOk) {
      // 面向敌人 + 左右横移
      ai.moveTarget = null;
      f.yaw = Math.atan2(best.x - f.x, best.z - f.z);
      if (now >= ai.strafeAt) { ai.strafeAt = now + rnd(700, 1400); ai.strafeDir = Math.random() < 0.5 ? 1 : -1; }
      const px = -Math.cos(f.yaw) * ai.strafeDir, pz = Math.sin(f.yaw) * ai.strafeDir;
      const sp = 4.4;
      f.x += px * sp * 0.35; f.z += pz * sp * 0.35; f.moving = true;
      if (!f.healEnd && f.hp < 45 && f.meds.medkit > 0) { this._startHeal(f, 'medkit'); }
      else if (!f.healEnd && f.hp < 60 && f.meds.bandage > 0 && bestD > 60) { this._startHeal(f, 'bandage'); }
      return;
    }

    if (f.healEnd) { ai.moveTarget = null; return; }

    // 需要捡枪/子弹
    if (!hasGun || !ammoOk) {
      if (!ai.lootT || !this.loot.has(ai.lootT.id)) {
        let bestL = null, bestLD = 120;
        for (const it of this.loot.values()) {
          if (it.kind === 'weapon' || it.kind === 'ammo') {
            const d = dist2(it.x, it.z, f.x, f.z);
            if (d < bestLD) { bestL = it; bestLD = d; }
          }
        }
        ai.lootT = bestL;
      }
      if (ai.lootT) {
        ai.moveTarget = { x: ai.lootT.x, z: ai.lootT.z };
        if (dist2(ai.lootT.x, ai.lootT.z, f.x, f.z) < 1.8) {
          this._pickup(f, ai.lootT.id, true);
          ai.lootT = null;
        }
        return;
      }
    }

    // 跑毒
    const z = this.zone;
    const dz = dist2(f.x, f.z, z.cx, z.cz);
    if (dz > z.r - 20) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * z.r * 0.5;
      ai.moveTarget = { x: z.cx + Math.cos(a) * rr, z: z.cz + Math.sin(a) * rr };
      return;
    }

    // 换弹
    if (hasGun && f.weapons[f.cur].mag < w.mag * 0.4 && f.ammo[w.ammo] > 0 && !f.reloadEnd) this._reload(f);

    // 游荡偏向圈心
    if (!ai.moveTarget) {
      const a = Math.random() * Math.PI * 2, rr = 30 + Math.random() * 90;
      const tx = clamp(f.x + Math.cos(a) * rr, -this.mapDef.size * 0.45, this.mapDef.size * 0.45);
      const tz = clamp(f.z + Math.sin(a) * rr, -this.mapDef.size * 0.45, this.mapDef.size * 0.45);
      if (dist2(tx, tz, z.cx, z.cz) < z.r * 0.8) ai.moveTarget = { x: tx, z: tz };
      else ai.moveTarget = { x: z.cx + rnd(-z.r * 0.4, z.r * 0.4), z: z.cz + rnd(-z.r * 0.4, z.r * 0.4) };
    }
  }

  _botShoot(f, now) {
    const ai = f.ai, e = ai.enemy;
    const w = f.weapon;
    if (!e || !w || w.type === 'melee') return;
    if (now < (ai.enemySince || 0) + (ai.reactMs || 700)) return; // 反应时间
    const slot = f.weapons[f.cur];
    if (now < f.reloadEnd) return;
    if (slot.mag <= 0) {
      if (f.ammo[w.ammo] > 0) this._reload(f);
      return;
    }
    if (now < ai.nextBurstAt) return;
    if (ai.burstLeft <= 0) { ai.burstLeft = Math.floor(rnd(3, 7)); ai.nextBurstAt = now + rnd(500, 1100); return; }
    ai.burstLeft--;

    const d = Math.hypot(e.x - f.x, e.z - f.z);
    if (d > w.range) return;
    // 朝目标胸口 + 误差
    const ox = f.x, oy = f.eyeY(), oz = f.z;
    let dx = e.x - ox, dy = (e.y + 1.05) - oy, dz = e.z - oz;
    const len = Math.hypot(dx, dy, dz);
    dx /= len; dy /= len; dz /= len;
    const err = (1 - ai.acc) * (0.015 + d * 0.0009);
    dx += rnd(-err, err); dy += rnd(-err, err); dz += rnd(-err, err);
    const l2 = Math.hypot(dx, dy, dz); dx /= l2; dy /= l2; dz /= l2;
    f.nextShotAt = now + w.rate * 1.15;
    slot.mag--;
    const res = this._rayHit(ox, oy, oz, dx, dy, dz, w, f);
    this.io.to(this.room.id).emit('shot', { id: f.id, o: [r2(ox), r2(oy), r2(oz)], p: [r2(res.px), r2(res.py), r2(res.pz)] });
    const botW = { ...w, dmg: Math.round(w.dmg * 0.6) }; // 机器人伤害打折，避免对局节奏过快
    if (res.ent) this._applyShotDamage(f, res.ent, botW, res.hs, d);
    if (res.veh) this._damageVeh(res.veh, w.dmg, f);
    if (slot.mag <= 0 && f.ammo[w.ammo] > 0) this._reload(f);
  }

  // 有效地面高度：建筑内为地板/屋顶，其余为地形（与客户端一致）
  _groundY(x, z, refY) {
    const t = this.terrain.height(x, z);
    for (const b of this.terrain.buildings()) {
      if (Math.abs(x - b.x) < b.w / 2 - 0.3 && Math.abs(z - b.z) < b.d / 2 - 0.3) {
        return refY != null && refY > b.y + b.h - 0.6 ? b.y + b.h + 0.5 : Math.max(t, b.y);
      }
    }
    return t;
  }

  // 墙体推出（机器人用，防止穿墙；高于墙顶不挡——房顶）
  _pushOutWalls(x, z, r, refY) {
    for (const w of this.terrain.buildingWalls()) {
      if (refY != null && refY > w.y + w.h - 0.35) continue;
      if (Math.abs(w.x - x) > w.w / 2 + r + 0.2 || Math.abs(w.z - z) > w.d / 2 + r + 0.2) continue;
      const dx = x - w.x, dz = z - w.z;
      const px = w.w / 2 + r - Math.abs(dx);
      const pz = w.d / 2 + r - Math.abs(dz);
      if (px > 0 && pz > 0) {
        if (px < pz) x = w.x + Math.sign(dx || 1) * (w.w / 2 + r);
        else z = w.z + Math.sign(dz || 1) * (w.d / 2 + r);
      }
    }
    return { x, z };
  }

  // ---------- 人类玩家状态同步 ----------
  onState(f, m) {
    if (!f || !f.alive || this.ended) return;
    const now = Date.now();
    const dt = clamp((now - f.lastStateAt) / 1000, 0.02, 0.5);
    f.lastStateAt = now;
    if (f.st === 'p') return; // 飞机上位置由服务器控制

    const h = this.terrain.height(m.x, m.z);
    const gy = this._groundY(m.x, m.z, m.y); // 含建筑地板/屋顶
    const floorY = Math.max(h, -0.8) - 0.3; // 水面统一落点，客户端一致
    let maxH, maxY;
    if (f.st === 'v') { /* 载具内位置由载具决定 */ }
    else if (m.st === 'f') { maxH = 14 * dt + 3; maxY = 58 * dt + 1.5; }
    else if (m.st === 'c') { maxH = 15 * dt + 3; maxY = 10 * dt + 1.5; }
    else { maxH = 11 * dt + 1.5; maxY = 12 * dt + 2; }

    if (f.st !== 'v') {
      const oldX = f.x, oldY = f.y, oldZ = f.z;

      // 数据非法才回弹（位置保持一致，避免回弹死循环）
      if (![m.x, m.y, m.z].every(Number.isFinite) || m.y > 900 || m.y < -50) {
        f.viol += 2;
        if (f.viol > 150) { this.io.to(f.socketId).emit('err', { msg: '移动数据异常，已被移出对局' }); this.room.kick(f.socketId, '数据异常'); return; }
        this.io.to(f.socketId).emit('rubber', { x: r2(oldX), y: r2(oldY), z: r2(oldZ) });
        return;
      }

      // 水平：超限时沿方向截断（最高 3 倍上限），保证服务端始终跟随客户端
      const dh = dist2(m.x, m.z, oldX, oldZ);
      if (dh > maxH) {
        f.viol += dh > maxH * 3 ? 0.8 : 0.15;
        const cap = Math.min(dh, maxH * 3);
        const k = cap / dh;
        f.x = oldX + (m.x - oldX) * k;
        f.z = oldZ + (m.z - oldZ) * k;
      } else {
        f.viol = Math.max(0, f.viol - 0.3);
        f.x = m.x; f.z = m.z;
      }
      // 垂直：同样截断
      const dy = m.y - oldY;
      if (Math.abs(dy) > maxY) {
        f.viol += Math.abs(dy) > maxY * 3 ? 0.8 : 0.15;
        f.y = oldY + Math.sign(dy) * Math.min(Math.abs(dy), maxY * 3);
      } else f.y = m.y;

      f.x = clamp(f.x, -this.mapDef.size * 0.49, this.mapDef.size * 0.49);
      f.z = clamp(f.z, -this.mapDef.size * 0.49, this.mapDef.size * 0.49);
      const obsPos = this.terrain.pushOutObstacle(f.x, f.z, 0.5); // 不能穿树/石头
      f.x = obsPos.x; f.z = obsPos.z;
      f.y = clamp(f.y, floorY, 900);

      if (f.viol > 150) { this.io.to(f.socketId).emit('err', { msg: '移动数据异常，已被移出对局' }); this.room.kick(f.socketId, '数据异常'); return; }

      // 状态转换校验（水面/建筑地板直接算落地）
      if (m.st === 'f' || m.st === 'c') {
        if (m.st === 'c' && f.y - gy > 140) { /* 高空不允许开伞，忽略 */ }
        else f.st = m.st;
      } else if (m.st === 'g') {
        if (f.y <= gy + 0.6 || h < -0.5) f.st = 'g';
      }
      f.cr = !!m.cr;
      f.moving = !!m.mv;
    } else if (m.veh) {
      // 载具操控
      const v = this.vehicles.get(f.vehId);
      if (v && v.driver === f.id) { v.th = clamp(m.veh.th, -1, 1); v.steer = clamp(m.veh.st, -1, 1); }
    }
    f.yaw = clamp(m.yaw == null ? f.yaw : m.yaw, -Math.PI * 2, Math.PI * 2);
    f.pitch = clamp(m.pitch == null ? f.pitch : m.pitch, -1.5, 1.5);
  }

  onJump(f) {
    if (f && f.st === 'p' && this.plane.t > -2) this._eject(f);
  }

  onShoot(f, m) {
    if (!f || !f.alive || this.ended || f.st === 'p' || f.st === 'v') return;
    const now = Date.now();
    if (now < f.nextShotAt || now < f.reloadEnd) return;
    const w = f.weapon;
    if (!w) return;
    if (w.type === 'melee') {
      f.nextShotAt = now + w.rate;
      // 近战弧形判定
      let hit = null, hd = 1e9;
      for (const e of this.entities.values()) {
        if (e === f || !e.alive || e.team === f.team || e.st === 'p' || e.st === 'd') continue;
        const d = Math.hypot(e.x - f.x, e.z - f.z);
        if (d > 2.8) continue;
        const ang = Math.atan2(e.x - f.x, e.z - f.z);
        let da = Math.abs(((ang - f.yaw) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
        if (da < 0.9 && d < hd) { hit = e; hd = d; }
      }
      const ox = f.x, oy = f.eyeY(), oz = f.z;
      const px = hit ? hit.x : ox + Math.sin(f.yaw) * 2;
      const pz = hit ? hit.z : oz + Math.cos(f.yaw) * 2;
      this.io.to(this.room.id).emit('shot', { id: f.id, o: [r2(ox), r2(oy), r2(oz)], p: [r2(px), r2(oy), r2(pz)] });
      if (hit) this._applyShotDamage(f, hit, w, false, hd);
      return;
    }
    const slot = f.weapons[f.cur];
    if (!slot || slot.mag <= 0) {
      if (!f.infAmmo) { if (f.ammo[w.ammo] > 0) this._reload(f); return; }
    } else if (!f.infAmmo) slot.mag--;
    f.nextShotAt = now + w.rate;

    const ox = f.x, oy = f.eyeY(), oz = f.z;
    let dx = m.d[0], dy = m.d[1], dz = m.d[2];
    const pellets = w.pellets || 1;
    let bestRes = null, bestT = 1e9;
    for (let i = 0; i < pellets; i++) {
      let ddx = dx, ddy = dy, ddz = dz;
      if (pellets > 1 || w.spread > 0) {
        const sp = pellets > 1 ? w.spread : w.spread * 0.6;
        ddx += rnd(-sp, sp); ddy += rnd(-sp, sp); ddz += rnd(-sp, sp);
        const l = Math.hypot(ddx, ddy, ddz); ddx /= l; ddy /= l; ddz /= l;
      }
      const res = this._rayHit(ox, oy, oz, ddx, ddy, ddz, w, f);
      if (res.t < bestT) { bestT = res.t; bestRes = res; }
    }
    const res = bestRes;
    this.io.to(this.room.id).emit('shot', { id: f.id, o: [r2(ox), r2(oy), r2(oz)], p: [r2(res.px), r2(res.py), r2(res.pz)] });
    if (res.ent) this._applyShotDamage(f, res.ent, w, res.hs, res.t);
    if (res.veh) this._damageVeh(res.veh, w.dmg, f);
    if (!f.infAmmo && slot && slot.mag <= 0 && f.ammo[w.ammo] > 0) this._reload(f);
    else this._sendInv(f);
  }

  onReload(f) {
    if (!f || !f.alive) return;
    const w = f.weapon;
    if (!w || w.type === 'melee') return;
    this._reload(f);
  }

  _reload(f) {
    const w = f.weapon;
    const slot = f.weapons[f.cur];
    if (!w || !slot || w.type === 'melee') return;
    const now = Date.now();
    if (now < f.reloadEnd || slot.mag >= w.mag || f.ammo[w.ammo] <= 0) return;
    f.reloadEnd = now + w.reload;
    setTimeout(() => {
      try {
        if (!f.alive || this.ended) return;
        if (f.weapons[f.cur] !== slot) return;
        const take = Math.min(w.mag - slot.mag, f.ammo[w.ammo]);
        slot.mag += take; f.ammo[w.ammo] -= take;
        this._sendInv(f);
      } catch (e) { /* 战斗可能已结束 */ }
    }, w.reload);
  }

  onSwitch(f, m) {
    if (!f || !f.alive) return;
    const slot = clamp(m.slot | 0, 0, 1);
    if (slot !== f.cur) { f.cur = slot; f.reloadEnd = 0; this._sendInv(f); }
  }

  onAct(f, m) {
    if (!f || !f.alive || this.ended) return;
    const now = Date.now();
    if (m.kind === 'heal') { this._startHeal(f, m.item); return; }
    if (m.kind === 'exit') { this._exitVeh(f); return; }
    if (m.kind === 'pickup') {
      const it = this.loot.get(m.id);
      if (it && dist2(it.x, it.z, f.x, f.z) < 3.4 && Math.abs(it.y - f.y) < 4.5) this._pickup(f, m.id, false);
      else if (!it) this.io.to(f.socketId).emit('toast', { msg: '手慢了，物品已被别人拾取' });
      else this.io.to(f.socketId).emit('toast', { msg: '距离太远，走近一点再按 E' });
      return;
    }
    if (m.kind === 'enter') {
      const v = this.vehicles.get(m.id);
      if (v && v.hp > 0 && !v.driver && f.st === 'g' && dist2(v.x, v.z, f.x, f.z) < 5.5 && Math.abs(v.y - f.y) < 5) {
        v.driver = f.id; f.vehId = v.id; f.st = 'v';
        this._sendInv(f);
      } else {
        const why = !v ? '车辆不存在' : v.hp <= 0 ? '车辆已损毁' : v.driver ? '已有人驾驶' : f.st !== 'g' ? '你还在空中/水中' : dist2(v.x, v.z, f.x, f.z) >= 5.5 ? '距离太远（需 5.5m 内）' : '与车辆高度差过大';
        this.io.to(f.socketId).emit('toast', { msg: '无法上车：' + why });
      }
      return;
    }
    if (m.kind === 'open') {
      const c = this.crates.get(m.id);
      if (c && c.landed && !c.opened && dist2(c.x, c.z, f.x, f.z) < 4.5) {
        c.opened = true;
        const drops = [
          { kind: 'weapon', wid: pick(['awm', 'm4', 'ak', 'mini14']) },
          { kind: 'ammo', at: 'sniper', cnt: 10 }, { kind: 'ammo', at: 'heavy', cnt: 60 },
          { kind: 'med', med: 'medkit', cnt: 2 },
          { kind: 'armor', ar: 'vest', lv: 3 }, { kind: 'armor', ar: 'helmet', lv: 3 },
        ];
        for (let i = 0; i < drops.length; i++) {
          const a = (i / drops.length) * Math.PI * 2;
          this._addLoot({ ...drops[i], x: c.x + Math.cos(a) * 1.6, z: c.z + Math.sin(a) * 1.6 });
        }
        this.io.to(this.room.id).emit('air:open', { id: c.id });
      }
      return;
    }
  }

  _pickup(f, lootId, isBot) {
    const it = this.loot.get(lootId);
    if (!it) return;
    if (it.kind === 'weapon') {
      const w = f.wdef(it.wid);
      if (!w) return;
      const item = { wid: it.wid, mag: w.mag };
      let slot = f.weapons[0] ? (f.weapons[1] ? f.cur : 1) : 0;
      const old = f.weapons[slot];
      f.weapons[slot] = item;
      f.cur = slot;
      if (isBot) f.ammo[w.ammo] = (f.ammo[w.ammo] || 0) + w.mag * 3;
      if (old) this._addLoot({ kind: 'weapon', wid: old.wid, x: f.x, z: f.z }); // 换下的枪掉地上
    } else if (it.kind === 'ammo') {
      f.ammo[it.at] = (f.ammo[it.at] || 0) + it.cnt;
      if (isBot && f.weapon && f.weapon.ammo === it.at) { /* 机器人足够 */ }
    } else if (it.kind === 'med') {
      f.meds[it.med] += it.cnt;
    } else if (it.kind === 'armor') {
      const cur = it.ar === 'vest' ? f.vest : f.helmet;
      const lv = it.lv;
      if (lv > cur) { if (it.ar === 'vest') f.vest = lv; else f.helmet = lv; }
      else if (!isBot) return; // 更差的不捡
    }
    this.loot.delete(lootId);
    this.lootRm.push(lootId);
    if (!isBot) {
      let label = '物品';
      if (it.kind === 'weapon') label = this._wname(it.wid);
      else if (it.kind === 'ammo') label = `${{ light: '轻型弹药', heavy: '重型弹药', shell: '霰弹', sniper: '狙击弹' }[it.at] || '弹药'} ×${it.cnt}`;
      else if (it.kind === 'med') label = (it.med === 'bandage' ? '绷带' : '医疗箱') + ' ×' + it.cnt;
      else if (it.kind === 'armor') label = (it.ar === 'vest' ? '护甲' : '头盔') + ' Lv.' + it.lv;
      this.io.to(f.socketId).emit('toast', { msg: '🎒 已拾取 ' + label });
      this._sendInv(f);
    }
  }

  _wname(wid) {
    const w = getDb().weapons.find(x => x.id === wid);
    return w ? w.name : wid;
  }

  _startHeal(f, item) {
    if (f.healEnd || !f.alive) return;
    if (item === 'bandage' && f.meds.bandage > 0 && f.hp < 100) {
      f.healEnd = Date.now() + 3000; f.healItem = 'bandage';
      if (!f.isBot) this.io.to(f.socketId).emit('heal:cast', { item, ms: 3000 });
    } else if (item === 'medkit' && f.meds.medkit > 0 && f.hp < 100) {
      f.healEnd = Date.now() + 6000; f.healItem = 'medkit';
      if (!f.isBot) this.io.to(f.socketId).emit('heal:cast', { item, ms: 6000 });
    }
  }

  _finishHeal(f) {
    if (f.healItem === 'bandage') { f.meds.bandage--; f.hp = Math.min(100, f.hp + 20); }
    else if (f.healItem === 'medkit') { f.meds.medkit--; f.hp = 100; }
    f.healEnd = 0; f.healItem = null;
    if (!f.isBot) { this._sendInv(f); this.io.to(f.socketId).emit('hp', { hp: f.hp }); }
  }

  _sendInv(f) {
    if (f && !f.isBot && f.socketId) this.io.to(f.socketId).emit('inv', f.invPayload());
  }

  _exitVeh(f) {
    const v = this.vehicles.get(f.vehId);
    if (!v) { f.vehId = null; f.st = 'g'; return; }
    v.driver = null; v.th = 0; v.steer = 0;
    f.vehId = null; f.st = 'g';
    f.x = v.x + Math.cos(v.yaw) * 2.2; f.z = v.z - Math.sin(v.yaw) * 2.2;
    f.y = this.terrain.height(f.x, f.z);
    if (f.y < 0) { f.x = v.x; f.z = v.z; f.y = Math.max(this.terrain.height(f.x, f.z), 0.1); }
    this._sendInv(f);
  }

  // 载具是否撞到建筑墙体（半径 r 的圆 vs 墙 AABB）
  _vehHitsWall(x, z, r) {
    for (const w of this.terrain.buildingWalls()) {
      if (Math.abs(w.x - x) > w.w / 2 + r || Math.abs(w.z - z) > w.d / 2 + r) continue;
      const dx = x - w.x, dz = z - w.z;
      if (Math.abs(dx) < w.w / 2 + r && Math.abs(dz) < w.d / 2 + r) return true;
    }
    return false;
  }

  // ---------- 载具 ----------
  _tickVehicles(dt) {
    for (const v of this.vehicles.values()) {
      if (v.hp <= 0) continue;
      if (v.driver) {
        const th = v.th || 0, st = v.steer || 0;
        const type = getDb().vehicles.find(t => t.id === v.type) || { speed: 20 };
        v.speed += th * 16 * dt;
        v.speed *= 1 - 1.3 * dt;
        v.speed = clamp(v.speed, -10, type.speed);
        if (Math.abs(v.speed) > 0.3) {
          // 右手坐标系：右转（st>0）= yaw 减小
          v.yaw -= st * dt * 1.7 * clamp(v.speed / 9, -1, 1);
          const nx = v.x + Math.sin(v.yaw) * v.speed * dt;
          const nz = v.z + Math.cos(v.yaw) * v.speed * dt;
          const nh = this.terrain.height(nx, nz);
          const dist = Math.abs(v.speed) * dt;
          let blocked = false;
          if (Math.abs(nh - v.y) > 2.6 * Math.max(dist, 0.05) || nh < 0.1 ||
            Math.abs(nx) > this.mapDef.size * 0.48 || Math.abs(nz) > this.mapDef.size * 0.48) blocked = true;
          if (!blocked && this._vehHitsWall(nx, nz, 2.2)) blocked = true; // 撞墙
          if (!blocked && this.terrain.hitsObstacle(nx, nz, 1.8)) blocked = true; // 撞树/石头
          if (blocked) {
            const drv = this.entities.get(v.driver) || null;
            if (Math.abs(v.speed) > 10) {
              // 高速撞击：车辆受损
              this._damageVeh(v, Math.abs(v.speed) * 2.5, drv);
              this.io.to(this.room.id).emit('boom', { x: r2(v.x), y: r2(v.y + 1), z: r2(v.z) });
            }
            v.speed = 0;
          } else { v.x = nx; v.z = nz; v.y = nh; }

          // 碾轧判定：高速撞人造成伤害（队友免疫）
          if (Math.abs(v.speed) > 6) {
            const drv = this.entities.get(v.driver) || null;
            for (const e of this.entities.values()) {
              if (!e.alive || e.st === 'v' || e.st === 'p' || e.st === 'd') continue;
              if (drv && e.team === drv.team) continue;
              const d = Math.hypot(e.x - v.x, e.z - v.z);
              if (d < 2.5) {
                const dmg = Math.round(Math.abs(v.speed) * 4.5);
                // 击退 + 抬起
                e.x += (e.x - v.x) / Math.max(d, 0.5) * 2.2;
                e.z += (e.z - v.z) / Math.max(d, 0.5) * 2.2;
                this._damage(e, dmg, drv, v.type, false);
              }
            }
          }
        }
      } else {
        v.speed *= 1 - 2 * dt;
      }
      // 同步乘员位置
      if (v.driver) {
        const f = this.entities.get(v.driver);
        if (f) {
          if (!f.alive) { this._exitVeh(f); }
          else { f.x = v.x; f.y = v.y; f.z = v.z; f.yaw = v.yaw; }
        }
      }
    }
  }

  _damageVeh(v, dmg, by) {
    if (v.hp <= 0) return;
    v.hp -= dmg;
    if (v.hp <= 0) {
      v.hp = 0;
      const f = v.driver ? this.entities.get(v.driver) : null;
      if (f) { f.vehId = null; f.st = 'g'; this._damage(f, 500, by, v.type, false); }
      this.vehicles.delete(v.id);
      this.booms.push({ t: Date.now(), x: v.x, y: v.y + 1, z: v.z, r: 7, dmg: 130 });
    }
  }

  // ---------- 命中 ----------
  _los(ox, oy, oz, tx, ty, tz) {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return true;
    const nd = [dx / len, dy / len, dz / len];
    return this._occludeT(ox, oy, oz, nd[0], nd[1], nd[2], len) == null;
  }

  // 返回遮挡距离或 null
  _occludeT(ox, oy, oz, dx, dy, dz, maxT) {
    let best = null;
    // 地形采样
    const step = 5;
    for (let t = 3; t < Math.min(maxT, 800); t += step) {
      const y = oy + dy * t;
      const th = this.terrain.height(ox + dx * t, oz + dz * t);
      if (y < th) { best = t; break; }
    }
    // 建筑
    const t2 = this._boxHitT(ox, oy, oz, dx, dy, dz, maxT);
    if (t2 != null && (best == null || t2 < best)) best = t2;
    return best;
  }

  _boxHitT(ox, oy, oz, dx, dy, dz, maxT) {
    let best = null;
    for (const w of this.terrain.buildingWalls()) {
      const t = rayBox(ox, oy, oz, dx, dy, dz, w);
      if (t != null && t > 0.1 && t <= maxT && (best == null || t < best)) best = t;
    }
    return best;
  }

  _rayHit(ox, oy, oz, dx, dy, dz, w, shooter) {
    const maxT = Math.min(w.range * 1.15, 850);
    let bestT = maxT, ent = null, hs = false, veh = null;
    for (const e of this.entities.values()) {
      if (e === shooter || !e.alive || e.st === 'p' || e.st === 'd') continue;
      if (e.team === shooter.team) continue;
      const cy = e.cr ? 0.7 : 1.05, hy = e.cr ? 1.12 : 1.62;
      const tHead = raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + hy, e.z, 0.3);
      const tBody = raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + cy, e.z, 0.55);
      let t = null, head = false;
      if (tHead != null && tHead <= bestT) { t = tHead; head = true; }
      if (tBody != null && tBody < (t == null ? 1e9 : t)) { t = tBody; head = false; }
      if (t != null && t <= bestT) { bestT = t; ent = e; hs = head; }
    }
    for (const v of this.vehicles.values()) {
      if (v.hp <= 0) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, v.x, v.y + 1.1, v.z, 2.3);
      if (t != null && t < bestT) { bestT = t; ent = null; hs = false; veh = v; }
    }
    const occ = this._occludeT(ox, oy, oz, dx, dy, dz, bestT);
    if (occ != null && occ < bestT) { ent = null; veh = null; hs = false; bestT = occ; }
    return { t: bestT, ent, hs, veh, px: ox + dx * bestT, py: oy + dy * bestT, pz: oz + dz * bestT };
  }

  _applyShotDamage(shooter, ent, w, hs, dist) {
    let dmg = w.dmg;
    if (dist > w.range * 0.5) dmg *= Math.max(0.35, 1 - (dist - w.range * 0.5) / (w.range * 0.7));
    if (hs) dmg *= 2 * (1 - HELMET_REDUCE[ent.helmet || 0]);
    else dmg *= 1 - VEST_REDUCE[ent.vest || 0];
    this._damage(ent, dmg, shooter, w.name, hs, shooter);
  }

  _damage(ent, dmg, killer, weaponName, hs, shooter) {
    if (!ent.alive || ent.god || this.ended) return;
    dmg = Math.round(dmg);
    if (dmg <= 0) return;
    ent.hp -= dmg;
    if (shooter) {
      shooter.dmg += Math.min(dmg, Math.max(0, ent.hp + dmg));
      if (!shooter.isBot && shooter.socketId) this.io.to(shooter.socketId).emit('dmg', { to: ent.id, d: dmg, hs: !!hs });
    }
    if (!ent.isBot && ent.socketId) this.io.to(ent.socketId).emit('hit', { d: dmg, by: killer ? killer.name : weaponName });
    if (ent.hp <= 0) this._die(ent, killer, weaponName, hs);
  }

  _die(ent, killer, weaponName, hs) {
    if (!ent.alive) return;
    ent.alive = false; ent.st = 'd'; ent.hp = 0;
    if (ent.vehId) { const v = this.vehicles.get(ent.vehId); if (v && v.driver === ent.id) { v.driver = null; v.th = 0; v.steer = 0; } ent.vehId = null; }
    // 排名 = 死亡瞬间存活数
    const aliveNow = [...this.entities.values()].filter(e => e.alive).length + 1;
    ent.rank = aliveNow;
    if (killer && killer !== ent) killer.kills++;
    // 掉落背包
    for (const w of ent.weapons) if (w) this._addLoot({ kind: 'weapon', wid: w.wid, x: ent.x + rnd(-1, 1), z: ent.z + rnd(-1, 1) });
    for (const at of ['light', 'heavy', 'shell', 'sniper']) {
      if (ent.ammo[at] > 0) this._addLoot({ kind: 'ammo', at, cnt: Math.ceil(ent.ammo[at] / 2), x: ent.x + rnd(-1.5, 1.5), z: ent.z + rnd(-1.5, 1.5) });
    }
    if (ent.meds.bandage > 0) this._addLoot({ kind: 'med', med: 'bandage', cnt: ent.meds.bandage, x: ent.x + rnd(-1.5, 1.5), z: ent.z + rnd(-1.5, 1.5) });
    if (ent.meds.medkit > 0) this._addLoot({ kind: 'med', med: 'medkit', cnt: ent.meds.medkit, x: ent.x + rnd(-1.5, 1.5), z: ent.z + rnd(-1.5, 1.5) });
    if (ent.vest > 0) this._addLoot({ kind: 'armor', ar: 'vest', lv: ent.vest, x: ent.x + rnd(-1.5, 1.5), z: ent.z + rnd(-1.5, 1.5) });
    if (ent.helmet > 0) this._addLoot({ kind: 'armor', ar: 'helmet', lv: ent.helmet, x: ent.x + rnd(-1.5, 1.5), z: ent.z + rnd(-1.5, 1.5) });

    this.io.to(this.room.id).emit('kill', {
      k: killer ? killer.name : weaponName, v: ent.name, w: weaponName, hs: !!hs,
      kid: killer ? killer.id : null, vid: ent.id,
    });
    if (!ent.isBot && ent.socketId) {
      this.io.to(ent.socketId).emit('dead', { rank: ent.rank, by: killer ? killer.name : weaponName });
    }
  }

  // ---------- 空投 ----------
  _tickAirdrops(now, dt) {
    if (this.nextAirAt && now >= this.nextAirAt) {
      this.nextAirAt = now + 75000;
      const zone = this.zone;
      let x = 0, zc = 0, ok = false, tries = 0;
      while (!ok && tries++ < 40) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * zone.r * 0.7;
        x = zone.cx + Math.cos(a) * r; zc = zone.cz + Math.sin(a) * r;
        // 陆地上且不在建筑内部（避免砸穿屋顶掉进房里）
        ok = this.terrain.height(x, zc) > 1 && !this._inBuilding(x, zc, 2);
      }
      if (ok) {
        const c = { id: 'A' + (this.airSeq++), x, z: zc, y: 350, vy: -30, landed: false, opened: false };
        this.crates.set(c.id, c);
        this.io.to(this.room.id).emit('air', { id: c.id, x: r2(x), z: r2(zc) });
      }
    }
    for (const c of this.crates.values()) {
      if (c.landed) continue;
      // 建筑感知的有效地面（房顶/地板/地形），防止掉进地底
      const h = this._groundY(c.x, c.z, c.y);
      c.vy = c.y - h < 120 ? -6 : Math.max(c.vy - 8 * dt, -32);
      c.y += c.vy * dt;
      if (c.y <= h + 0.2) { c.y = h + 0.2; c.landed = true; this.io.to(this.room.id).emit('air:land', { id: c.id, x: r2(c.x), y: r2(c.y), z: r2(c.z) }); }
    }
  }

  // 是否在建筑足迹内（margin 外扩）
  _inBuilding(x, z, margin) {
    for (const b of this.terrain.buildings()) {
      if (Math.abs(x - b.x) < b.w / 2 + (margin || 0) && Math.abs(z - b.z) < b.d / 2 + (margin || 0)) return true;
    }
    return false;
  }

  // ---------- 轰炸 ----------
  _tickBooms(now) {
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      if (now < b.t) continue;
      this.booms.splice(i, 1);
      this.io.to(this.room.id).emit('boom', { x: r2(b.x), y: r2(b.y), z: r2(b.z) });
      for (const e of this.entities.values()) {
        if (!e.alive || e.st === 'p') continue;
        const d = Math.hypot(e.x - b.x, e.y - b.y, e.z - b.z);
        if (d < b.r) this._damage(e, b.dmg * (1 - d / b.r), b.by || null, '爆炸', false, b.shooter || null);
      }
      for (const v of [...this.vehicles.values()]) {
        const d = Math.hypot(v.x - b.x, v.z - b.z);
        if (d < b.r + 1) this._damageVeh(v, 300, b.shooter || null);
      }
    }
  }

  airstrike(f, x, z) {
    if (Math.abs(x) > this.mapDef.size / 2 || Math.abs(z) > this.mapDef.size / 2) return;
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      this.booms.push({
        t: now + 800 + i * 380 + Math.random() * 200,
        x: x + rnd(-20, 20), z: z + rnd(-20, 20), y: this.terrain.height(x, z) + 1,
        r: 8, dmg: 130, shooter: f, by: f,
      });
    }
    this.io.to(f.socketId).emit('toast', { msg: '轰炸区已呼叫' });
  }

  // ---------- 通用每帧（人类） ----------
  _tickFighters(now, dt) {
    for (const f of this.entities.values()) {
      if (f.isBot || !f.alive) continue;
      if (f.healEnd && now >= f.healEnd) this._finishHeal(f);
      // 自动拾取：踩到弹药/药品/护甲直接进包
      if (f.st === 'g' && !f.healEnd) {
        for (const it of this.loot.values()) {
          if (it.kind === 'weapon') continue;
          if (dist2(it.x, it.z, f.x, f.z) < 1.9 && Math.abs(it.y - f.y) < 3) { this._pickup(f, it.id, false); break; }
        }
      }
    }
  }

  _checkEnd() {
    const aliveTeams = new Set();
    let humansAlive = 0;
    let humansTotal = 0;
    for (const f of this.entities.values()) {
      if (!f.isBot) { humansTotal++; if (f.alive) humansAlive++; }
      if (f.alive) aliveTeams.add(f.team);
    }
    if (aliveTeams.size <= 1) { this._finish([...aliveTeams][0]); return; }
    if (humansTotal > 0 && humansAlive === 0) {
      // 所有真人死亡，直接结算（机器人对局不继续占资源）
      this._finish([...aliveTeams][0]);
    }
  }

  _finish(winnerTeam) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    clearTimeout(this.hardStop);
    const db = getDb();
    const rw = db.settings.rewards;
    const winners = [];
    for (const f of this.entities.values()) {
      if (f.alive) {
        const aliveNow = [...this.entities.values()].filter(e => e.alive).length;
        f.rank = f.team === winnerTeam ? 1 : aliveNow;
      }
      if (f.team === winnerTeam) winners.push(f.name);
      if (!f.isBot && f.userId) {
        const u = db.users.find(x => x.id === f.userId);
        if (u) {
          const coins = f.kills * rw.kill + (f.rank === 1 ? rw.win : f.rank <= 10 ? rw.top10 : rw.join);
          u.coins += coins;
          u.stats.games++; u.stats.kills += f.kills; u.stats.deaths += (f.alive ? 0 : 1);
          if (f.rank === 1) u.stats.wins++;
          if (f.socketId) {
            this.io.to(f.socketId).emit('end', {
              rank: f.rank, kills: f.kills, dmg: Math.round(f.dmg), coins,
              winners: winners.slice(0, 5), total: this.entities.size,
            });
          }
        }
      }
    }
    markDirty();
    this.io.to(this.room.id).emit('battle:over', { winners: winners.slice(0, 5) });
    this.room.onBattleEnd();
  }

  // ---------- 快照 ----------
  _broadcast(now) {
    const z = this.zone;
    const e = [];
    for (const f of this.entities.values()) {
      if (!f.alive) continue;
      e.push([f.id, r2(f.x), r2(f.y), r2(f.z), r2(f.yaw), f.st, f.cr ? 1 : 0, Math.round(f.hp), (f.weapons[f.cur] && f.weapons[f.cur].wid) || 'fists', f.vehId || 0]);
    }
    const v = [...this.vehicles.values()].map(x => this._vRow(x));
    const snap = {
      t: now,
      e, v,
      z: [r2(z.cx), r2(z.cz), r2(z.r), r2(z.nx), r2(z.nz), r2(z.nr), z.phase, z.st, Math.max(0, Math.round(z.t))],
      ac: this.entities.size ? [...this.entities.values()].filter(f => f.alive).length : 0,
      pl: this.plane.active ? [r2(this.plane.x), r2(this.plane.y), r2(this.plane.z)] : null,
      air: [...this.crates.values()].map(c => [c.id, r2(c.x), r2(c.y), r2(c.z), c.landed ? 1 : 0, c.opened ? 1 : 0]),
    };
    this.io.to(this.room.id).emit('snap', snap);
    if (this.tickCount % 20 === 0) this.io.to(this.room.id).emit('full', { names: this._namesPayload() });
    if (this.lootAdd.length || this.lootRm.length) {
      this.io.to(this.room.id).emit('loot', { add: this.lootAdd.splice(0), rm: this.lootRm.splice(0) });
    }
  }

  onDisconnect(f) {
    if (f && f.alive) this._die(f, null, '断线', false);
    this.entities.delete(f.id);
    this._checkEnd();
  }

  chat(f, ch, text) {
    if (!f) return;
    const msg = { from: f.name, ch, text: String(text).slice(0, 100) };
    if (ch === 'team') {
      for (const e of this.entities.values()) {
        if (!e.isBot && e.socketId && e.team === f.team) this.io.to(e.socketId).emit('chat', msg);
      }
    } else {
      this.io.to(this.room.id).emit('chat', msg);
    }
  }

  destroy() {
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    if (this.hardStop) clearTimeout(this.hardStop);
  }
}

// ---------- 房间 ----------
export class Room {
  constructor(manager, { id, name, mode, scenery, user }) {
    this.manager = manager;
    this.io = manager.io;
    this.id = id;
    this.name = name || (user.username + ' 的房间');
    this.mode = mode || 'squad';
    this.scenery = scenery || 'day';
    this.hostUserId = user.id;
    this.state = 'waiting';
    this.players = new Map(); // sid -> {sid, user, ready, joinedAt}
    this.battle = null;
    this.countdown = null;
    this.createdAt = Date.now();
  }

  squadSize() { return this.mode === 'solo' ? 1 : this.mode === 'duo' ? 2 : 4; }

  add(socket, user) {
    if (this.players.size >= getDb().settings.totalPlayers) return { ok: false, msg: '房间已满' };
    if (this.state === 'battle') {
      // 允许观战加入？简单起见战斗中不允许加入
      return { ok: false, msg: '战斗进行中，请稍后' };
    }
    this.players.set(socket.id, { sid: socket.id, user, ready: false, joinedAt: Date.now() });
    socket.join(this.id);
    socket.leave('lobby');
    this.emitRoom();
    return { ok: true };
  }

  remove(sid, reason) {
    const p = this.players.get(sid);
    if (!p) return;
    this.players.delete(sid);
    if (this.battle) {
      const f = [...this.battle.entities.values()].find(x => x.socketId === sid);
      if (f) this.battle.onDisconnect(f);
    }
    if (this.hostUserId === p.user.id) {
      const next = [...this.players.values()][0];
      this.hostUserId = next ? next.user.id : null;
    }
    this.emitRoom();
    if (this.players.size === 0) this.manager.destroyRoom(this.id);
  }

  kick(sid, reason) {
    const p = this.players.get(sid);
    if (!p) return;
    this.io.to(sid).emit('err', { msg: reason || '你已被移出房间' });
    this.manager.forceLeave(sid);
    this.remove(sid);
  }

  setReady(sid, ready) {
    const p = this.players.get(sid);
    if (p) { p.ready = !!ready; this.emitRoom(); }
  }

  // 除房主外所有人都准备了（房主随时可按开始）
  allReady() {
    return [...this.players.values()].every(p => p.ready || p.user.id === this.hostUserId);
  }

  _stopCountdown() {
    if (this._cdTimer) { clearInterval(this._cdTimer); this._cdTimer = null; }
    this.countdown = null;
  }

  startBattle() {
    if (this.state === 'battle' || this.players.size === 0) return;
    this._stopCountdown();
    const mapDef = getDb().maps[0] || { id: 'island', name: '烽区岛', size: 800, seed: 20260821 };
    this.state = 'battle';
    this.battle = new Battle(this, mapDef);
    try {
      this.battle.start();
    } catch (e) {
      console.error('[room] 战斗启动失败:', e);
      this.battle.destroy();
      this.battle = null;
      this.state = 'waiting';
      this.io.to(this.id).emit('toast', { msg: '战斗启动失败，请重试', type: 'error' });
    }
    this.emitRoom();
  }

  onBattleEnd() {
    setTimeout(() => {
      try {
        if (this.battle) { this.battle.destroy(); this.battle = null; }
        this.state = 'waiting';
        for (const p of this.players.values()) p.ready = false;
        this.emitRoom();
      } catch (e) { console.error('[room] 结束清理异常:', e); }
    }, 8000);
  }

  summary() {
    return {
      id: this.id, name: this.name, mode: this.mode, scenery: this.scenery,
      players: this.players.size, max: getDb().settings.totalPlayers,
      state: this.state, host: ([...this.players.values()].find(p => p.user.id === this.hostUserId) || { user: { username: '?' } }).user.username,
      countdown: this.countdown,
    };
  }

  detail() {
    return {
      ...this.summary(),
      hostUserId: this.hostUserId,
      players: [...this.players.values()].map(p => ({
        sid: p.sid, name: p.user.username, id: p.user.id, ready: p.ready,
        host: p.user.id === this.hostUserId, role: p.user.role,
      })),
    };
  }

  emitRoom() {
    this.io.to(this.id).emit('room', this.detail());
    this.manager.broadcastLobby();
  }

  chat(sid, text) {
    const p = this.players.get(sid);
    if (!p) return;
    this.io.to(this.id).emit('chat', { from: p.user.username, ch: 'room', text: String(text).slice(0, 100) });
  }

  destroy() {
    this._stopCountdown();
    if (this.battle) this.battle.destroy();
  }
}

// ---------- 房间管理器 ----------
export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.nextId = 1;
    this.socketRoom = new Map(); // sid -> roomId
    setInterval(() => this.broadcastLobby(), 2000);
    // 空房间回收
    setInterval(() => {
      for (const [id, r] of this.rooms) {
        if (r.players.size === 0 && Date.now() - r.createdAt > 30000) this.destroyRoom(id);
      }
    }, 30000);
  }

  create({ name, mode, scenery }, user, socket) {
    const id = 'R' + (this.nextId++);
    const room = new Room(this, { id, name, mode, scenery, user });
    this.rooms.set(id, room);
    this.socketRoom.set(socket.id, id);
    const res = room.add(socket, user);
    if (!res.ok) { this.rooms.delete(id); this.socketRoom.delete(socket.id); }
    return { ...res, id };
  }

  join(id, user, socket) {
    if (this.socketRoom.has(socket.id)) return { ok: false, msg: '你已在房间中' };
    const room = this.rooms.get(id);
    if (!room) return { ok: false, msg: '房间不存在' };
    const res = room.add(socket, user);
    if (res.ok) this.socketRoom.set(socket.id, id);
    return res;
  }

  leave(socket) {
    const rid = this.socketRoom.get(socket.id);
    if (!rid) return;
    const room = this.rooms.get(rid);
    this.socketRoom.delete(socket.id);
    if (room) room.remove(socket.id);
  }

  forceLeave(sid) {
    const rid = this.socketRoom.get(sid);
    this.socketRoom.delete(sid);
    const s = this.io.sockets.sockets.get(sid);
    if (s) { s.leave(rid); s.join('lobby'); }
  }

  destroyRoom(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.destroy();
    this.rooms.delete(id);
    for (const [sid, rid] of this.socketRoom) if (rid === id) this.socketRoom.delete(sid);
    this.broadcastLobby();
  }

  roomOf(sid) {
    const rid = this.socketRoom.get(sid);
    return rid ? this.rooms.get(rid) : null;
  }

  battleOf(sid) {
    const room = this.roomOf(sid);
    return room && room.battle ? room.battle : null;
  }

  fighterOf(sid) {
    const b = this.battleOf(sid);
    if (!b) return null;
    return [...b.entities.values()].find(f => f.socketId === sid) || null;
  }

  list() { return [...this.rooms.values()].map(r => r.summary()); }

  // 管理员视角：带成员名单（仅后台接口使用，不广播给普通客户端）
  adminList() {
    return [...this.rooms.values()].map(r => ({
      ...r.summary(),
      members: [...r.players.values()].map(p => ({ id: p.user.id, name: p.user.username, ready: p.ready })),
    }));
  }

  // 管理员解散房间：战斗中先正常结算结束，再把所有人送回大厅
  dissolve(id, reason) {
    const room = this.rooms.get(id);
    if (!room) return { ok: false, msg: '房间不存在' };
    const msg = reason || '管理员解散了房间';
    try {
      if (room.battle && !room.battle.ended) room.battle._finish(undefined);
      for (const p of [...room.players.values()]) {
        const sock = this.io.sockets.sockets.get(p.sid);
        if (sock) {
          sock.emit('toast', { msg });
          sock.emit('room', { id, name: room.name, mode: room.mode, scenery: room.scenery, players: [] });
        }
        this.forceLeave(p.sid);
        room.remove(p.sid);
      }
      this.destroyRoom(id);
      return { ok: true };
    } catch (e) {
      console.error('[rooms] dissolve 异常:', e);
      return { ok: false, msg: '解散失败：' + e.message };
    }
  }

  onlineCount() { return this.io.engine.clientsCount; }

  // 当前在线的用户 ID 集合（一个账号可能多端登录，去重）
  onlineUserIds() {
    const ids = new Set();
    for (const s of this.io.sockets.sockets.values()) {
      const u = s.data && s.data.user;
      if (u && u.id != null) ids.add(u.id);
    }
    return ids;
  }

  broadcastLobby() {
    try {
      this.io.to('lobby').emit('lobby', { rooms: this.list(), online: this.onlineCount() });
    } catch (e) { /* 忽略 */ }
  }

  lobbyChat(socket, user, text) {
    this.io.to('lobby').emit('chat', { from: user.username, ch: 'lobby', text: String(text).slice(0, 100) });
  }
}
