// FIREZONE 真人 3D 模型系统：骨骼动画角色 / 真实枪械 / 载具 / 道具
// 素材均为开源免费授权（CC0 / CC-BY），详见 /public/assets/CREDITS.md
import * as THREE from '/vendor/three.module.js';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from '/vendor/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from '/vendor/addons/utils/BufferGeometryUtils.js';

// ---------- 素材清单（文件 / 目标尺寸 / 朝向修正） ----------
// len: 归一化后的长度(米)；yaw/xrot: 模型自身朝向修正；flip: 枪口在 -Z 时翻转
export const WEAPON_DEFS = {
  fists:  null,
  p92:    { file: 'weapons/pistol.glb',   len: 0.34, yaw: 0,      flip: false, gripK: 0.18 },
  vector: { file: 'weapons/smg.glb',      len: 0.60, yaw: 0,      flip: false, gripK: 0.22 },
  m4:     { file: 'weapons/ar_m4.glb',    len: 0.92, yaw: 0,      flip: false, gripK: 0.24 },
  ak:     { file: 'weapons/ak47.glb',     len: 0.92, yaw: 0,      flip: true , gripK: 0.24 },
  mini14: { file: 'weapons/sniper2.glb',  len: 1.02, yaw: 0,      flip: true , gripK: 0.26 },
  s686:   { file: 'weapons/shotgun.glb',  len: 0.98, yaw: 0,      flip: true , gripK: 0.22 },
  awm:    { file: 'weapons/sniper.glb',   len: 1.18, yaw: 0,      flip: false, gripK: 0.26 },
};

export const VEHICLE_DEFS = {
  buggy:  { file: 'vehicles/moto_jeremy.glb', len: 2.25, yawFix: 0,   flip: false },
  sedan:  { file: 'vehicles/sedan_quat.glb',  len: 4.55, yawFix: 0,   flip: false },
  pickup: { file: 'vehicles/pickup_quat.glb', len: 5.30, yawFix: 0,   flip: false },
};

const FILES = {
  soldier: 'models/soldier.glb',
  crate:   'models/crate.glb',
  plane:   'vehicles/plane.glb',
  ...Object.fromEntries(Object.entries(WEAPON_DEFS).filter(([, d]) => d).map(([k, d]) => ['w_' + k, d.file])),
  ...Object.fromEntries(Object.entries(VEHICLE_DEFS).map(([k, d]) => ['v_' + k, d.file])),
};

// ---------- 素材库（模块级单例，登录后即后台预载） ----------
class AssetLibrary {
  constructor() {
    this.status = 'idle';   // idle | loading | ready | partial
    this.gt = {};           // key -> gltf
    this._promise = null;
    this._loader = new GLTFLoader();
  }

  get ready() { return this.status === 'ready' || this.status === 'partial'; }
  get soldierReady() { return !!this.gt.soldier; }

  load(onProgress) {
    if (this._promise) return this._promise;
    const keys = Object.keys(FILES);
    let done = 0;
    const tick = (k) => { done++; onProgress && onProgress(done / keys.length, k); };
    this.status = 'loading';
    const jobs = keys.map((k) =>
      this._loader.loadAsync('/assets/' + FILES[k])
        .then((g) => { this.gt[k] = g; tick(k); })
        .catch((e) => { console.warn('[models] 素材加载失败', k, e); tick(k); })
    );
    this._promise = Promise.all(jobs).then(() => {
      this.status = this.gt.soldier ? 'ready' : 'partial';
      return this.ready;
    });
    return this._promise;
  }
}
export const Assets = new AssetLibrary();

// ---------- 通用几何工具 ----------
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

function boxOf(obj) {
  obj.updateWorldMatrix(true, true);
  _box.setFromObject(obj);
  return _box;
}

// 把加载的 gltf 场景包一层：最长轴转到 Z、归一化到 len 长、底部贴地
// 注意：克隆体的 matrixWorld 是拷贝来的旧值，测量前必须强制刷新整棵树
// noRotate: 不做长轴旋转（如飞机：机身沿 Z、机翼沿 X 是正常布局）
// scaleBy: 'max'(默认,按最大水平边) | 'z' | 'x'
function normalizeModel(src, { len, ground = true, flip = false, yawFix = 0, noRotate = false, scaleBy = 'max' }) {
  src.updateMatrixWorld(true);
  const outer = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(src);
  outer.add(inner);
  // 1) 长轴对齐 Z
  let b = new THREE.Box3().setFromObject(inner);
  let size = b.getSize(new THREE.Vector3());
  if (!noRotate) {
    if (size.y >= size.x && size.y >= size.z) inner.rotation.x = -Math.PI / 2;      // 竖着放躺平
    else if (size.x > size.z) inner.rotation.y = Math.PI / 2;                        // 横放转 90°
  }
  if (flip) inner.rotation.y += Math.PI;
  if (yawFix) inner.rotation.y += yawFix;
  // 2) 统一缩放
  b = new THREE.Box3().setFromObject(inner);
  size = b.getSize(new THREE.Vector3());
  const ref = scaleBy === 'z' ? size.z : scaleBy === 'x' ? size.x : Math.max(size.x, size.z);
  const s = len / Math.max(ref, 0.0001);
  inner.scale.setScalar(s);
  // 3) 居中 + 贴地
  b = new THREE.Box3().setFromObject(inner);
  const c = b.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, ground ? -b.min.y : -c.y, -c.z);
  return outer;
}

// ---------- 武器 ----------
const _weaponCache = new Map();

// 归一化的武器模型：枪管朝 +Z、握把(原点)在 gripK 位置、tip 为枪口标记
export function makeWeapon(wid) {
  const def = WEAPON_DEFS[wid];
  if (!def || !Assets.gt['w_' + wid]) return null;
  if (!_weaponCache.has(wid)) {
    const src = Assets.gt['w_' + wid].scene.clone(true);
    src.updateMatrixWorld(true); // 克隆体 matrixWorld 是旧值，强制刷新后再测量
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    inner.add(src);
    outer.add(inner);
    // 长轴 → Z
    let b = new THREE.Box3().setFromObject(inner);
    let size = b.getSize(new THREE.Vector3());
    if (size.y > size.x && size.y > size.z) inner.rotation.x = -Math.PI / 2;
    else if (size.x > size.z) inner.rotation.y = Math.PI / 2;
    if (def.flip) inner.rotation.y += Math.PI;
    // 归一化长度
    b = new THREE.Box3().setFromObject(inner);
    size = b.getSize(new THREE.Vector3());
    const s = def.len / Math.max(size.z, 0.0001);
    inner.scale.setScalar(s);
    // 原点移到握把位置
    b = new THREE.Box3().setFromObject(inner);
    const gripZ = b.min.z + (b.max.z - b.min.z) * (def.gripK || 0.25);
    const c = b.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -c.y, -gripZ);
    // 枪口标记：只存坐标数据（Object3D 放 userData 会在 clone 的 JSON 序列化中丢失）
    outer.userData.tipPos = [0, 0, b.max.z - gripZ];
    _weaponCache.set(wid, outer);
  }
  return _weaponCache.get(wid).clone(true);
}

// 掉落物用：把武器几何烘焙成单份顶点色几何（供 InstancedMesh）
const _lootGeoCache = new Map();
export function weaponLootGeometry(wid) {
  const def = WEAPON_DEFS[wid];
  if (!def || !Assets.gt['w_' + wid]) return null;
  if (_lootGeoCache.has(wid)) return _lootGeoCache.get(wid);
  const root = Assets.gt['w_' + wid].scene;
  const geos = [];
  const color = new THREE.Color();
  root.updateMatrixWorld(true); // 确保烘焙用的世界矩阵是新鲜的
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    // 烘焙世界变换到几何自身
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    // 只保留 position/normal，材质色烘焙成顶点色
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', g.attributes.position);
    if (g.attributes.normal) ng.setAttribute('normal', g.attributes.normal);
    else ng.computeVertexNormals();
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    color.set(mat && mat.color ? mat.color : 0x999999);
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i * 3] = color.r; cols[i * 3 + 1] = color.g; cols[i * 3 + 2] = color.b; }
    ng.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    if (g.index) ng.setIndex(g.index);
    geos.push(ng);
  });
  if (!geos.length) return null;
  let merged;
  try { merged = mergeGeometries(geos, false); } catch { merged = null; }
  if (!merged) return null;
  // 归一化：长边 0.9m，且平放（长轴贴地）
  merged.computeBoundingBox();
  let bb = merged.boundingBox, sz = bb.getSize(new THREE.Vector3());
  if (sz.y > sz.x && sz.y > sz.z) merged.rotateX(Math.PI / 2); // 竖着的枪躺平
  bb = merged.boundingBox = null;
  merged.computeBoundingBox();
  bb = merged.boundingBox; sz = bb.getSize(new THREE.Vector3());
  const s = 0.9 / Math.max(sz.x, sz.y, sz.z, 0.0001);
  merged.scale(s, s, s);
  merged.computeBoundingBox();
  const c2 = merged.boundingBox.getCenter(new THREE.Vector3());
  merged.translate(-c2.x, -c2.y, -c2.z);
  _lootGeoCache.set(wid, merged);
  return merged;
}

// ---------- 真人角色 ----------
// 士兵模型（Mixamo 骨骼）：动作 Idle/Walk/Run/TPose
// 持枪姿势用程序化骨骼覆盖（在 mixer.update 之后叠加），参数在下方集中调整
const AIM_POSE = {
  'mixamorigRightArm':        { rot: [1.35, 0.35, 0], zRot0: null },
  'mixamorigRightForeArm':    { rot: [-0.25, 0, 0.15] },
  'mixamorigLeftArm':         { rot: [1.25, -0.5, 0] },
  'mixamorigLeftForeArm':     { rot: [-0.4, 0, -0.55] },
};
// 跳伞/吊伞姿态：幅度小、两姿态接近，避免 f/c 状态切换时肢体大幅摆动
const CHUTE_POSE = {
  'mixamorigRightArm':        { rot: [0, 0, -1.0] },
  'mixamorigLeftArm':         { rot: [0, 0, 1.0] },
  'mixamorigRightForeArm':    { rot: [0, 0, -0.25] },
  'mixamorigLeftForeArm':     { rot: [0, 0, 0.25] },
  'mixamorigRightUpLeg':      { rot: [-0.3, 0, 0] },
  'mixamorigLeftUpLeg':       { rot: [-0.2, 0, 0] },
  'mixamorigRightLeg':        { rot: [0.35, 0, 0] },
  'mixamorigLeftLeg':         { rot: [0.2, 0, 0] },
};
const FALL_POSE = {
  'mixamorigRightArm':        { rot: [0, 0, -0.5] },
  'mixamorigLeftArm':         { rot: [0, 0, 0.5] },
  'mixamorigRightForeArm':    { rot: [0, 0, -0.2] },
  'mixamorigLeftForeArm':     { rot: [0, 0, 0.2] },
  'mixamorigRightUpLeg':      { rot: [-0.25, 0, 0] },
  'mixamorigLeftUpLeg':       { rot: [-0.15, 0, 0] },
  'mixamorigRightLeg':        { rot: [0.3, 0, 0] },
  'mixamorigLeftLeg':         { rot: [0.15, 0, 0] },
};

const HAND_BONE = 'mixamorigRightHand';
const HEAD_BONE = 'mixamorigHead';
const SPINE_BONE = 'mixamorigSpine1';

function boneApply(bones, pose, k = 1) {
  for (const [name, p] of Object.entries(pose)) {
    const b = bones[name];
    if (!b) continue;
    // AnimationMixer 每帧直接写四元数，骨骼的欧拉角不会自动回读；
    // 必须先从四元数同步欧拉，否则 += 会逐帧累加，手臂高速旋转
    b.rotation.setFromQuaternion(b.quaternion, b.rotation.order);
    b.rotation.x += p.rot[0] * k;
    b.rotation.y += p.rot[1] * k;
    b.rotation.z += p.rot[2] * k;
  }
}

// 武器世界对齐用的临时对象（模块级复用，避免每帧分配）
const _aimF = new THREE.Vector3();
const _aimQ = new THREE.Quaternion();
const _aimZ = new THREE.Vector3(0, 0, 1);

export function makeHumanoid(outfit, isNight) {
  const gt = Assets.gt.soldier;
  const o = typeof outfit === 'string' ? { torso: outfit } : (outfit || {});
  const tint = new THREE.Color(o.torso || '#7a8a5a');
  tint.lerp(new THREE.Color(0xffffff), 0.45); // 染色混白：衣服显色同时保留面部/迷彩细节

  const root = skeletonClone(gt.scene);
  root.traverse((m) => {
    if (m.isMesh || m.isSkinnedMesh) {
      m.material = m.material.clone();
      m.frustumCulled = false; // 蒙皮网格包围盒会漂移，禁用视锥剔除防止人物闪烁
      if (/visor/i.test(m.name)) return;              // 面罩保持原色
      m.material.color.copy(tint);                    // 皮肤=整套染色（贴图迷彩 × 衣服色）
    }
  });

  // 骨骼索引
  const bones = {};
  root.traverse((o2) => { if (o2.isBone) bones[o2.name] = o2; });

  // 尺寸：soldier.glb 自带变换即为人形实际大小（约 1.8m，与 three.js 官方示例一致），
  // 不做包围盒归一化——克隆体的 matrixWorld 缓存会让测量严重失真
  const wrap = new THREE.Group();
  // 模型本体面朝 -Z，游戏前进方向是 +Z：内层翻转 180°，让角色背面朝玩家视角
  const flip = new THREE.Group();
  flip.rotation.y = Math.PI;
  flip.add(root);
  wrap.add(flip);

  // 动画
  const mixer = new THREE.AnimationMixer(root);
  const clipOf = (kw) => gt.animations.find((a) => a.name.toLowerCase().includes(kw));
  const clips = {
    idle: clipOf('idle'), walk: clipOf('walk'), run: clipOf('run'),
    // 注意：TPose 片段是单帧零时长，AnimationMixer 对它不生效，不能用作空中姿态
  };
  const actions = {};
  for (const [k, c] of Object.entries(clips)) if (c) actions[k] = mixer.clipAction(c);
  let current = null;
  const fadeTo = (name, dur = 0.25) => {
    const next = actions[name];
    if (!next || next === current) return;
    if (current) { current.fadeOut(dur); }
    next.reset().fadeIn(dur).play();
    current = next;
  };
  fadeTo('idle', 0);

  // 绑定姿态（T-Pose）各骨骼欧拉角基线：空中姿态 = 基线 + 偏移（绝对设置，绝不累加）
  const bindEuler = {};
  for (const [n, b] of Object.entries(bones)) bindEuler[n] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
  // 进入空中瞬间的骨骼四元数（用于平滑过渡到空中姿态）
  let airFrom = null;
  const _airQ = new THREE.Quaternion();
  const _airE = new THREE.Euler();
  const AIR_BONES = [...new Set([...Object.keys(CHUTE_POSE), ...Object.keys(FALL_POSE)])];

  // 手持武器挂点（右手）。枪的位置跟随手骨；朝向由 updateAnim 每帧
  // 做"世界对齐"——枪口强制指向角色正前方，不受手骨朝向摆布
  const handBone = bones[HAND_BONE];
  const weaponMount = new THREE.Group();
  if (handBone) handBone.add(weaponMount);
  let weapon = null, weaponWid = null, weaponTip = null;

  // 护甲/头盔：挂在脊柱/头骨上的简易装备件
  const gearMat = () => new THREE.MeshLambertMaterial({ color: 0x39424e });
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.28), gearMat());
  vest.visible = false;
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 10, 8), gearMat());
  helmet.scale.set(1, 0.78, 1.08);
  helmet.visible = false;
  if (bones[SPINE_BONE]) bones[SPINE_BONE].add(vest);
  if (bones[HEAD_BONE]) bones[HEAD_BONE].add(helmet);

  // 脚底阴影 + 降落伞（沿用原有视觉）
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.05;
  wrap.add(shadow);
  const chute = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.4, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xff8c2e, side: THREE.DoubleSide })
  );
  canopy.position.y = 3.2;
  chute.add(canopy);
  chute.visible = false;
  wrap.add(chute);

  const group = wrap;
  let poseBlend = 0; // 0=地面 1=空中姿态

  const api = {
    group, root, chute, vest, helmet, bones, mixer,
    humanoid: true,
    setWeapon(wid, wdef) {
      if (wid === weaponWid) return;
      weaponWid = wid;
      if (weapon) { weaponMount.remove(weapon); weapon = null; weaponTip = null; }
      const type = wdef ? wdef.type : null;
      if (!wid || wid === 'fists' || type === 'melee') return;
      weapon = makeWeapon(wid);
      if (!weapon) return;
      weapon.rotation.set(0, 0, 0);
      weapon.position.set(0, 0.1, 0.02);
      weaponMount.add(weapon);
      weaponTip = weapon.userData.tipPos || null;
    },
    muzzleWorldPos(out) {
      if (weaponTip) return weapon.localToWorld(out.set(weaponTip[0], weaponTip[1], weaponTip[2]));
      return group.getWorldPosition(out);
    },
    // 把手中武器枪口对齐到角色正前方（世界对齐，每帧调用）
    alignWeaponForward() {
      if (!weapon || !handBone) return;
      _aimF.set(0, 0, 1).applyQuaternion(group.quaternion);      // 角色前方（世界系）
      weaponMount.getWorldQuaternion(_aimQ);
      _aimF.applyQuaternion(_aimQ.copy(_aimQ).invert());          // 转到挂点局部系
      weapon.quaternion.setFromUnitVectors(_aimZ, _aimF.normalize());
    },
    // 状态驱动动画：st: g地面 f跳伞 c开伞 v载具；moving/sprint/crouch
    updateAnim(dt, st) {
      const moving = st.moving, sprint = st.sprint, crouch = st.crouch;
      if (st.st === 'f' || st.st === 'c') {
        // 空中：停用全部动画片段（TPose 是零时长片段，混合器写不进骨骼），
        // 用「绑定姿态 + 绝对偏移」摆姿势，从进入瞬间平滑过渡
        if (!airFrom) {
          airFrom = {};
          for (const n of AIR_BONES) {
            const b = bones[n];
            airFrom[n] = b ? b.quaternion.clone() : null;
          }
          mixer.stopAllAction();
          current = null;
        }
        poseBlend = Math.min(1, poseBlend + dt * 6);
        const pose = st.st === 'c' ? CHUTE_POSE : FALL_POSE;
        for (const [n, p] of Object.entries(pose)) {
          const b = bones[n];
          if (!b || !airFrom[n]) continue;
          _airE.set(bindEuler[n].x + p.rot[0], bindEuler[n].y + p.rot[1], bindEuler[n].z + p.rot[2]);
          _airQ.setFromEuler(_airE);
          b.quaternion.slerpQuaternions(airFrom[n], _airQ, poseBlend);
        }
        wrap.scale.setScalar(1);
      } else {
        // 地面/载具：正常片段驱动 + 持枪姿势叠加
        if (airFrom) { airFrom = null; poseBlend = 0; }
        if (st.st === 'v') fadeTo('idle', 0.3);                    // 坐车
        else if (moving) fadeTo(sprint ? 'run' : 'walk', 0.22);
        else fadeTo('idle', 0.25);
        mixer.update(dt);
        boneApply(bones, AIM_POSE, 1);
        // 蹲下：整体压低 + 上身前倾
        wrap.scale.setScalar(crouch ? 0.76 : 1);
        const spine = bones['mixamorigSpine'];
        if (spine && crouch) spine.rotation.x += 0.35;
      }
      chute.visible = st.st === 'c';
      // 手中武器枪口始终对准角色正前方（世界对齐，抵消手骨朝向的不确定性）
      this.alignWeaponForward();
    },
    dispose() { mixer.stopAllAction(); },
  };
  return api;
}

// ---------- 载具 ----------
export function makeVehicleMesh(type) {
  const def = VEHICLE_DEFS[type];
  const key = 'v_' + type;
  if (!def || !Assets.gt[key]) return null;
  const g = normalizeModel(Assets.gt[key].scene.clone(true), { len: def.len, ground: true, flip: def.flip, yawFix: def.yawFix });
  return g;
}

// ---------- 运输机（带螺旋桨动画） ----------
export function makePlaneMesh() {
  if (!Assets.gt.plane) return null;
  // 飞机不能按"最长边"自动旋转（翼展>机身长是正常的），按机身长度归一化
  const g = normalizeModel(Assets.gt.plane.scene.clone(true), {
    len: 8.5, ground: false, noRotate: true, scaleBy: 'z', flip: true,
  });
  const mixer = new THREE.AnimationMixer(g);
  for (const clip of Assets.gt.plane.animations || []) mixer.clipAction(clip).play();
  return { group: g, mixer };
}

// ---------- 空投箱 ----------
export function makeCrateMesh() {
  if (!Assets.gt.crate) return null;
  return normalizeModel(Assets.gt.crate.scene.clone(true), { len: 1.55, ground: true });
}
