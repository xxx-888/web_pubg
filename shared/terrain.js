// 共享地形生成 —— 服务端与客户端 import 同一份代码，保证岛屿/城镇/树木位置一致
// 纯函数、无依赖：服务端用于地面高度/命中遮挡/城镇碰撞，客户端用于渲染

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 974634)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function fbm(x, z, seed, oct) {
  let v = 0, amp = 0.5, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) {
    v += vnoise(x * f, z * f, seed + i * 101) * amp;
    tot += amp; amp *= 0.5; f *= 2;
  }
  return v / tot;
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Terrain {
  constructor(seed, size = 800) {
    this.seed = seed | 0;
    this.size = size;
    this.half = size / 2;
    this._towns = null;
    this._trees = null;
    this._rocks = null;
    this._lootSpots = null;
    this._buildings = null;
  }

  // 地面高度：>0 陆地，0 附近海滩，<0 水
  height(x, z) {
    const s = this.seed, S = this.size;
    const nx = x / S, nz = z / S;
    const base = fbm(nx * 3 + 0.7, nz * 3 + 0.7, s, 5) * 24;
    const mMask = fbm(nx * 1.2 + 9.2, nz * 1.2 + 3.1, s + 77, 3);
    const mountain = Math.pow(Math.max(0, (mMask - 0.5) / 0.5), 1.7) * fbm(nx * 6 + 4, nz * 6 + 4, s + 33, 4) * 58;
    const detail = fbm(nx * 12, nz * 12, s + 55, 3) * 2.6;
    let e = base + mountain + detail;
    const d = Math.sqrt(x * x + z * z) / (this.half * 0.92);
    const fall = smoothstep(0.74, 1.06, d);
    e = e * (1 - fall) + (-16) * fall;
    return e - 1.2;
  }

  isLand(x, z) { return this.height(x, z) > 0.6; }

  _slope(x, z) {
    const d = 3;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    return Math.sqrt(hx * hx + hz * hz) / (2 * d);
  }

  towns() {
    if (this._towns) return this._towns;
    const rng = mulberry32(this.seed + 1);
    const towns = [];
    let tries = 0;
    while (towns.length < 7 && tries++ < 300) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * this.half * 0.55;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = this.height(x, z);
      if (h < 4 || h > 34 || this._slope(x, z) > 0.35) continue;
      if (towns.some(t => Math.hypot(t.x - x, t.z - z) < 130)) continue;
      const names = ['临风镇', '石岭村', '渔港', '绿谷', '北坡营地', '旧工厂', '观海台'];
      towns.push({ x, z, name: names[towns.length] || '据点' + towns.length });
    }
    this._towns = towns;
    return towns;
  }

  // 轴对齐建筑（空心，正门朝 +Z，可进入）
  buildings() {
    if (this._buildings) return this._buildings;
    const rng = mulberry32(this.seed + 2);
    const list = [];
    for (const t of this.towns()) {
      const n = 5 + Math.floor(rng() * 5);
      let tries = 0, made = 0;
      while (made < n && tries++ < 60) {
        const ox = (rng() - 0.5) * 90, oz = (rng() - 0.5) * 90;
        const bx = t.x + ox, bz = t.z + oz;
        const w = 8 + rng() * 8, d = 8 + rng() * 8, h = 4.5 + rng() * 7;
        const corners = [[bx - w / 2, bz - d / 2], [bx + w / 2, bz - d / 2], [bx - w / 2, bz + d / 2], [bx + w / 2, bz + d / 2]];
        const hs = corners.map(c => this.height(c[0], c[1]));
        if (Math.min(...hs) < 1.2) continue;
        if (Math.max(...hs) - Math.min(...hs) > 2.4) continue;
        if (list.some(b => Math.abs(b.x - bx) < (b.w + w) / 2 + 4 && Math.abs(b.z - bz) < (b.d + d) / 2 + 4)) continue;
        list.push({ x: bx, z: bz, w, d, h, y: Math.max(...hs) - 0.4, doorW: 2.6 });
        made++;
      }
    }
    this._buildings = list;
    return list;
  }

  // 建筑墙体碰撞盒（四面墙，正门 +Z 面留门洞）—— 客户端行走 / 服务端子弹共用
  buildingWalls() {
    if (this._walls) return this._walls;
    const T = 0.5; // 墙厚
    const walls = [];
    for (const b of this.buildings()) {
      walls.push({ x: b.x, z: b.z - b.d / 2, w: b.w, d: T, y: b.y, h: b.h });          // 后墙
      walls.push({ x: b.x - b.w / 2, z: b.z, w: T, d: b.d, y: b.y, h: b.h });          // 左墙
      walls.push({ x: b.x + b.w / 2, z: b.z, w: T, d: b.d, y: b.y, h: b.h });          // 右墙
      // 前墙分两段留门洞
      const sideW = (b.w - b.doorW) / 2;
      if (sideW > 0.3) {
        walls.push({ x: b.x - b.doorW / 2 - sideW / 2, z: b.z + b.d / 2, w: sideW, d: T, y: b.y, h: b.h });
        walls.push({ x: b.x + b.doorW / 2 + sideW / 2, z: b.z + b.d / 2, w: sideW, d: T, y: b.y, h: b.h });
      }
    }
    this._walls = walls;
    return walls;
  }

  trees() {
    if (this._trees) return this._trees;
    const rng = mulberry32(this.seed + 3);
    const list = [];
    const bs = this.buildings();
    let tries = 0;
    while (list.length < 420 && tries++ < 3000) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * this.half * 0.86;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = this.height(x, z);
      if (h < 1.5 || h > 46) continue;
      if (this._slope(x, z) > 0.75) continue;
      if (bs.some(b => Math.abs(b.x - x) < b.w / 2 + 4 && Math.abs(b.z - z) < b.d / 2 + 4)) continue;
      list.push({ x, z, y: h, s: 0.8 + rng() * 1.5, kind: rng() < 0.72 ? 0 : 1 });
    }
    this._trees = list;
    return list;
  }

  rocks() {
    if (this._rocks) return this._rocks;
    const rng = mulberry32(this.seed + 4);
    const list = [];
    let tries = 0;
    while (list.length < 90 && tries++ < 800) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * this.half * 0.88;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = this.height(x, z);
      if (h < 0.8) continue;
      list.push({ x, z, y: h, s: 0.6 + rng() * 1.8 });
    }
    this._rocks = list;
    return list;
  }

  // 树干/石头圆形碰撞体（带网格加速索引）；灌木不挡路只隐蔽
  obstacles() {
    if (this._obst) return this._obst;
    const list = [];
    for (const t of this.trees()) list.push({ x: t.x, z: t.z, r: 0.45 + t.s * 0.28 });
    for (const k of this.rocks()) list.push({ x: k.x, z: k.z, r: 0.55 + k.s * 0.62 });
    const cell = 20, map = new Map();
    for (const o of list) {
      const key = Math.floor(o.x / cell) + ',' + Math.floor(o.z / cell);
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(o);
    }
    this._obst = { cell, map };
    return this._obst;
  }

  // 圆形障碍推出（人物/机器人用），返回修正后的坐标
  pushOutObstacle(x, z, radius) {
    const { cell, map } = this.obstacles();
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = map.get((cx + i) + ',' + (cz + j));
      if (!arr) continue;
      for (const o of arr) {
        const min = o.r + radius;
        const dx = x - o.x, dz = z - o.z;
        if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-4) { x = o.x + (dx / d) * min; z = o.z + (dz / d) * min; }
        else x = o.x + min; // 恰好在圆心：向东推出
      }
    }
    return { x, z };
  }

  // 是否撞上障碍（载具/刷怪点用）
  hitsObstacle(x, z, radius) {
    const { cell, map } = this.obstacles();
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = map.get((cx + i) + ',' + (cz + j));
      if (!arr) continue;
      for (const o of arr) {
        const min = o.r + radius;
        if ((x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < min * min) return true;
      }
    }
    return false;
  }

  // 拾取物候选点：屋内优先（可进房捡装备），其余在建筑附近与野外
  lootSpots() {
    if (this._lootSpots) return this._lootSpots;
    const rng = mulberry32(this.seed + 5);
    const list = [];
    const bs = this.buildings();
    // 屋内点
    for (const b of bs) {
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const x = b.x + (rng() - 0.5) * (b.w - 3);
        const z = b.z + (rng() - 0.5) * (b.d - 3);
        list.push({ x, z, y: b.y + 0.15, inside: true });
      }
    }
    // 屋外点
    let tries = 0;
    while (list.length < bs.length * 3 + 140 && tries++ < 2500) {
      let x, z;
      if (rng() < 0.5 && bs.length) {
        const b = bs[Math.floor(rng() * bs.length)];
        x = b.x + (rng() - 0.5) * (b.w + 16);
        z = b.z + (rng() - 0.5) * (b.d + 16);
      } else {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * this.half * 0.8;
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      }
      const h = this.height(x, z);
      if (h < 0.8 || h > 44 || this._slope(x, z) > 0.9) continue;
      if (bs.some(b => Math.abs(b.x - x) < b.w / 2 + 0.5 && Math.abs(b.z - z) < b.d / 2 + 0.5)) continue; // 不刷在墙里
      list.push({ x, z, y: h + 0.15 });
    }
    this._lootSpots = list;
    return list;
  }
}
