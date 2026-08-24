// FIREZONE 战斗客户端：Three.js 渲染 + 本地预测 + HUD
import * as THREE from '/vendor/three.module.js';
import { Terrain } from '/shared/terrain.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

const SCENERY = {
  dawn:  { sky: 0x6f9ec4, horizon: 0xffc490, fog: 0xd9b48c, hemi: 0.7, dir: 0.85, water: 0x3a6a8a, night: false, exposure: 1.05, sun: [0.75, 0.35, -0.5] },
  day:   { sky: 0x5a9bd8, horizon: 0xcfe4f5, fog: 0xc4dcf0, hemi: 0.9, dir: 1.2, water: 0x2f6d9e, night: false, exposure: 1.0, sun: [0.5, 0.8, 0.3] },
  dusk:  { sky: 0x4a4a7a, horizon: 0xff9a5d, fog: 0xc48a6a, hemi: 0.6, dir: 0.7, water: 0x4a5a7a, night: false, exposure: 1.1, sun: [-0.7, 0.25, 0.6] },
  night: { sky: 0x101830, horizon: 0x1c2a4a, fog: 0x182238, hemi: 0.55, dir: 0.62, water: 0x18263e, night: true, exposure: 1.35, sun: [0.3, 0.7, -0.4] },
};

// ---------- 简易合成音效 ----------
class Sfx {
  constructor() { this.ctx = null; this.master = null; this._loops = {}; }
  ensure() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      return true;
    } catch { return false; }
  }
  _noise(dur) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }
  shot(type = 'ar', vol = 1) {
    if (!this.ensure()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = type === 'sniper' ? 0.3 : type === 'shotgun' ? 0.25 : 0.12;
    const src = this._noise(dur);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = vol < 0.4 ? 500 : type === 'sniper' ? 2400 : 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
  }
  blip(freq = 800, dur = 0.07, vol = 0.25, type = 'square') {
    if (!this.ensure()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur);
  }
  hitmark() { this.blip(1100, 0.05, 0.2, 'sine'); }
  kill() { this.blip(880, 0.1, 0.3, 'sine'); setTimeout(() => this.blip(1320, 0.15, 0.3, 'sine'), 90); }
  reload() { this.blip(300, 0.05, 0.2); setTimeout(() => this.blip(500, 0.05, 0.2), 160); }
  pickup() { this.blip(660, 0.06, 0.2, 'sine'); }
  chute() { if (!this.ensure()) return; const s = this._noise(0.5); const g = this.ctx.createGain(); const t = this.ctx.currentTime; g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5); s.connect(g).connect(this.master); s.start(); }
  boom(vol = 1) {
    if (!this.ensure()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._noise(0.7);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.8 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    s.connect(f).connect(g).connect(this.master); s.start();
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
    const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.6 * vol, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(g2).connect(this.master); o.start(t); o.stop(t + 0.7);
  }
  wind(on, speed) {
    if (!this.ensure()) return;
    if (on && !this._loops.wind) {
      const src = this._noise(2);
      src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 400;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master); src.start();
      this._loops.wind = { g, src };
    }
    if (this._loops.wind) this._loops.wind.g.gain.value = on ? clamp(speed / 60, 0, 0.5) : 0;
  }
  engine(on, speed) {
    if (!this.ensure()) return;
    if (on && !this._loops.engine) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 60;
      const g = this.ctx.createGain(); g.gain.value = 0;
      o.connect(g).connect(this.master); o.start();
      this._loops.engine = { o, g };
    }
    if (this._loops.engine) {
      this._loops.engine.g.gain.value = on ? 0.12 : 0;
      if (on) this._loops.engine.o.frequency.value = 50 + Math.abs(speed) * 3.5;
    }
  }
}

export class Game {
  constructor(opts) {
    this.socket = opts.socket;
    this.user = opts.user;
    this.cfg = opts.cfg;
    this.battle = opts.battle;
    this.onExit = opts.onExit;
    this.disposed = false;
    this.isAdmin = opts.user.role === 'admin' || !!opts.user.gm; // GM 能力：管理员或被授权玩家

    this.isTouch = window.matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 900;

    this.terrain = new Terrain(this.battle.map.seed, this.battle.map.size);
    this.half = this.battle.map.size / 2;

    // 自身状态（本地预测）
    this.self = {
      id: opts.you.id,
      pos: new THREE.Vector3(0, 400, 0),
      yaw: 0, pitch: -0.3, vy: 0,
      st: 'p', cr: false, moving: false, hp: 100,
      sprint: false, vehId: null,
    };
    this.inv = opts.you.inv || { w: [null, null], cur: 0, am: {}, md: { bandage: 0, medkit: 0 }, vest: 0, helmet: 0 };
    this.kills = 0;
    this.dead = false;
    this.over = false;
    this.fp = false; // 默认第三人称（能看到自己的角色与皮肤），按 V 切第一人称
    this.aimbot = false;
    this.esp = false;
    this.spectateId = null;
    this.chatChannel = 'all';

    // 实体/快照
    this.ents = new Map();   // id -> {group, parts, name?, data}
    this.names = this.battle.names || {};
    this.snaps = [];         // 最近快照
    this.lastSnap = null;
    this.loot = new Map();
    for (const it of this.battle.loot || []) this.loot.set(it.id, it);
    this.vehMeshes = new Map();
    this.crates = new Map();
    this.tracers = [];
    this.boomsFx = [];
    this.planeMesh = null;
    this.zone = null;

    this.keys = {};
    this.joy = { x: 0, y: 0, active: false };
    this.lookTouch = null;
    this.firing = false;
    this.ads = false; // 右键开镜
    this.punchT = 0; // 拳击动画计时
    this.nextShotAt = 0;
    this.lastSendAt = 0;
    this.sendSeq = 0;
    this.animPhase = 0;
    this.gmFlags = { god: false, infammo: false };

    this.sfx = new Sfx();

    this._initThree();
    this._buildWorld();
    // 自己的角色模型（第三人称显示）
    const myInfo = this.names[this.self.id] || {};
    this.ownMesh = this._makePlayerMesh(myInfo.sk || '#7a8a5a');
    this.ownMesh.group.visible = false;
    this.scene.add(this.ownMesh.group);
    this._initHud();
    this._initInput();
    this._initSocket();

    this.socket.emit('battle:hello');
    this._loop = this._loop.bind(this);
    this.lastT = performance.now();
    this.rafId = requestAnimationFrame(this._loop);
  }

  // ================= 三维初始化 =================
  _initThree() {
    const canvas = $('c3d');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.isTouch, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.isTouch ? 1.3 : 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.isTouch ? 78 : 72, innerWidth / innerHeight, 0.1, 1600);
    this.camera.up.set(0, 1, 0);

    const sc = SCENERY[this.battle.scenery] || SCENERY.day;
    this.scenery = sc;
    this.renderer.toneMappingExposure = sc.exposure;
    this.scene.background = new THREE.Color(sc.sky);
    this.scene.fog = new THREE.Fog(sc.fog, 160, sc.night ? 780 : 1000);

    // 天空穹顶（渐变）
    const skyGeo = new THREE.SphereGeometry(1450, 20, 14);
    const skyPos = skyGeo.attributes.position;
    const skyCol = new Float32Array(skyPos.count * 3);
    const cTop = new THREE.Color(sc.sky), cHor = new THREE.Color(sc.horizon), cTmp = new THREE.Color();
    for (let i = 0; i < skyPos.count; i++) {
      const y = skyPos.getY(i) / 1450; // -1..1
      const k = clamp((y + 0.15) / 0.9, 0, 1);
      cTmp.copy(cHor).lerp(cTop, Math.pow(k, 0.8));
      skyCol[i * 3] = cTmp.r; skyCol[i * 3 + 1] = cTmp.g; skyCol[i * 3 + 2] = cTmp.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCol, 3));
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10;
    this.scene.add(sky);

    // 太阳
    const sunCanvas = document.createElement('canvas');
    sunCanvas.width = sunCanvas.height = 128;
    const sctx = sunCanvas.getContext('2d');
    const grad = sctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,250,230,1)');
    grad.addColorStop(0.25, sc.night ? 'rgba(220,230,255,0.9)' : 'rgba(255,230,170,0.95)');
    grad.addColorStop(1, 'rgba(255,220,150,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 128, 128);
    const sunTex = new THREE.CanvasTexture(sunCanvas);
    const sunDir = new THREE.Vector3(...sc.sun).normalize();
    const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false }));
    sunSpr.position.copy(sunDir).multiplyScalar(1300);
    sunSpr.scale.setScalar(sc.night ? 120 : 260);
    this.scene.add(sunSpr);

    this.hemi = new THREE.HemisphereLight(sc.sky, sc.night ? 0x39435c : 0x3a4030, sc.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(sc.night ? 0xa8c0e8 : 0xfff2dd, sc.dir);
    this.sun.position.copy(sunDir).multiplyScalar(300);
    this.scene.add(this.sun);
    // 夜间补光：低强度环境光，保证人物道具可辨识
    if (sc.night) {
      this.scene.add(new THREE.AmbientLight(0x4a5a78, 0.45));
    }

    if (sc.night) {
      const g = new THREE.BufferGeometry();
      const pts = [];
      for (let i = 0; i < 600; i++) {
        const a = Math.random() * Math.PI * 2, p = Math.random() * Math.PI * 0.45;
        const r = 1300;
        pts.push(Math.cos(a) * Math.cos(p) * r, Math.sin(p) * r + 100, Math.sin(a) * Math.cos(p) * r);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 2.2, sizeAttenuation: false, fog: false })));
    }

    // 云层
    this.clouds = new THREE.Group();
    const cloudMat = new THREE.MeshLambertMaterial({ color: sc.night ? 0x2a3348 : 0xffffff, transparent: true, opacity: 0.85, fog: false });
    for (let i = 0; i < 12; i++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), cloudMat);
      const a = Math.random() * Math.PI * 2, r = 150 + Math.random() * 600;
      c.position.set(Math.cos(a) * r, 280 + Math.random() * 140, Math.sin(a) * r);
      c.scale.set(40 + Math.random() * 70, 8 + Math.random() * 10, 30 + Math.random() * 50);
      this.clouds.add(c);
    }
    this.scene.add(this.clouds);

    // 水面（高光）
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshPhongMaterial({ color: sc.water, shininess: 130, specular: 0x8fb4d8, transparent: true, opacity: 0.86 })
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 0;
    this.scene.add(this.water);

    this._onResize = () => {
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      if (this.espCanvas) { this.espCanvas.width = innerWidth; this.espCanvas.height = innerHeight; }
    };
    window.addEventListener('resize', this._onResize);
  }

  _buildWorld() {
    const T = this.terrain;
    // 地形网格 + 顶点色（自然配色 + 噪声变化 + 积雪）
    const seg = this.isTouch ? 120 : 190;
    const geo = new THREE.PlaneGeometry(this.battle.map.size, this.battle.map.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const cRock = new THREE.Color(0x7d7a72), cSnow = new THREE.Color(0xe9eff3);
    const cGrassA = new THREE.Color(0x5d9246), cGrassB = new THREE.Color(0x3f7034);
    const cDry = new THREE.Color(0x8f9a55), cSand = new THREE.Color(0xe0d2a8);
    const hashN = (x, z) => {
      const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = T.height(x, z);
      pos.setY(i, h);
      const d = 4;
      const hx = T.height(x + d, z) - T.height(x - d, z);
      const hz = T.height(x, z + d) - T.height(x, z - d);
      const slope = Math.sqrt(hx * hx + hz * hz) / (2 * d);
      if (h < -2.5) c.setRGB(0.07, 0.14, 0.2);
      else if (h < 0.35) c.copy(cSand);
      else if (h < 2.2) c.copy(cSand).lerp(cGrassA, (h - 0.35) / 1.85);
      else if (h < 22) {
        const k = (h - 2.2) / 19.8;
        c.copy(cGrassA).lerp(cGrassB, k);
        const dry = hashN(Math.floor(x / 6), Math.floor(z / 6));
        if (dry > 0.62) c.lerp(cDry, (dry - 0.62) * 1.6);
      } else if (h < 34) c.copy(cGrassB).lerp(cRock, (h - 22) / 12);
      else if (h < 42) c.copy(cRock);
      else c.copy(cRock).lerp(cSnow, Math.min(1, (h - 42) / 10));
      if (slope > 0.45 && h > 0.5) c.lerp(cRock, Math.min(1, (slope - 0.45) * 1.8));
      // 微噪声避免大色块
      const j = 0.92 + hashN(x * 3.1, z * 2.7) * 0.16;
      c.multiplyScalar(j);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // 建筑（空心可进入：视觉墙体 = 碰撞墙体 + 门洞 + 屋顶 + 地板 + 地基）
    this.buildingMeshes = [];
    const wallColors = [0xb5a98f, 0xa39a8a, 0x97a0ac, 0xab9c8e];
    const winMat = this.scenery.night
      ? new THREE.MeshBasicMaterial({ color: 0xffd98a })
      : new THREE.MeshLambertMaterial({ color: 0x2c3a4c });
    const trimMat = new THREE.MeshLambertMaterial({ color: 0x5a4438 });
    const WT = 0.55; // 墙厚（与碰撞一致）
    const addWallBox = (mat, w, h, d, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz);
      this.scene.add(m);
    };
    for (const b of T.buildings()) {
      const wallColor = wallColors[Math.floor(Math.random() * wallColors.length)];
      const wallMat = new THREE.MeshLambertMaterial({ color: wallColor });
      const FOUND = 1.6; // 地基下延，遮挡坡地缝隙
      const cy = b.y + b.h / 2;
      // 后墙 / 左墙 / 右墙
      addWallBox(wallMat, b.w + WT, b.h + FOUND, WT, b.x, cy - FOUND / 2, b.z - b.d / 2);
      addWallBox(wallMat, WT, b.h + FOUND, b.d, b.x - b.w / 2, cy - FOUND / 2, b.z);
      addWallBox(wallMat, WT, b.h + FOUND, b.d, b.x + b.w / 2, cy - FOUND / 2, b.z);
      // 前墙两段（中间是门洞，门楣补上方）
      const sideW = (b.w - b.doorW) / 2;
      addWallBox(wallMat, sideW, b.h + FOUND, WT, b.x - b.doorW / 2 - sideW / 2, cy - FOUND / 2, b.z + b.d / 2);
      addWallBox(wallMat, sideW, b.h + FOUND, WT, b.x + b.doorW / 2 + sideW / 2, cy - FOUND / 2, b.z + b.d / 2);
      addWallBox(wallMat, b.doorW, b.h - 2.4, WT, b.x, b.y + 2.4 + (b.h - 2.4) / 2, b.z + b.d / 2);
      // 门框柱
      addWallBox(trimMat, 0.3, 2.6, WT + 0.15, b.x - b.doorW / 2, b.y + 1.3, b.z + b.d / 2);
      addWallBox(trimMat, 0.3, 2.6, WT + 0.15, b.x + b.doorW / 2, b.y + 1.3, b.z + b.d / 2);
      // 地板与屋顶
      addWallBox(new THREE.MeshLambertMaterial({ color: 0x6a5a48 }), b.w, 0.3, b.d, b.x, b.y - 0.1, b.z);
      addWallBox(trimMat, b.w + 1, 0.5, b.d + 1, b.x, b.y + b.h + 0.25, b.z);
      // 窗户（前墙两侧）
      const cols = Math.max(1, Math.floor(b.w / 5));
      for (let cc = 0; cc < cols; cc++) {
        const off = (cc - (cols - 1) / 2) * (b.w / cols);
        if (Math.abs(off) < b.doorW / 2 + 1) continue;
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 0.12), winMat);
        win.position.set(b.x + off, b.y + 2.4, b.z + b.d / 2 + WT / 2);
        this.scene.add(win);
      }
      this.buildingMeshes.push(b);
    }

    // 树（实例化，双层树冠）
    const trees = T.trees();
    const pines = trees.filter(t => t.kind === 0), oaks = trees.filter(t => t.kind === 1);
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 2.6, 5);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4630 });
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const m4 = new THREE.Matrix4();
    let idx = 0;
    const leafCol = new THREE.Color();
    const pineGeo = new THREE.ConeGeometry(1.6, 4.2, 7);
    const pineMesh = new THREE.InstancedMesh(pineGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), pines.length);
    pineMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pines.length * 3), 3);
    const oakGeo = new THREE.DodecahedronGeometry(1.6, 0);
    const oakMesh = new THREE.InstancedMesh(oakGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), oaks.length);
    oakMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(oaks.length * 3), 3);
    let pi = 0, oi = 0;
    for (const t of trees) {
      m4.makeScale(t.s * 0.75, t.s, t.s * 0.75);
      m4.setPosition(t.x, t.y + t.s * 1.2, t.z);
      trunkMesh.setMatrixAt(idx++, m4);
      if (t.kind === 0) {
        m4.makeScale(t.s, t.s * 1.15, t.s);
        m4.setPosition(t.x, t.y + t.s * 3.2, t.z);
        pineMesh.setMatrixAt(pi, m4);
        leafCol.setHSL(0.3 + Math.random() * 0.06, 0.42, 0.2 + Math.random() * 0.09);
        pineMesh.setColorAt(pi, leafCol);
        pi++;
      } else {
        m4.makeScale(t.s, t.s * 0.85, t.s);
        m4.setPosition(t.x, t.y + t.s * 2.6, t.z);
        oakMesh.setMatrixAt(oi, m4);
        leafCol.setHSL(0.24 + Math.random() * 0.07, 0.5, 0.26 + Math.random() * 0.1);
        oakMesh.setColorAt(oi, leafCol);
        oi++;
      }
    }
    this.scene.add(trunkMesh, pineMesh, oakMesh);

    // 灌木
    const bushCount = this.isTouch ? 90 : 160;
    const bushMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.8, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), bushCount);
    bushMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bushCount * 3), 3);
    for (let i = 0; i < bushCount; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.half * 0.85;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = T.height(x, z);
      const s = 0.6 + Math.random() * 1.1;
      m4.makeScale(s, s * 0.7, s);
      m4.setPosition(x, h + 0.2, z);
      bushMesh.setMatrixAt(i, m4);
      leafCol.setHSL(0.27 + Math.random() * 0.06, 0.45, 0.22 + Math.random() * 0.08);
      bushMesh.setColorAt(i, leafCol);
    }
    this.scene.add(bushMesh);

    // 岩石
    const rocks = T.rocks();
    const rockMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0x6f6e68 }), rocks.length);
    rocks.forEach((r, i) => {
      m4.makeScale(r.s, r.s * 0.75, r.s);
      m4.setPosition(r.x, r.y + r.s * 0.18, r.z);
      rockMesh.setMatrixAt(i, m4);
    });
    this.scene.add(rockMesh);

    // 毒圈墙（夜间更醒目）
    this.zoneWall = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 600, 64, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: this.scenery.night ? 0.3 : 0.16, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    this.zoneWall.position.y = 200;
    this.scene.add(this.zoneWall);

    // 飞机
    this.planeMesh = this._makePlane();
    this.scene.add(this.planeMesh);

    // 掉落物（实例化，按类型）+ 装备光柱（远处可见）
    this._lootMeshes = {
      weapon: new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.16, 0.9), new THREE.MeshLambertMaterial({ color: 0x333a44 }), 600),
      ammo: new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.22, 0.3), new THREE.MeshLambertMaterial({ color: 0xc2a23a }), 600),
      med: new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), new THREE.MeshLambertMaterial({ color: 0xdddddd }), 400),
      armor: new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.14, 0.4), new THREE.MeshLambertMaterial({ color: 0x4a6ac2 }), 200),
    };
    this._lootBeams = {
      weapon: new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 8, 0.14), new THREE.MeshBasicMaterial({ color: this.scenery.night ? 0x9af0ff : 0x53e0ff, transparent: true, opacity: this.scenery.night ? 0.65 : 0.33, fog: false }), 600),
      med: new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 6, 0.14), new THREE.MeshBasicMaterial({ color: this.scenery.night ? 0xff8a8a : 0xff5a5a, transparent: true, opacity: this.scenery.night ? 0.6 : 0.3, fog: false }), 400),
    };
    for (const k of Object.keys(this._lootMeshes)) this.scene.add(this._lootMeshes[k]);
    for (const k of Object.keys(this._lootBeams)) this.scene.add(this._lootBeams[k]);
    this._refreshLootMeshes();
  }

  _makePlane() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 14, 8), new THREE.MeshLambertMaterial({ color: 0x8a939e }));
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(20, 0.35, 3), new THREE.MeshLambertMaterial({ color: 0x77808c }));
    wing.position.y = 0.8;
    g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(6, 2.4, 0.3), new THREE.MeshLambertMaterial({ color: 0x77808c }));
    tail.position.set(0, 1.6, -6.6);
    g.add(tail);
    return g;
  }

  _makePlayerMesh(outfit) {
    return makeCharacterMesh(outfit, !!(this.scenery && this.scenery.night));
  }

  _makeNameSprite(name, color) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 30px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(name, 129, 42);
    ctx.fillStyle = color;
    ctx.fillText(name, 128, 40);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
    sp.scale.set(3.4, 0.85, 1);
    sp.position.y = 2.15;
    return sp;
  }

  // ================= HUD =================
  _initHud() {
    $('battle-loading').classList.add('hidden');
    $('hud').classList.remove('hidden');
    if (this.isTouch) $('touch-ui').classList.remove('hidden');
    else $('crosshair').classList.remove('hidden');
    if (this.isAdmin) $('gm-panel').classList.remove('hidden');
    $('net-hud').classList.remove('hidden');
    this._ping = null;
    const measure = () => {
      const t = Date.now();
      this.socket.emit('ping', { t }, () => {
        if (!this.disposed) this._ping = Date.now() - t;
      });
    };
    measure();
    this._pingTimer = setInterval(measure, 2000);

    // ESP 画布
    this.espCanvas = document.createElement('canvas');
    this.espCanvas.id = 'esp-canvas';
    Object.assign(this.espCanvas.style, { position: 'absolute', inset: 0, zIndex: 12, pointerEvents: 'none' });
    this.espCanvas.width = innerWidth; this.espCanvas.height = innerHeight;
    $('page-battle').appendChild(this.espCanvas);

    // 小地图底图（山体阴影 + 水深渐变）
    this.mapBase = document.createElement('canvas');
    this.mapBase.width = 256; this.mapBase.height = 256;
    const mctx = this.mapBase.getContext('2d');
    const img = mctx.createImageData(256, 256);
    const M = this.battle.map.size;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const wx = (px / 256 - 0.5) * M;
        const wz = (py / 256 - 0.5) * M;
        const step = M / 256;
        const h = this.terrain.height(wx, wz);
        // 山体阴影：西北高光照亮
        const shade = h > 0
          ? clamp(1 + (this.terrain.height(wx - step * 2, wz - step * 2) - h) * 0.12, 0.62, 1.35)
          : 1;
        let r, g2, b;
        if (h < -3) { r = 22; g2 = 48; b = 78; }
        else if (h < 0) { const k = (h + 3) / 3; r = 22 + k * 30; g2 = 48 + k * 30; b = 78 + k * 26; }
        else if (h < 0.5) { r = 196; g2 = 180; b = 132; }
        else if (h < 14) { r = 78; g2 = 124; b = 62; }
        else if (h < 28) { r = 102; g2 = 116; b = 70; }
        else if (h < 40) { r = 136; g2 = 134; b = 124; }
        else { r = 224; g2 = 230; b = 234; }
        const i = (py * 256 + px) * 4;
        img.data[i] = Math.min(255, r * shade);
        img.data[i + 1] = Math.min(255, g2 * shade);
        img.data[i + 2] = Math.min(255, b * shade);
        img.data[i + 3] = 255;
      }
    }
    mctx.putImageData(img, 0, 0);

    this._updateInvHud();
    this._bindHudButtons();
    this.lastMapDraw = 0;
  }

  _bindHudButtons() {
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = (e) => { e.preventDefault(); fn(); }; };
    bind('btn-spectate', () => this._startSpectate());
    bind('btn-death-back', () => this.onExit());
    bind('btn-end-back', () => this.onExit());
    bind('btn-spec-back', () => this.onExit());
    bind('btn-spec-next', () => this._cycleSpectate());
    bind('btn-resume', () => { $('pause-menu').classList.add('hidden'); this._lockPointer(); });
    bind('btn-quit-battle', () => this.onExit());

    document.querySelectorAll('#meds-row .med-btn').forEach(btn => {
      btn.onclick = () => this.socket.emit('act', { kind: 'heal', item: btn.dataset.item });
    });
    document.querySelectorAll('#slots .slot').forEach(slot => {
      slot.onclick = () => this.socket.emit('switch', { slot: parseInt(slot.dataset.slot) });
    });
    // 操作帮助：H 键 / ❓按钮 / 首局自动弹出
    const showHelp = (show) => {
      $('help-overlay').classList.toggle('hidden', !show);
      if (!show) {
        localStorage.setItem('fz_help_seen', '1');
        if (!this.isTouch && !this.dead && !this.over) this._lockPointer();
      }
    };
    this._showHelp = showHelp;
    $('btn-help').onclick = () => showHelp(true);
    $('btn-help-close').onclick = () => showHelp(false);
    if (!localStorage.getItem('fz_help_seen')) showHelp(true);

    // 手机横屏：全屏并尝试锁定横屏（需在手势里触发）
    $('btn-fullscreen').onclick = async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          try { await screen.orientation.lock('landscape'); } catch { /* iOS 不支持，靠旋转提示 */ }
          toast('已进入全屏模式');
        } else {
          await document.exitFullscreen();
        }
      } catch { toast('当前浏览器不允许全屏', 'error'); }
    };
    // 竖屏提示的"仍要竖屏玩"：本次会话不再提示
    const rotateOv = $('rotate-overlay');
    if (sessionStorage.getItem('fz_rotate_skip')) rotateOv.classList.add('skipped');
    $('btn-rotate-skip').onclick = () => {
      rotateOv.classList.add('skipped');
      sessionStorage.setItem('fz_rotate_skip', '1');
    };
    // 全屏状态变化时同步按钮文案
    document.addEventListener('fullscreenchange', this._onFsChange = () => {
      const b = $('btn-fullscreen');
      if (b) b.textContent = document.fullscreenElement ? '⛶ 退出' : '⛶ 全屏';
    });
    if (this.isAdmin) {
      document.querySelectorAll('#gm-panel button').forEach(btn => {
        btn.onclick = () => this._gmCmd(btn.dataset.cmd);
      });
    }
  }

  _gmCmd(cmd) {
    if (!this.isAdmin) return;
    if (cmd === 'esp') {
      this.esp = !this.esp;
      this._gmBtn('esp', this.esp);
    } else if (cmd === 'aimbot') {
      this.aimbot = !this.aimbot;
      this._gmBtn('aimbot', this.aimbot);
    } else if (cmd === 'airstrike') {
      const hit = this._aimGround();
      if (hit) this.socket.emit('gm', { cmd: 'airstrike', x: hit.x, z: hit.z });
    } else {
      this.socket.emit('gm', { cmd });
      this.gmFlags[cmd] = !this.gmFlags[cmd];
      this._gmBtn(cmd, this.gmFlags[cmd]);
    }
  }

  _gmBtn(cmd, on) {
    const b = document.querySelector(`#gm-panel button[data-cmd="${cmd}"]`);
    if (b) b.classList.toggle('on', on);
  }

  _aimGround() {
    const dir = this._forward();
    const o = this._eyePos();
    for (let t = 2; t < 700; t += 3) {
      const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
      if (y < this.terrain.height(x, z)) return { x, z };
    }
    const p = o.clone().add(dir.clone().multiplyScalar(300));
    return { x: clamp(p.x, -this.half, this.half), z: clamp(p.z, -this.half, this.half) };
  }

  // ================= 输入 =================
  _initInput() {
    const canvas = $('c3d');

    this._locked = false;
    this._dragMode = false;

    canvas.addEventListener('click', () => {
      this.sfx.ensure();
      if (this.sfx.ctx && this.sfx.ctx.state === 'suspended') this.sfx.ctx.resume();
      if (!this.isTouch && !this.dead && !this.over && !this._locked) this._lockPointer();
      // 指针锁定不可用的环境（部分内嵌浏览器）自动切换为拖动视角
      setTimeout(() => {
        if (!this._locked && !this.isTouch && !this._dragMode) {
          this._dragMode = true;
          toast('当前环境不支持鼠标锁定，已切换为「按住左键拖动」转视角');
        }
      }, 700);
    });

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === canvas;
    });

    this._onMouseMove = (e) => {
      if (this._locked || (this._dragMode && (e.buttons & 1))) {
        const s = 0.0021 * (this.ads ? 0.35 : 1); // 开镜时降低灵敏度
        // 右手坐标系：朝 +Z 看时玩家右侧是 -X，鼠标右移(dx>0)视角应右转 = yaw 减小
        this.self.yaw -= e.movementX * s;
        this.self.pitch = clamp(this.self.pitch - e.movementY * s, -1.45, 1.45);
      }
    };
    document.addEventListener('mousemove', this._onMouseMove);

    this._onMouseDown = (e) => {
      if (e.button === 0 && (this._locked || this._dragMode)) this.firing = true;
      if (e.button === 2 && (this._locked || this._dragMode)) this.ads = true; // 右键开镜
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.ads = false;
    };
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    this._onCtx = (e) => e.preventDefault(); // 屏蔽右键菜单
    document.addEventListener('contextmenu', this._onCtx);

    this._onWheel = (e) => {
      if (!this._locked && !this._dragMode) return;
      const cur = this.inv.cur || 0;
      this.socket.emit('switch', { slot: cur === 0 ? 1 : 0 });
    };
    document.addEventListener('wheel', this._onWheel);

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);

    if (this.isTouch) this._initTouch();
  }

  _key(e, down) {
    if (this._chatOpen) {
      if (e.key === 'Enter') this._sendChat();
      else if (e.key === 'Escape') this._closeChat();
      else if (e.key === 'Tab') { e.preventDefault(); this.chatChannel = this.chatChannel === 'all' ? 'team' : 'all'; $('chat-input-battle').placeholder = this.chatChannel === 'all' ? '[全体] 回车发送' : '[队伍] 回车发送'; }
      return;
    }
    if (!down) {
      this.keys[e.code] = false;
      if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.add('hidden'); }
      return;
    }
    this.keys[e.code] = true;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (this.self.st === 'p') {
          this._jumpQueued = true;
          this._lastJumpTry = 0;
          this.socket.emit('jump');
        }
        else this.keys.Space = true;
        break;
      case 'KeyC': this.self.cr = !this.self.cr; break;
      case 'KeyR': this.socket.emit('reload'); break;
      case 'KeyE': this._interact(); break;
      case 'KeyV': this.fp = !this.fp; toast(this.fp ? '第一人称' : '第三人称'); break;
      case 'KeyM': $('bigmap').classList.toggle('hidden'); break;
      case 'KeyH': this._showHelp && this._showHelp($('help-overlay').classList.contains('hidden')); break;
      case 'Tab': e.preventDefault(); this._showScoreboard(); break;
      case 'Enter': this._openChat(); break;
      case 'Digit1': this.socket.emit('switch', { slot: 0 }); break;
      case 'Digit2': this.socket.emit('switch', { slot: 1 }); break;
      case 'Digit3': this.socket.emit('act', { kind: 'heal', item: 'bandage' }); break;
      case 'Digit4': this.socket.emit('act', { kind: 'heal', item: 'medkit' }); break;
      case 'Escape':
        if (!this._chatOpen && !this.dead && !this.over) $('pause-menu').classList.remove('hidden');
        break;
      case 'F1': if (this.isAdmin) { e.preventDefault(); this._gmCmd('esp'); } break;
      case 'F2': if (this.isAdmin) { e.preventDefault(); this._gmCmd('aimbot'); } break;
      case 'F3': if (this.isAdmin) { e.preventDefault(); this._gmCmd('god'); } break;
      case 'F4': if (this.isAdmin) { e.preventDefault(); this._gmCmd('infammo'); } break;
      case 'F5': if (this.isAdmin) { e.preventDefault(); this._gmCmd('airstrike'); } break;
    }
  }

  _initTouch() {
    // 每局重开时清掉上一局累积在持久 DOM 上的触屏监听（clone 不带监听器），否则按钮会多次触发
    for (const id of ['joy-base', 'look-zone', 'tb-fire', 'tb-ads', 'tb-jump', 'tb-crouch', 'tb-reload', 'tb-interact', 'tb-map', 'tb-person', 'btn-map-close', 'bigmap']) {
      const el = $(id);
      if (el) el.replaceWith(el.cloneNode(true));
    }
    const base = $('joy-base'), knob = $('joy-knob');
    let joyTouch = null;
    const rectCenter = () => {
      const r = base.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, rx: r.width / 2 };
    };
    base.addEventListener('touchstart', (e) => {
      e.preventDefault();
      joyTouch = e.changedTouches[0].identifier;
      this.joy.active = true;
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouch) {
          const c = rectCenter();
          let dx = (t.clientX - c.x) / c.rx, dy = (t.clientY - c.y) / c.rx;
          const len = Math.hypot(dx, dy);
          if (len > 1) { dx /= len; dy /= len; }
          this.joy.x = dx; this.joy.y = dy;
          knob.style.left = 50 + dx * 32 + '%';
          knob.style.top = 50 + dy * 32 + '%';
        } else if (this.lookTouch === t.identifier) {
          const lt = this._lastLookTouch || { x: t.clientX, y: t.clientY };
          this.self.yaw -= (t.clientX - lt.x) * 0.005;
          this.self.pitch = clamp(this.self.pitch - (t.clientY - lt.y) * 0.005, -1.45, 1.45);
          this._lastLookTouch = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouch) {
          joyTouch = null; this.joy = { x: 0, y: 0, active: false };
          knob.style.left = '50%'; knob.style.top = '50%';
        }
        if (this.lookTouch === t.identifier) { this.lookTouch = null; this._lastLookTouch = null; }
      }
    });
    const look = $('look-zone');
    look.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.lookTouch = t.identifier;
      this._lastLookTouch = { x: t.clientX, y: t.clientY };
      this.sfx.ensure();
      if (this.sfx.ctx && this.sfx.ctx.state === 'suspended') this.sfx.ctx.resume();
    }, { passive: false });

    const hold = (id, on, off) => {
      const el = $(id);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); on(); }, { passive: false });
      el.addEventListener('touchend', (e) => { e.preventDefault(); off && off(); }, { passive: false });
    };
    hold('tb-fire', () => { this.firing = true; }, () => { this.firing = false; });
    hold('tb-ads', () => { this.ads = !this.ads; });
    hold('tb-jump', () => {
      if (this.self.st === 'p') { this._jumpQueued = true; this._lastJumpTry = 0; this.socket.emit('jump'); }
      else this.keys.Space = true;
    }, () => { this.keys.Space = false; });
    hold('tb-crouch', () => { this.self.cr = !this.self.cr; });
    hold('tb-reload', () => this.socket.emit('reload'));
    hold('tb-interact', () => this._interact());
    hold('tb-map', () => $('bigmap').classList.toggle('hidden'));
    // 大地图关闭：按钮 + 点空白处（移动端没有 M 键）
    const closeMap = () => $('bigmap').classList.add('hidden');
    const mapBtn = $('btn-map-close');
    mapBtn.addEventListener('touchstart', (e) => { e.preventDefault(); closeMap(); }, { passive: false });
    mapBtn.onclick = closeMap;
    $('bigmap').addEventListener('touchstart', (e) => {
      if (e.target === $('bigmap')) { e.preventDefault(); closeMap(); }
    }, { passive: false });
    $('bigmap').addEventListener('click', (e) => { if (e.target === $('bigmap')) closeMap(); });
    hold('tb-person', () => { this.fp = !this.fp; });
  }

  _lockPointer() {
    try { $('c3d').requestPointerLock(); } catch { /* 忽略 */ }
  }

  _openChat() {
    this._chatOpen = true;
    const row = $('chat-input-row-battle');
    row.classList.remove('hidden');
    const input = $('chat-input-battle');
    input.placeholder = this.chatChannel === 'all' ? '[全体] 回车发送，Tab 切换' : '[队伍] 回车发送，Tab 切换';
    input.focus();
  }
  _sendChat() {
    const input = $('chat-input-battle');
    const text = input.value.trim();
    if (text) this.socket.emit('chat', { ch: this.chatChannel, text });
    input.value = '';
    this._closeChat();
  }
  _closeChat() {
    this._chatOpen = false;
    $('chat-input-row-battle').classList.add('hidden');
    $('chat-input-battle').blur();
    if (!this.isTouch && !this.dead && !this.over) this._lockPointer();
  }

  // ================= Socket =================
  _initSocket() {
    const s = this.socket;
    this._handlers = [];
    const on = (ev, fn) => { s.on(ev, fn); this._handlers.push([ev, fn]); };

    on('snap', (m) => this._onSnap(m));
    on('full', (m) => {
      this.names = m.names || this.names;
      for (const [id, info] of Object.entries(this.names)) {
        const ent = this.ents.get(id);
        if (ent && !ent.nameTag && info.n) {
          const isMate = info.t === this._myTeam();
          const tag = this._makeNameSprite(info.n, isMate ? '#7dff8a' : '#ffd0d0');
          ent.group.add(tag);
          ent.nameTag = tag;
        }
      }
    });
    on('loot', (m) => {
      for (const id of m.rm || []) this.loot.delete(id);
      for (const it of m.add || []) this.loot.set(it.id, it);
      this._refreshLootMeshes();
      if ((m.add || []).length) this.sfx.pickup();
    });
    on('shot', (m) => this._onShot(m));
    on('dmg', (m) => {
      $('hitmark').classList.remove('hidden');
      clearTimeout(this._hitT);
      this._hitT = setTimeout(() => $('hitmark').classList.add('hidden'), 120);
      this.sfx.hitmark();
      this._floatDmg(m.d, m.to);
    });
    on('hit', (m) => {
      this._dmgFlash();
      this.sfx.blip(220, 0.1, 0.3, 'sawtooth');
    });
    on('kill', (m) => this._onKill(m));
    on('dead', (m) => this._onDead(m));
    on('end', (m) => this._onEnd(m));
    on('inv', (m) => { this.inv = m; this._updateInvHud(); });
    on('hp', (m) => { this.self.hp = m.hp; });
    on('heal:cast', (m) => this._showCast(m));
    on('boom', (m) => this._onBoom(m));
    on('air', (m) => this._onAirdrop(m));
    on('air:land', (m) => {
      const c = this.crates.get(m.id);
      if (c) { c.landed = true; c.chute.visible = false; c.group.position.set(m.x, m.y, m.z); }
      if (this._distToSelf(m.x, m.z) < 200) this.sfx.blip(500, 0.3, 0.25, 'sine');
    });
    on('air:open', (m) => {
      const c = this.crates.get(m.id);
      if (c) c.smoke.visible = false;
    });
    on('rubber', (m) => {
      const d = Math.hypot(m.x - this.self.pos.x, m.y - this.self.pos.y, m.z - this.self.pos.z);
      if (d > 2) {
        this.self.pos.set(m.x, m.y, m.z);
        // 若被弹回空中，恢复正确的下落姿态（而不是以地面状态从高空坠落）
        const g = this.terrain.height(m.x, m.z);
        if (this.self.st !== 'p' && m.y - Math.max(g, -0.6) > 3) {
          this.self.st = m.y - g < 135 ? 'c' : 'f';
          this.self.vy = this.self.st === 'c' ? -7 : -15;
          this.sfx.chute();
        }
      }
    });
    on('chat', (m) => this.onChat(m));
    on('toast', (m) => toast(m.msg, m.type || ''));
    on('err', (m) => toast(m.msg || '错误', 'error'));
  }

  _onSnap(m) {
    this.lastSnap = m;
    this.snaps.push({ at: performance.now(), m });
    if (this.snaps.length > 4) this.snaps.shift();

    this.zone = m.z;
    const myTeam = this._myTeam();

    // 同步/创建实体
    const seen = new Set();
    for (const row of m.e) {
      const [id, x, y, z, yaw, st, cr, hp, wid, vehId] = row;
      seen.add(id);
      if (id === this.self.id) {
        this.self.hp = hp;
        this.self.vehId = vehId || null;
        // 服务器强制开伞/落地
        if (!this.dead) {
          if (st === 'c' && this.self.st === 'f') { this.self.st = 'c'; this.sfx.chute(); }
          if (st === 'g' && (this.self.st === 'f' || this.self.st === 'c')) { this.self.st = 'g'; this.self.pos.y = Math.max(this.self.pos.y, this.terrain.height(this.self.pos.x, this.self.pos.z)); }
          if (st === 'f' && this.self.st === 'p') this.self.st = 'f';
          // 载具进出同步（服务器是权威：上车/下车由快照驱动）
          if (st === 'v' && this.self.st !== 'v') {
            this.self.st = 'v';
            toast('🚗 已上车 · W/S 油门 A/D 转向，E 下车');
          }
          if (st !== 'v' && this.self.st === 'v') {
            this.self.st = 'g';
            this.self.pos.y = Math.max(this.terrain.height(this.self.pos.x, this.self.pos.z), -0.6);
          }
        }
        continue;
      }
      let ent = this.ents.get(id);
      if (!ent) {
        const info = this.names[id] || {};
        ent = this._makePlayerMesh(info.sk || '#7a8a5a');
        ent.info = info;
        ent.data = { x, y, z, yaw };
        ent.group.position.set(x, y, z);
        this.scene.add(ent.group);
        this.ents.set(id, ent);
      }
      ent.target = { x, y, z, yaw };
      ent.st = st; ent.cr = !!cr; ent.hp = hp; ent.wid = wid; ent.vehId = vehId;
    }
    for (const [id, ent] of this.ents) {
      if (!seen.has(id)) { this.scene.remove(ent.group); this.ents.delete(id); }
    }

    // 载具
    const vseen = new Set();
    for (const v of m.v) {
      vseen.add(v.id);
      let vm = this.vehMeshes.get(v.id);
      if (!vm) {
        vm = this._makeVehicle(v.type);
        this.scene.add(vm.group);
        this.vehMeshes.set(v.id, vm);
      }
      vm.target = { x: v.x, y: v.y, z: v.z, yaw: v.yaw };
      vm.hp = v.hp;
      vm.type = v.type;
    }
    for (const [id, vm] of this.vehMeshes) {
      if (!vseen.has(id)) { this.scene.remove(vm.group); this.vehMeshes.delete(id); }
    }

    // 飞机
    if (m.pl) {
      this.planeMesh.visible = true;
      this.planeMesh.position.set(m.pl[0], m.pl[1], m.pl[2]);
      const dx = this.battle.plane.tx - this.battle.plane.fx;
      const dz = this.battle.plane.tz - this.battle.plane.fz;
      this.planeMesh.rotation.y = Math.atan2(dx, dz);
    } else this.planeMesh.visible = false;

    // 空投箱
    for (const row of m.air || []) {
      const [id, x, y, z, landed, opened] = row;
      let c = this.crates.get(id);
      if (!c) { c = this._makeCrate(); this.crates.set(id, c); this.scene.add(c.group); }
      c.group.position.set(x, y, z);
      c.chute.visible = !landed;
      c.smoke.visible = landed && !opened;
      c.opened = opened; c.landed = landed;
    }
    for (const [id, c] of this.crates) {
      if (!(m.air || []).some(r => r[0] === id)) { this.scene.remove(c.group); this.crates.delete(id); }
    }

    $('alive-count').textContent = m.ac;
  }

  _makeVehicle(type) {
    const def = (this.cfg.vehicles || []).find(v => v.id === type) || { color: 0x8a8a90 };
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 4.2), new THREE.MeshLambertMaterial({ color: def.color || 0x8a8a90 }));
    body.position.y = 0.85;
    g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 1.8), new THREE.MeshLambertMaterial({ color: 0x222831 }));
    cab.position.set(0, 1.55, -0.3);
    g.add(cab);
    const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10);
    const wm = new THREE.MeshLambertMaterial({ color: 0x181818 });
    for (const [wx, wz] of [[-1.05, 1.4], [1.05, 1.4], [-1.05, -1.4], [1.05, -1.4]]) {
      const w = new THREE.Mesh(wg, wm);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.42, wz);
      g.add(w);
    }
    return { group: g };
  }

  _makeCrate() {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.6), new THREE.MeshLambertMaterial({ color: 0xb03a3a }));
    box.position.y = 0.7;
    g.add(box);
    const chute = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0xd8d8de, side: THREE.DoubleSide })
    );
    chute.position.y = 4;
    g.add(chute);
    const smoke = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 1.6, 60, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xd84040, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false })
    );
    smoke.position.y = 30;
    g.add(smoke);
    return { group: g, chute, smoke, landed: false, opened: false };
  }

  _myTeam() {
    const info = this.names[this.self.id];
    return info ? info.t : -1;
  }

  _distToSelf(x, z) { return Math.hypot(x - this.self.pos.x, z - this.self.pos.z); }

  // ---------- 事件处理 ----------
  _onShot(m) {
    const own = m.id === this.self.id;
    if (!own) {
      // 远处枪声：按距离衰减
      const d = Math.hypot(m.o[0] - this.self.pos.x, m.o[2] - this.self.pos.z);
      if (d < 400) this.sfx.shot('ar', clamp(1 - d / 400, 0.05, 0.6));
      this._tracer(m.o, m.p, 0xffe0a0);
      const ent = this.ents.get(m.id);
      if (ent) this._muzzle(ent);
    }
  }

  _onKill(m) {
    const feed = $('killfeed');
    const p = document.createElement('p');
    // 击杀类型：枪械/拳头/载具/爆炸/毒圈/溺水等
    const VEH = { sedan: '🚗 载具', buggy: '🚗 载具', pickup: '🚗 载具' };
    const TYPES = { 毒圈: '☠️ 毒圈', 溺水: '🌊 溺水', 爆炸: '💥 爆炸', 拳头: '👊 拳头', 断线: '🚪 退出' };
    const label = VEH[m.w] || TYPES[m.w] || ('🔫 ' + m.w);
    p.innerHTML = `<b class="k">${esc(m.k)}</b> ${label}${m.hs ? '·爆头' : ''} <b class="v">${esc(m.v)}</b>`;
    feed.prepend(p);
    while (feed.children.length > 6) feed.lastChild.remove();
    setTimeout(() => p.remove(), 6500);
    if (m.kid === this.self.id) {
      this.kills++;
      this.sfx.kill();
      toast(`淘汰 ${m.v}！ (${label})`);
    }
    // 实体消亡动画：直接移除
    const ent = this.ents.get(m.vid);
    if (ent) { this.scene.remove(ent.group); this.ents.delete(m.vid); }
  }

  _onDead(m) {
    if (this.dead) return;
    this.dead = true;
    this.firing = false;
    $('death-rank').textContent = '#' + m.rank;
    $('death-total').textContent = this.lastSnap ? this.lastSnap.ac + 1 : '';
    $('death-by').textContent = m.by || '—';
    $('death-screen').classList.remove('hidden');
    $('pause-menu').classList.add('hidden');
    this.sfx.wind(false, 0);
    this.sfx.engine(false, 0);
  }

  _startSpectate() {
    $('death-screen').classList.add('hidden');
    this.spectateId = this._pickSpectateTarget();
    if (!this.spectateId) { this.onExit(); return; }
    $('spectate-bar').classList.remove('hidden');
    this._updateSpectateName();
  }

  _pickSpectateTarget() {
    const myTeam = this._myTeam();
    const alive = [];
    for (const [id, ent] of this.ents) {
      if (ent.st !== 'd' && ent.hp > 0) {
        alive.push({ id, team: (this.names[id] || {}).t, d: ent.group.position.distanceTo(this.self.pos) });
      }
    }
    const mates = alive.filter(a => a.team === myTeam);
    return (mates[0] || alive[0] || {}).id || null;
  }

  _cycleSpectate() {
    const ids = [...this.ents.keys()].filter(id => this.ents.get(id).hp > 0);
    if (!ids.length) return;
    const i = ids.indexOf(this.spectateId);
    this.spectateId = ids[(i + 1) % ids.length];
    this._updateSpectateName();
  }

  _updateSpectateName() {
    const info = this.names[this.spectateId] || {};
    $('spectate-name').textContent = info.n || '...';
  }

  _onEnd(m) {
    if (this.over) return;
    this.over = true;
    this.firing = false;
    this.sfx.wind(false, 0);
    this.sfx.engine(false, 0);
    $('death-screen').classList.add('hidden');
    $('spectate-bar').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    $('end-title').textContent = m.rank === 1 ? '🍗 大吉大利，今晚吃鸡！' : '对局结束';
    $('end-rank').textContent = '#' + m.rank;
    $('end-kills').textContent = m.kills;
    $('end-dmg').textContent = m.dmg;
    $('end-coins').textContent = '+' + m.coins;
    $('end-winners').textContent = m.winners && m.winners.length ? '获胜队伍：' + m.winners.join('、') : '';
    $('end-screen').classList.remove('hidden');
    if (m.rank === 1) this.sfx.kill();
  }

  onChat(m) {
    const log = $('chatlog-battle');
    const p = document.createElement('p');
    const who = m.ch === 'team' ? '[队] ' : '';
    p.innerHTML = `<b>${who}${esc(m.from)}</b>: ${esc(m.text)}`;
    log.appendChild(p);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  _showCast(m) {
    const bar = $('cast-bar');
    bar.classList.remove('hidden');
    $('cast-text').textContent = m.item === 'medkit' ? '使用医疗箱…' : '包扎中…';
    const start = performance.now();
    const tick = () => {
      if (this.disposed || this.dead || this.over) { bar.classList.add('hidden'); return; }
      const k = clamp((performance.now() - start) / m.ms, 0, 1);
      $('cast-fill').style.width = (k * 100) + '%';
      if (k >= 1) { bar.classList.add('hidden'); this.sfx.blip(700, 0.2, 0.2, 'sine'); }
      else requestAnimationFrame(tick);
    };
    tick();
  }

  _onBoom(m) {
    const g = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 })
    );
    g.position.set(m.x, m.y + 1, m.z);
    this.scene.add(g);
    this.boomsFx.push({ mesh: g, t0: performance.now() });
    const d = this._distToSelf(m.x, m.z);
    if (d < 300) {
      this.sfx.boom(clamp(1 - d / 300, 0.1, 1));
      this._shake += clamp(1 - d / 100, 0, 1) * 0.6;
    }
  }

  _onAirdrop(m) {
    toast('📦 空投已投放，注意信号区');
  }

  _dmgFlash() {
    const v = $('dmg-vignette');
    v.style.opacity = 1;
    clearTimeout(this._vT);
    this._vT = setTimeout(() => { v.style.opacity = 0; }, 350);
    this._shake = Math.max(this._shake || 0, 0.25);
  }

  _floatDmg(d, entId) {
    const ent = this.ents.get(entId);
    if (!ent) return;
    const v = ent.group.position.clone();
    v.y += 2;
    v.project(this.camera);
    if (v.z > 1) return;
    const el = document.createElement('div');
    el.textContent = Math.round(d);
    el.style.cssText = `position:absolute;left:${(v.x + 1) / 2 * innerWidth}px;top:${(-v.y + 1) / 2 * innerHeight - 20}px;color:#ffd54a;font-weight:900;font-size:18px;text-shadow:0 1px 3px #000;pointer-events:none;transition:transform .8s ease-out,opacity .8s;z-index:14`;
    $('page-battle').appendChild(el);
    requestAnimationFrame(() => { el.style.transform = 'translateY(-46px)'; el.style.opacity = '0'; });
    setTimeout(() => el.remove(), 850);
  }

  // ---------- 拾取物渲染 ----------
  _refreshLootMeshes() {
    const m4 = new THREE.Matrix4();
    const buckets = { weapon: [], ammo: [], med: [], armor: [] };
    for (const it of this.loot.values()) if (buckets[it.kind]) buckets[it.kind].push(it);
    for (const [kind, items] of Object.entries(buckets)) {
      const mesh = this._lootMeshes[kind];
      mesh.count = Math.min(items.length, mesh.instanceMatrix.count);
      for (let i = 0; i < mesh.count; i++) {
        const it = items[i];
        const y = this.terrain.height(it.x, it.z);
        m4.makeRotationY(i * 1.3);
        m4.setPosition(it.x, Math.max(y, 0.05) + 0.25, it.z);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    // 光柱（武器/医疗）
    for (const kind of ['weapon', 'med']) {
      const beam = this._lootBeams[kind];
      const items = buckets[kind];
      beam.count = Math.min(items.length, beam.instanceMatrix.count);
      for (let i = 0; i < beam.count; i++) {
        const it = items[i];
        const y = this.terrain.height(it.x, it.z);
        m4.identity();
        m4.setPosition(it.x, Math.max(y, 0.05) + 4, it.z);
        beam.setMatrixAt(i, m4);
      }
      beam.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- 交互 ----------
  _nearestInteract() {
    if (this.self.st === 'v') {
      return { kind: 'exit', label: '下车（E）' };
    }
    if (this.self.st !== 'g') return null;
    const p = this.self.pos;
    let best = null, bestD = 3.2;
    for (const it of this.loot.values()) {
      if (it.kind !== 'weapon') continue;
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < bestD) { bestD = d; best = { kind: 'pickup', id: it.id, label: `拾取 ${this._wdef(it.wid).name}（E）` }; }
    }
    for (const [id, c] of this.crates) {
      if (!c.landed || c.opened) continue;
      const d = Math.hypot(c.group.position.x - p.x, c.group.position.z - p.z);
      if (d < Math.min(bestD, 4.5)) { bestD = d; best = { kind: 'open', id, label: '打开空投箱（E）' }; }
    }
    for (const [id, vm] of this.vehMeshes) {
      if (vm.hp <= 0) continue;
      const d = Math.hypot(vm.group.position.x - p.x, vm.group.position.z - p.z);
      if (d < Math.min(bestD, 5.5)) { bestD = d; best = { kind: 'enter', id, label: '上车（E）' }; }
    }
    return best;
  }

  _interact() {
    if (this.dead || this.over) return;
    const n = this._nearestInteract();
    if (n) {
      // 下车：客户端同步镜像服务端的下车点，避免位置跳变
      if (n.kind === 'exit' && this.self.vehId) {
        const vm = this.vehMeshes.get(this.self.vehId);
        if (vm) {
          const vy = vm.group.rotation.y;
          this.self.pos.x = vm.group.position.x + Math.cos(vy) * 2.2;
          this.self.pos.z = vm.group.position.z - Math.sin(vy) * 2.2;
          this.self.pos.y = Math.max(this.terrain.height(this.self.pos.x, this.self.pos.z), -0.6);
          this.self.st = 'g';
        }
      }
      this.socket.emit('act', { kind: n.kind, id: n.id });
      this.sfx.pickup();
      return;
    }
    // 无提示目标时的兜底：9 米内有车就直接尝试上车（服务器会校验）
    if (this.self.st === 'g') {
      let near = null, nd = 9;
      for (const [id, vm] of this.vehMeshes) {
        if (vm.hp <= 0) continue;
        const d = Math.hypot(vm.group.position.x - this.self.pos.x, vm.group.position.z - this.self.pos.z);
        if (d < nd) { nd = d; near = id; }
      }
      if (near) {
        this.socket.emit('act', { kind: 'enter', id: near });
        toast(`尝试上车（距离 ${nd.toFixed(1)}m）…`);
        return;
      }
      toast('附近没有可交互的目标 · 枪械/车会有光柱和图标');
    }
  }

  // ---------- 射击 ----------
  _forward() {
    const { yaw, pitch } = this.self;
    return new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
  }

  _eyePos() {
    const p = this.self.pos;
    return new THREE.Vector3(p.x, p.y + (this.self.cr ? 1.15 : 1.62), p.z);
  }

  _wdef(wid) {
    return this.cfg.weapons.find(w => w.id === wid) || { id: wid, name: wid, dmg: 20, rate: 500, mag: 30, range: 200, type: 'ar', reload: 2000, spread: 0.02 };
  }

  _curWeapon() {
    const slot = this.inv.w[this.inv.cur || 0];
    return slot ? this._wdef(slot.wid) : this._wdef('fists');
  }

  _tryFire(now) {
    if (this.dead || this.over || this._chatOpen) return;
    if (this.self.st === 'p' || this.self.st === 'v') return;
    if (now < this.nextShotAt) return;
    const w = this._curWeapon();
    const slot = this.inv.w[this.inv.cur || 0];
    if (w.type === 'melee') {
      this.nextShotAt = now + w.rate;
      this.socket.emit('shoot', { d: this._forward().toArray() });
      this.sfx.blip(180, 0.08, 0.25, 'triangle');
      this.punchT = 1; // 挥拳动画
      const eye = this._eyePos();
      const end = eye.clone().add(this._forward().multiplyScalar(2.2));
      this._tracer([eye.x, eye.y, eye.z], [end.x, end.y, end.z], 0xffffff);
      return;
    }
    if (slot && slot.mag <= 0 && !this.gmFlags.infammo) {
      this.sfx.blip(900, 0.04, 0.12);
      this.socket.emit('reload');
      this.nextShotAt = now + 300;
      return;
    }
    if (this.aimbot && this.isAdmin) this._aimbotSnap();
    this.nextShotAt = now + w.rate;
    if (slot && !this.gmFlags.infammo) slot.mag--;
    this._updateInvHud();
    const dir = this._forward();
    this.socket.emit('shoot', { d: dir.toArray() });
    this.sfx.shot(w.type, 1);
    // 后坐力
    const kick = w.type === 'sniper' ? 0.035 : w.type === 'shotgun' ? 0.03 : 0.011;
    this.self.pitch = clamp(this.self.pitch + kick * (0.7 + Math.random() * 0.6), -1.45, 1.45);
    this.self.yaw += (Math.random() - 0.5) * kick * 0.5;
    this._shake = Math.max(this._shake || 0, w.type === 'sniper' ? 0.3 : 0.08);
    // 视觉曳光（本地立即）
    const end = this._visualRay(this._eyePos(), dir, w.range);
    this._tracer(this._eyePos().toArray(), end.toArray(), 0xfff0b0);
    this._muzzleSelf();
  }

  _aimbotSnap() {
    const eye = this._eyePos();
    let best = null, bestScore = 1e9;
    for (const [id, ent] of this.ents) {
      if (ent.hp <= 0) continue;
      const info = this.names[id] || {};
      if (info.t === this._myTeam()) continue;
      const head = ent.group.position.clone();
      head.y += 1.5;
      const d = head.distanceTo(eye);
      if (d > 400) continue;
      const dir = head.clone().sub(eye).normalize();
      const fwd = this._forward();
      const dot = dir.dot(fwd);
      if (dot < 0.5) continue;
      if (d < bestScore) { bestScore = d; best = head; }
    }
    if (best) {
      const dir = best.sub(eye);
      this.self.yaw = Math.atan2(dir.x, dir.z);
      this.self.pitch = clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), -1.45, 1.45);
    }
  }

  _visualRay(o, dir, range) {
    // 本地近似弹道终点（视觉用）：实体球体 + 地形步进
    let bestT = range;
    for (const [id, ent] of this.ents) {
      if (ent.hp <= 0) continue;
      const c = ent.group.position.clone(); c.y += ent.cr ? 0.9 : 1.1;
      const t = this._raySphere(o, dir, c, 0.75);
      if (t != null && t < bestT) bestT = t;
    }
    for (let t = 2; t < bestT; t += 4) {
      const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
      if (y < this.terrain.height(x, z)) { bestT = t; break; }
    }
    return o.clone().add(dir.clone().multiplyScalar(bestT));
  }

  _raySphere(o, d, c, r) {
    const mx = o.x - c.x, my = o.y - c.y, mz = o.z - c.z;
    const b = mx * d.x + my * d.y + mz * d.z;
    const cc = mx * mx + my * my + mz * mz - r * r;
    if (cc > 0 && b > 0) return null;
    const disc = b * b - cc;
    if (disc < 0) return null;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = 0;
    return t;
  }

  _tracer(from, to, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from[0], from[1], from[2]),
      new THREE.Vector3(to[0], to[1], to[2]),
    ]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, t0: performance.now() });
    if (this.tracers.length > 40) { const old = this.tracers.shift(); this.scene.remove(old.line); old.line.geometry.dispose(); old.line.material.dispose(); }
  }

  _muzzle(ent) {
    // 他人枪口闪光：短暂放大枪
    const g = ent.gun;
    if (!g) return;
    g.scale.set(1.6, 1.6, 1.3);
    setTimeout(() => g.scale.set(1, 1, 1), 50);
  }

  _muzzleSelf() {
    if (this.vmFlash) {
      this.vmFlash.visible = true;
      clearTimeout(this._mfT);
      this._mfT = setTimeout(() => { if (this.vmFlash) this.vmFlash.visible = false; }, 45);
    }
  }

  // ---------- 主循环 ----------
  _loop() {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastT) / 1000, 0.1);
    this.lastT = now;

    // 帧率统计
    this._fpsCount = (this._fpsCount || 0) + 1;
    if (!this._fpsAt) this._fpsAt = now;
    else if (now - this._fpsAt >= 1000) {
      this._fps = Math.round(this._fpsCount * 1000 / (now - this._fpsAt));
      this._fpsCount = 0;
      this._fpsAt = now;
    }

    this._updateSelf(dt, now);
    this._updateSelfMesh(dt);
    this._updateEnts(dt, now);
    this._updateVehicles(dt);
    this._updateFx(now, dt);
    this._updateCamera(dt);
    this._updateHud(now, dt);

    this.renderer.render(this.scene, this.camera);
    if (this.esp) this._drawEsp();
    else if (this.espCanvas) this.espCanvas.getContext('2d').clearRect(0, 0, this.espCanvas.width, this.espCanvas.height);
  }

  _updateSelf(dt, now) {
    const s = this.self;
    if (this.over) return;
    const T = this.terrain;

    if (s.st === 'p') {
      // 飞机上：跳伞请求带重试（服务器开局有短暂缓冲期，可能首次被拒）
      if (this._jumpQueued) {
        if (!this._lastJumpTry || now - this._lastJumpTry > 500) {
          this._lastJumpTry = now;
          this.socket.emit('jump');
        }
        $('plane-tip').innerHTML = '正在跳伞…';
      }
      // 飞机上
      if (this.lastSnap && this.lastSnap.pl) {
        s.pos.set(this.lastSnap.pl[0], this.lastSnap.pl[1] - 2, this.lastSnap.pl[2]);
      }
      this.sfx.wind(false, 0);
      return;
    }
    this._jumpQueued = false;

    if (this.dead && !this.spectateId) return;

    // 输入向量
    let ix = 0, iz = 0;
    if (!this.dead) {
      if (this.keys.KeyW) iz += 1;
      if (this.keys.KeyS) iz -= 1;
      if (this.keys.KeyA) ix -= 1;
      if (this.keys.KeyD) ix += 1;
      if (this.joy.active) { ix = this.joy.x; iz = -this.joy.y; }
    }
    const il = Math.hypot(ix, iz);
    if (il > 1) { ix /= il; iz /= il; }
    s.moving = il > 0.1;

    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    // 右手坐标系：朝 +Z 看时玩家右侧是 -X，右侧向量 = (-cos, sin)
    const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw);

    if (s.st === 'f') {
      s.vy = Math.max(s.vy - 30 * dt, -55);
      s.pos.y += s.vy * dt;
      const sp = 9;
      s.pos.x += (fx * iz + rx * ix) * sp * dt;
      s.pos.z += (fz * iz + rz * ix) * sp * dt;
      const g = this._groundAt(s.pos.x, s.pos.z, s.pos.y);
      const landY = Math.max(g, -0.6); // 水面为最低落点
      if (s.pos.y - g < 125) { s.st = 'c'; this.sfx.chute(); }
      if (s.pos.y <= landY) { s.pos.y = landY; s.st = 'g'; s.vy = 0; this.sfx.wind(false, 0); }
      this.sfx.wind(true, -s.vy);
      return;
    }
    if (s.st === 'c') {
      s.vy = -7;
      s.pos.y += s.vy * dt;
      const sp = 12;
      s.pos.x += (fx * iz + rx * ix) * sp * dt;
      s.pos.z += (fz * iz + rz * ix) * sp * dt;
      const g = this._groundAt(s.pos.x, s.pos.z, s.pos.y);
      const landY = Math.max(g, -0.6);
      if (s.pos.y <= landY) { s.pos.y = landY; s.st = 'g'; s.vy = 0; this.sfx.wind(false, 0); }
      this.sfx.wind(true, 10);
      return;
    }
    if (s.st === 'v') {
      const vm = this.vehMeshes.get(s.vehId);
      if (vm) {
        s.pos.copy(vm.group.position);
        s.yaw = vm.group.rotation.y;
      }
      // 驾驶输入
      let th = 0, st = 0;
      if (!this.dead) {
        if (this.keys.KeyW) th += 1;
        if (this.keys.KeyS) th -= 1;
        if (this.keys.KeyA) st -= 1;
        if (this.keys.KeyD) st += 1;
        if (this.joy.active) { th = -this.joy.y; st = this.joy.x; }
      }
      this._vehInput = { th, st };
      this.sfx.engine(true, vm ? (vm._speed || 0) : 0);
      // 载具状态必须持续上报（油门/转向），不能提前 return
      if (now - this.lastSendAt >= 50) {
        this.lastSendAt = now;
        this.socket.emit('s', {
          x: +s.pos.x.toFixed(2), y: +s.pos.y.toFixed(2), z: +s.pos.z.toFixed(2),
          yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3),
          st: 'v', cr: false, mv: false,
          veh: this._vehInput,
        });
      }
      if (this.firing) this._tryFire(now);
      return;
    }
    this.sfx.engine(false, 0);

    // 地面
    const g = this._groundAt(s.pos.x, s.pos.z, s.pos.y);
    const sprint = this.keys.ShiftLeft || this.keys.ShiftRight;
    const speed = s.cr ? 2.8 : sprint ? 8.8 : 5.6;
    const water = g < 0.1 && s.pos.y < 0.3;
    const sp2 = water ? speed * 0.45 : speed;
    let nx = s.pos.x + (fx * iz + rx * ix) * sp2 * dt;
    let nz = s.pos.z + (fz * iz + rz * ix) * sp2 * dt;

    // 建筑碰撞
    const pushed = this._collideBuildings(nx, nz, 0.45, s.pos.y);
    nx = pushed.x; nz = pushed.z;
    // 树木/石头障碍（与服务端同一份判定）
    const obs = this.terrain.pushOutObstacle(nx, nz, 0.45);
    nx = obs.x; nz = obs.z;
    nx = clamp(nx, -this.half * 0.99, this.half * 0.99);
    nz = clamp(nz, -this.half * 0.99, this.half * 0.99);
    s.pos.x = nx; s.pos.z = nz;

    const g2 = this._groundAt(nx, nz, s.pos.y);
    // 跳跃/重力
    if (this.keys.Space && s.pos.y <= g2 + 0.05 && g2 > 0 && !this.dead) {
      s.vy = 6.8;
      s.pos.y = g2 + 0.05;
    }
    if (s.pos.y > g2 + 0.02 || s.vy > 0) {
      s.vy -= 22 * dt;
      s.pos.y += s.vy * dt;
      if (s.pos.y < g2) { s.pos.y = g2; s.vy = 0; }
    } else {
      s.pos.y = Math.max(g2, -0.6); // 游泳不下沉太深
      s.vy = 0;
    }

    // 连发
    if (this.firing) this._tryFire(now);

    // 状态上报 20Hz
    if (now - this.lastSendAt >= 50) {
      this.lastSendAt = now;
      this.socket.emit('s', {
        x: +s.pos.x.toFixed(2), y: +s.pos.y.toFixed(2), z: +s.pos.z.toFixed(2),
        yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3),
        st: s.st, cr: s.cr, mv: s.moving,
        veh: this.self.st === 'v' ? this._vehInput : undefined,
      });
    }
  }

  _updateSelfMesh(dt) {
    const s = this.self, m = this.ownMesh;
    if (!m) return;
    const show = !this.fp && s.st !== 'p' && !this.dead && !this.over;
    m.group.visible = show;
    if (show) {
      // 武器换装（与实体一致）
      const wid = (this.inv.w[this.inv.cur || 0] || {}).wid || 'fists';
      if (wid !== this._lastOwnWid) {
        this._lastOwnWid = wid;
        const wd = this._wdef(wid);
        const armed = wd && wd.type !== 'melee';
        m.gun.visible = armed;
        if (armed) m.gun.material.color.setHex(wd.color != null ? wd.color : 0x22262e);
      }
    }
    if (!show) return;
    m.group.position.copy(s.pos);
    m.group.rotation.y = s.yaw;
    if (s.st === 'g') {
      const armed = this._curWeapon().type !== 'melee';
      if (s.moving) {
        const sw = Math.sin(this.animPhase) * 0.65;
        m.legL.rotation.x = sw;
        m.legR.rotation.x = -sw;
        if (armed) { m.armL.rotation.x = -1.05; m.armR.rotation.x = -1.3; }
        else { m.armL.rotation.x = -sw * 0.7; m.armR.rotation.x = sw * 0.4; }
      } else {
        m.legL.rotation.x = m.legR.rotation.x = 0;
        if (armed) { m.armL.rotation.x = -1.05; m.armR.rotation.x = -1.3; }
        else { m.armL.rotation.x = m.armR.rotation.x = 0; }
      }
      m.group.scale.y = lerp(m.group.scale.y, s.cr ? 0.72 : 1, Math.min(1, dt * 10));
    } else {
      m.legL.rotation.x = 0.5; m.legR.rotation.x = -0.3;
      m.armL.rotation.x = -2.6; m.armR.rotation.x = -2.8;
      m.group.scale.y = 1;
    }
    m.chute.visible = s.st === 'c';
  }

  // 地面高度：室内用地板/屋顶，否则地形（refY 用于区分站在屋顶还是室内）
  _groundAt(x, z, refY) {
    let g = this.terrain.height(x, z);
    for (const b of this.terrain.buildings()) {
      if (Math.abs(x - b.x) < b.w / 2 - 0.3 && Math.abs(z - b.z) < b.d / 2 - 0.3) {
        return refY != null && refY > b.y + b.h - 0.6 ? b.y + b.h + 0.5 : Math.max(g, b.y);
      }
    }
    return g;
  }

  _collideBuildings(x, z, r, refY) {
    // 墙体碰撞（有门洞，可进屋）；站在屋顶（高于墙顶）时不被挡，可走下房檐
    for (const w of this.terrain.buildingWalls()) {
      if (refY != null && refY > w.y + w.h - 0.35) continue; // 在墙顶之上（屋顶）
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

  _updateEnts(dt, now) {
    this.animPhase += dt * 8;
    for (const [id, ent] of this.ents) {
      if (!ent.target) continue;
      const t = ent.target;
      ent.group.position.lerp(new THREE.Vector3(t.x, t.y, t.z), Math.min(1, dt * 12));
      let dy = t.yaw - ent.group.rotation.y;
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      ent.group.rotation.y += dy * Math.min(1, dt * 12);

      const dist = ent.group.position.distanceTo(this.self.pos);
      ent.group.visible = dist < 420;
      if (ent.nameTag) ent.nameTag.visible = dist < 120;

      // 武器换装：按枪种染色，空手收枪
      if (ent.wid !== ent.lastWid) {
        ent.lastWid = ent.wid;
        const wd = this._wdef(ent.wid);
        const armed = wd && wd.type !== 'melee';
        if (ent.gun) {
          ent.gun.visible = armed;
          if (armed) ent.gun.material.color.setHex(wd.color != null ? wd.color : 0x22262e);
        }
      }

      // 动画（持枪时手臂端枪，空手摆臂）
      const armed = ent.wid && ent.wid !== 'fists';
      if (ent.st === 'g' || ent.st === 'v') {
        const sw = ent.st === 'g' ? Math.sin(this.animPhase) * 0.65 : 0;
        ent.legL.rotation.x = sw;
        ent.legR.rotation.x = -sw;
        if (armed) {
          ent.armL.rotation.x = -1.05;
          ent.armR.rotation.x = -1.3;
        } else {
          ent.armL.rotation.x = -sw * 0.7;
          ent.armR.rotation.x = sw * 0.4;
        }
        ent.group.scale.y = lerp(ent.group.scale.y, ent.cr ? 0.72 : 1, dt * 10);
      } else {
        ent.legL.rotation.x = 0.5; ent.legR.rotation.x = -0.3;
        ent.armL.rotation.x = -2.6; ent.armR.rotation.x = -2.8;
        ent.group.scale.y = 1;
      }
      ent.chute.visible = ent.st === 'c';
      ent.group.visible = ent.group.visible && ent.st !== 'p';
    }
    // 空投烟柱缓慢旋转
    for (const c of this.crates.values()) {
      if (c.smoke.visible) c.smoke.rotation.y += dt * 0.8;
    }
  }

  _updateVehicles(dt) {
    for (const vm of this.vehMeshes.values()) {
      if (!vm.target) continue;
      vm.group.position.lerp(new THREE.Vector3(vm.target.x, vm.target.y, vm.target.z), Math.min(1, dt * 10));
      let dy = vm.target.yaw - vm.group.rotation.y;
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      vm.group.rotation.y += dy * Math.min(1, dt * 10);
      vm._speed = vm._speed === undefined ? 0 : vm._speed;
      // 估算车速（用于音效）
      if (this._lastVehPos && this._lastVehPos.id) { /* 简化 */ }
      vm._speed = lerp(vm._speed || 0, Math.hypot(vm.target.x - (vm._lx || vm.target.x), vm.target.z - (vm._lz || vm.target.z)) / Math.max(dt, 0.01), 0.2);
      vm._lx = vm.target.x; vm._lz = vm.target.z;
    }
  }

  _updateFx(now, dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      const age = (now - tr.t0) / 120;
      tr.line.material.opacity = 0.9 * (1 - age);
      if (age >= 1) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose(); tr.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.boomsFx.length - 1; i >= 0; i--) {
      const b = this.boomsFx[i];
      const age = (now - b.t0) / 500;
      if (age >= 1) {
        this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose();
        this.boomsFx.splice(i, 1);
      } else {
        b.mesh.scale.setScalar(1 + age * 9);
        b.mesh.material.opacity = 0.9 * (1 - age);
      }
    }
    this.water.position.y = Math.sin(now / 1600) * 0.06;
    this.water.position.x = Math.sin(now / 9000) * 3;
    this.water.material.opacity = 0.84 + Math.sin(now / 2200) * 0.03;
    if (this.clouds) this.clouds.rotation.y += dt * 0.004;
  }

  _updateCamera(dt) {
    const s = this.self;
    // 开镜 FOV 缩放
    const w = this._curWeapon();
    const adsFov = w.type === 'sniper' ? 22 : w.type === 'dmr' ? 34 : w.type === 'ar' ? 40 : 48;
    const targetFov = this.ads && s.st !== 'p' ? adsFov : (this.isTouch ? 78 : 72);
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov = lerp(this.camera.fov, targetFov, Math.min(1, dt * 12));
      this.camera.updateProjectionMatrix();
    }
    let shake = this._shake || 0;
    this._shake = Math.max(0, shake - dt * 2);
    const sh = shake * 0.05;
    const shakeVec = new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0);

    // 观战
    if (this.spectateId && this.dead) {
      const ent = this.ents.get(this.spectateId);
      if (ent) {
        const p = ent.group.position;
        const back = new THREE.Vector3(Math.sin(p.y || 0), 0, 0); // 占位
        const camPos = new THREE.Vector3(p.x, p.y + 3.2, p.z - 5.5);
        camPos.y = Math.max(camPos.y, this.terrain.height(camPos.x, camPos.z) + 0.4);
        this.camera.position.copy(camPos);
        this.camera.lookAt(p.x, p.y + 1.2, p.z);
        return;
      }
    }

    const eye = this._eyePos();
    const fwd = this._forward();

    if (s.st === 'p') {
      // 飞机上俯瞰
      this.camera.position.copy(eye).add(new THREE.Vector3(0, 1.5, 0));
      this.camera.lookAt(eye.clone().add(fwd).add(new THREE.Vector3(0, -0.8, 0)));
      return;
    }

    if (this.fp && s.st !== 'f' && s.st !== 'c') {
      this.camera.position.copy(eye).add(shakeVec);
      this.camera.lookAt(eye.clone().add(fwd));
      this._updateViewModel(dt);
    } else {
      // 第三人称 / 跳伞视角
      const dist = (s.st === 'f' || s.st === 'c') ? 6.5 : 3.6;
      const height = (s.st === 'f' || s.st === 'c') ? 1.2 : 1.7;
      const boom = fwd.clone().multiplyScalar(-dist);
      boom.y += height;
      const camPos = eye.clone().add(boom).add(shakeVec);
      const minY = this.terrain.height(camPos.x, camPos.z) + 0.35;
      if (camPos.y < minY) camPos.y = minY;
      this.camera.position.copy(camPos);
      this.camera.lookAt(eye.clone().add(fwd.clone().multiplyScalar(8)));
      if (this.vmGroup) this.vmGroup.visible = false;
    }
  }

  _updateViewModel(dt) {
    // 第一人称视角模型：完整枪模 + 双手；空手时显示拳头
    if (!this.vmGroup) {
      const g = new THREE.Group();
      // 枪组件
      const gunParts = new THREE.Group();
      const gm = new THREE.MeshLambertMaterial({ color: 0x2a2f38 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.15, 0.6), gm);
      body.position.set(0, 0, -0.2);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.55), new THREE.MeshLambertMaterial({ color: 0x1c2028 }));
      barrel.position.set(0, 0.035, -0.7);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.1), gm);
      mag.position.set(0, -0.15, -0.12);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.26), new THREE.MeshLambertMaterial({ color: 0x4a3826 }));
      stock.position.set(0, -0.03, 0.24);
      gunParts.add(body, barrel, mag, stock);
      g.add(gunParts);
      // 双手（持枪姿势）
      const hm = new THREE.MeshLambertMaterial({ color: 0xd8b48f });
      const handL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.22), hm);
      handL.position.set(-0.04, -0.11, -0.42);
      const handR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.22), hm);
      handR.position.set(0.03, -0.13, -0.08);
      g.add(handL, handR);
      // 空手双拳
      const fists = new THREE.Group();
      const fistL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.16), hm);
      fistL.position.set(-0.14, -0.16, -0.4);
      const fistR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.16), hm);
      fistR.position.set(0.14, -0.18, -0.34);
      fists.add(fistL, fistR);
      g.add(fists);
      // 枪口火光
      const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.95 })
      );
      flash.position.set(0, 0.03, -1.0);
      flash.visible = false;
      g.add(flash);
      this.camera.add(g);
      this.scene.add(this.camera);
      this.vmGroup = g;
      this.vmGunParts = gunParts;
      this.vmFists = fists;
      this.vmHandL = handL;
      this.vmHandR = handR;
      this.vmFlash = flash;
    }
    const w = this._curWeapon();
    const armed = w.type !== 'melee';
    this.vmGroup.visible = this.fp && this.self.st === 'g';
    this.vmGunParts.visible = armed;
    this.vmFists.visible = this.fp && !armed;
    this.vmHandL.visible = this.vmHandR.visible = this.fp && armed;
    if (armed) {
      const len = w.type === 'sniper' ? 1.35 : w.type === 'dmr' ? 1.15 : w.type === 'pistol' ? 0.55 : w.type === 'shotgun' ? 1.1 : 0.9;
      this.vmGunParts.scale.set(1, 1, len);
      const c = w.color != null ? w.color : 0x2a2f38;
      this.vmGunParts.children[0].material.color.setHex(c);
    }
    // 开镜时枪口居中；平时右下
    const tx = this.ads ? 0.0 : 0.26;
    const ty = this.ads ? -0.16 : -0.22;
    this.vmGroup.position.x = lerp(this.vmGroup.position.x, tx, Math.min(1, dt * 14));
    this.vmGroup.position.y = lerp(this.vmGroup.position.y, ty, Math.min(1, dt * 14));
    this.vmGroup.position.z = -0.45;
    // 挥拳动画（拳头前刺 / 枪身后座）
    if (this.punchT > 0) {
      this.punchT = Math.max(0, this.punchT - dt * 5);
      const k = Math.sin(this.punchT * Math.PI);
      if (armed) this.vmGroup.position.z = -0.45 + k * 0.12; // 后座
      else this.vmGroup.position.z = -0.45 - k * 0.3; // 出拳
    } else {
      this.vmGroup.position.z = -0.45;
    }
  }

  // ---------- HUD 刷新 ----------
  _updateHud(now, dt) {
    const s = this.self;
    // 血条
    $('hp-fill').style.width = clamp(s.hp, 0, 100) + '%';
    $('hp-fill').style.background = s.hp > 60 ? 'var(--ok)' : s.hp > 30 ? '#e0b040' : 'var(--danger)';
    $('hp-num').textContent = Math.max(0, Math.round(s.hp));

    // 毒圈提示
    if (this.zone) {
      const [cx, cz, r, , , , phase, st, t] = this.zone;
      const outside = Math.hypot(s.pos.x - cx, s.pos.z - cz) > r;
      $('zone-vignette').style.opacity = outside && !this.dead ? 0.85 : 0;
      const zt = $('zone-timer');
      const ph = phase + 1;
      if (st === 'wait') { zt.textContent = `信号圈 ${ph} · ${t}s 后收缩`; zt.className = t < 10 ? 'warn' : ''; }
      else if (st === 'shrink') { zt.textContent = `⚠ 毒圈收缩中 ${t}s`; zt.className = 'warn'; }
      else { zt.textContent = `信号圈 ${ph}`; zt.className = ''; }
      // 毒圈墙
      this.zoneWall.position.x = cx; this.zoneWall.position.z = cz;
      this.zoneWall.scale.set(r, 1, r);
      this.zoneWall.material.opacity = outside ? 0.3 : 0.15;
    }

    // 弹药
    const w = this._curWeapon();
    const slot = this.inv.w[this.inv.cur || 0];
    $('weapon-name').textContent = w.type === 'melee'
      ? '拳头 · 左键出拳'
      : w.name + (this.inv.vest ? ` · 护甲${this.inv.vest}` : '') + (this.ads ? ' · 瞄准中' : '');
    if (w.type === 'melee') {
      $('ammo-mag').textContent = '—';
      $('ammo-pool').textContent = '';
    } else {
      $('ammo-mag').textContent = slot ? slot.mag : 0;
      const pool = (this.inv.am || {})[w.ammo] || 0;
      $('ammo-pool').textContent = '/ ' + (this.gmFlags.infammo ? '∞' : pool);
    }

    // 槽位
    document.querySelectorAll('#slots .slot').forEach(el => {
      const idx = parseInt(el.dataset.slot);
      el.classList.toggle('active', idx === (this.inv.cur || 0));
      const s2 = this.inv.w[idx];
      el.querySelector('.slot-name').textContent = s2 ? this._wdef(s2.wid).name : '空';
    });
    $('cnt-bandage').textContent = (this.inv.md || {}).bandage || 0;
    $('cnt-medkit').textContent = (this.inv.md || {}).medkit || 0;
    // 可用药时按钮呼吸提示
    document.querySelectorAll('#meds-row .med-btn').forEach(btn => {
      const cnt = (this.inv.md || {})[btn.dataset.item] || 0;
      const usable = cnt > 0 && s.hp < 100 && !this.dead;
      btn.disabled = cnt <= 0;
      btn.classList.toggle('usable', usable);
    });

    // 跳伞提示
    $('plane-tip').classList.toggle('hidden', s.st !== 'p');
    if (s.st === 'p' && !this._jumpQueued) $('plane-tip').innerHTML = '按 <b>空格</b> 跳伞';

    // 准星开镜收缩
    const ch = $('crosshair');
    if (ch) ch.style.transform = `translate(-50%,-50%) scale(${this.ads ? 0.45 : 1})`;

    // 交互提示（触屏 ✋ 键同步高亮）
    const n = this._nearestInteract();
    const tip = $('interact-tip');
    const canAct = !!(n && !this.dead);
    if (canAct) { tip.textContent = n.label; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');
    const tbInt = $('tb-interact');
    if (tbInt) tbInt.classList.toggle('usable', canAct);

    // 小地图
    if (now - this.lastMapDraw > 250) {
      this.lastMapDraw = now;
      this._drawMap($('minimap'), 180, false);
      if (!$('bigmap').classList.contains('hidden')) this._drawMap($('bigmap-canvas'), 640, true);
      this._showScoreboardLive();
    }

    // 网络延迟 + 帧率（右上角，每 500ms 刷新一次文字）
    if (now - (this._netHudAt || 0) > 500) {
      this._netHudAt = now;
      const el = $('net-hud');
      if (el) {
        const p = this._ping;
        const f = this._fps;
        const pCls = p == null ? '' : p < 80 ? 'good' : p < 150 ? 'mid' : 'bad';
        const fCls = f == null ? '' : f >= 50 ? 'good' : f >= 30 ? 'mid' : 'bad';
        el.innerHTML =
          `延迟 <b class="${pCls}">${p == null ? '--' : p}</b>ms` +
          ` · <b class="${fCls}">${f == null ? '--' : f}</b>FPS`;
      }
    }
  }

  _updateInvHud() {
    // 自己的装备外观（护甲/头盔）
    if (this.ownMesh) {
      this.ownMesh.vest.visible = !!this.inv.vest;
      this.ownMesh.helmet.visible = !!this.inv.helmet;
      const lv = this.inv.helmet || 0;
      this.ownMesh.helmet.material.color.setHex(lv >= 3 ? 0x8a6a2a : lv === 2 ? 0x3a6a4a : 0x4a4a52);
      this.ownMesh.vest.material.color.setHex((this.inv.vest || 0) >= 3 ? 0x6a5a2a : 0x39424e);
    }
  }

  _drawMap(canvas, size, full) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.mapBase, 0, 0, w, h);
    const toPx = (x, z) => [(x / this.battle.map.size + 0.5) * w, (z / this.battle.map.size + 0.5) * h];

    // 城镇名（大地图）
    if (full) {
      ctx.font = '13px "Microsoft YaHei"';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'center';
      for (const t of this.terrain.towns()) {
        const [px, py] = toPx(t.x, t.z);
        ctx.fillText(t.name, px, py);
      }
      // 装备标记（大地图）：枪=白点 医疗=红点 弹药=黄点
      const step = Math.max(1, Math.floor(this.loot.size / 260));
      let li = 0;
      for (const it of this.loot.values()) {
        if (li++ % step) continue;
        const [px, py] = toPx(it.x, it.z);
        ctx.fillStyle = it.kind === 'weapon' ? '#f0f6ff' : it.kind === 'med' ? '#ff7d7d' : '#ffd268';
        ctx.fillRect(px - 1.2, py - 1.2, 2.4, 2.4);
      }
      // 载具标记
      for (const vm of this.vehMeshes.values()) {
        if (vm.hp <= 0) continue;
        const [px, py] = toPx(vm.group.position.x, vm.group.position.z);
        ctx.fillStyle = '#6ab4ff';
        ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
        ctx.strokeStyle = '#1a3a5a';
        ctx.lineWidth = 1;
        ctx.strokeRect(px - 2.5, py - 2.5, 5, 5);
      }
      // 图例
      ctx.font = '12px "Microsoft YaHei"';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, 158, 66);
      ctx.fillStyle = '#f0f6ff'; ctx.fillText('▪ 武器', 16, 26);
      ctx.fillStyle = '#ff7d7d'; ctx.fillText('▪ 医疗', 16, 42);
      ctx.fillStyle = '#ffd268'; ctx.fillText('▪ 弹药', 76, 26);
      ctx.fillStyle = '#6ab4ff'; ctx.fillText('▪ 载具', 76, 42);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText('按 M 关闭地图', 16, 62);
    }

    // 毒圈
    if (this.zone) {
      const [cx, cz, r, nx, nz, nr] = this.zone;
      const [px, py] = toPx(cx, cz);
      const scale = w / this.battle.map.size;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, r * scale, 0, Math.PI * 2); ctx.stroke();
      if (nr < r) {
        ctx.strokeStyle = '#4aa3ff';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(toPx(nx, nz)[0], toPx(nx, nz)[1], nr * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 队友
    const myTeam = this._myTeam();
    for (const [id, ent] of this.ents) {
      const info = this.names[id] || {};
      if (info.t !== myTeam) continue;
      const [px, py] = toPx(ent.group.position.x, ent.group.position.z);
      ctx.fillStyle = '#7dff8a';
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
      if (full) { ctx.fillStyle = '#7dff8a'; ctx.font = '11px sans-serif'; ctx.fillText(info.n || '', px + 6, py + 3); }
    }

    // 空投
    for (const c of this.crates.values()) {
      const [px, py] = toPx(c.group.position.x, c.group.position.z);
      ctx.fillStyle = '#ff6a6a';
      ctx.fillRect(px - 3, py - 3, 6, 6);
    }

    // 自己（朝向箭头）
    const s = this.self;
    const [px, py] = toPx(s.pos.x, s.pos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(Math.sin(s.yaw), -Math.cos(s.yaw)));
    ctx.fillStyle = this.dead ? '#999' : '#ffd24a';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2); ctx.lineTo(-5, 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  _showScoreboard() { $('scoreboard').classList.remove('hidden'); this._showScoreboardLive(true); }
  _showScoreboardLive(force) {
    const sb = $('scoreboard');
    if (sb.classList.contains('hidden')) return;
    const alive = [];
    let myKills = this.kills;
    for (const [id, ent] of this.ents) {
      const info = this.names[id] || {};
      alive.push({ name: info.n || id, team: info.t, hp: ent.hp, mate: info.t === this._myTeam(), me: id === this.self.id });
    }
    alive.sort((a, b) => (b.mate - a.mate) || a.team - b.team);
    $('sb-body').innerHTML = `
      <table><tr><th>玩家</th><th>队伍</th><th>状态</th></tr>
      ${alive.map(a => `<tr class="${a.me ? 'bold' : ''}"><td>${esc(a.name)}${a.me ? '（你）' : ''}</td><td>${a.team + 1}</td><td>${a.hp > 0 ? '存活' : '—'}</td></tr>`).join('')}
      </table>
      <p class="muted" style="margin-top:8px">我的击杀：${myKills} · 存活：${this.lastSnap ? this.lastSnap.ac : '?'} 人</p>`;
  }

  _drawEsp() {
    const ctx = this.espCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.espCanvas.width, this.espCanvas.height);
    ctx.font = '12px "Microsoft YaHei"';
    ctx.textAlign = 'left';
    const myTeam = this._myTeam();
    const v = new THREE.Vector3();
    for (const [id, ent] of this.ents) {
      if (ent.hp <= 0) continue;
      const info = this.names[id] || {};
      const mate = info.t === myTeam;
      v.copy(ent.group.position); v.y += 1.2;
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      if (v.z > 1) continue;
      const x = (v.x + 1) / 2 * this.espCanvas.width;
      const y = (-v.y + 1) / 2 * this.espCanvas.height;
      ctx.strokeStyle = mate ? '#7dff8a' : '#ff5a5a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 14, y - 38, 28, 52);
      ctx.fillStyle = mate ? '#7dff8a' : '#ff5a5a';
      ctx.fillText(`${info.n || id} ${Math.round(dist)}m HP${ent.hp}`, x + 18, y - 10);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    for (const [ev, fn] of this._handlers || []) this.socket.off(ev, fn);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('contextmenu', this._onCtx);
    document.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    window.removeEventListener('resize', this._onResize);
    this.sfx.wind(false, 0);
    this.sfx.engine(false, 0);
    if (this.renderer) this.renderer.dispose();
    if (this.espCanvas) this.espCanvas.remove();
    // 清理 DOM 状态
    for (const id of ['hud', 'touch-ui', 'death-screen', 'end-screen', 'pause-menu', 'spectate-bar', 'battle-loading', 'bigmap', 'scoreboard', 'chat-input-row-battle', 'interact-tip', 'plane-tip', 'help-overlay', 'btn-help', 'net-hud']) {
      const el = $(id);
      if (el) el.classList.add('hidden');
    }
    $('killfeed').innerHTML = '';
    $('chatlog-battle').innerHTML = '';
    $('dmg-vignette').style.opacity = 0;
    $('zone-vignette').style.opacity = 0;
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 共享角色模型：商店预览与战斗内使用同一份代码，按整套外观（上衣/袖臂/裤腿/背包）染色
export function makeCharacterMesh(outfit, isNight) {
  const o = typeof outfit === 'string' ? { torso: outfit } : (outfit || {});
  const torsoC = o.torso || '#7a8a5a';
  const armsC = o.arms || torsoC;
  const legsC = o.legs || '#3f4450';
  const packC = o.pack || '#4a4336';
  const g = new THREE.Group();
  const torsoMat = new THREE.MeshLambertMaterial({ color: torsoC });
  const armsMat = new THREE.MeshLambertMaterial({ color: armsC });
  const legsMat = new THREE.MeshLambertMaterial({ color: legsC });
  const packMat = new THREE.MeshLambertMaterial({ color: packC });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xd8b48f });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.32), torsoMat);
  torso.position.y = 0.98;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), headMat);
  head.position.y = 1.5;
  g.add(head);

  const mask = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.03), new THREE.MeshLambertMaterial({ color: 0x1c222c }));
  mask.position.set(0, 1.52, 0.16);
  g.add(mask);
  const eyeMat = new THREE.MeshBasicMaterial({ color: isNight ? 0xc8e888 : 0x101418 });
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.012), eyeMat);
  eyeL.position.set(-0.06, 1.52, 0.177);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.06;
  g.add(eyeL, eyeR);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.07, 0.34), new THREE.MeshLambertMaterial({ color: 0x23282e }));
  belt.position.y = 0.71;
  g.add(belt);
  const bootMat = new THREE.MeshLambertMaterial({ color: 0x1f2328 });
  const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.28), bootMat);
  bootL.position.set(-0.15, 0.07, 0.03);
  const bootR = bootL.clone();
  bootR.position.x = 0.15;
  g.add(bootL, bootR);

  const mkLimb = (mat, x, y, len, thick) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), mat);
    m.position.y = -len / 2;
    pivot.add(m);
    g.add(pivot);
    return pivot;
  };
  const legL = mkLimb(legsMat, -0.15, 0.72, 0.72, 0.19);
  const legR = mkLimb(legsMat, 0.15, 0.72, 0.72, 0.19);
  const armL = mkLimb(armsMat, -0.37, 1.26, 0.56, 0.15);
  const armR = mkLimb(armsMat, 0.37, 1.26, 0.56, 0.15);

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.17, 1.05), new THREE.MeshLambertMaterial({ color: 0x22262e }));
  gun.position.set(0.2, 1.18, 0.55);
  gun.visible = false;
  g.add(gun);

  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.46, 0.4), new THREE.MeshLambertMaterial({ color: 0x39424e }));
  vest.position.y = 1.02;
  vest.visible = false;
  g.add(vest);
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.36), new THREE.MeshLambertMaterial({ color: 0x4a4a52 }));
  helmet.position.y = 1.68;
  helmet.visible = false;
  g.add(helmet);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.48, 0.2), packMat);
  pack.position.set(0, 1.0, -0.27);
  g.add(pack);

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.06;
  g.add(shadow);

  const chute = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xff8c2e, side: THREE.DoubleSide })
  );
  canopy.position.y = 3.4;
  chute.add(canopy);
  chute.visible = false;
  g.add(chute);

  return { group: g, legL, legR, armL, armR, gun, chute, torso, head, vest, helmet, pack, mats: { torso: torsoMat, arms: armsMat, legs: legsMat, pack: packMat } };
}
