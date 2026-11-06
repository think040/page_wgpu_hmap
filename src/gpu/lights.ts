import { mat4, vec3, type Mat4 } from "wgpu-matrix";
import {
  PAINTING_CENTER,
  type LightCommon,
  type Rotation,
  type SceneState,
  type ShadowType,
  type Vec3,
} from "@/scene/state";

/** GPU 로 보내는 조명 데이터 (common.wgsl 의 Light 와 1:1) */
export interface GpuLight {
  position: Vec3;
  kind: number;
  direction: Vec3;
  range: number;
  color: Vec3;
  intensity: number;
  cosInner: number;
  cosOuter: number;
  enabled: boolean;
  shadowType: number;
  shadowStrength: number;
  bias: number;
  normalBias: number;
  softness: number;
  texelWorld: number;
  shadowMapSize: number;
  nearPlane: number;
  depthRange: number;
  viewProj: Mat4;
}

export interface ResolvedLights {
  lights: [GpuLight, GpuLight, GpuLight]; // directional, spot, point
  pointFaces: Mat4[];
  /** 섀도우 패스가 필요한지 (조명 활성 + 그림자 켜짐) */
  castsShadow: [boolean, boolean, boolean];
}

const DEG = Math.PI / 180;

/** Unity 식 오일러(x=pitch, y=yaw) → 빛이 진행하는 방향. yaw 0 = 벽(-z) 방향 */
export function dirFromRotation(r: Rotation): Vec3 {
  const p = r.x * DEG;
  const y = r.y * DEG;
  return [Math.cos(p) * Math.sin(y), -Math.sin(p), -Math.cos(p) * Math.cos(y)];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex: string): Vec3 {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

/** 색온도(K) → 선형 RGB (Tanner Helland 근사, 최대 성분 1 로 정규화) */
export function kelvinToLinear(kelvin: number): Vec3 {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin: Vec3 = [r, g, b].map((v) => srgbToLinear(Math.min(255, Math.max(0, v)) / 255)) as Vec3;
  const m = Math.max(lin[0], lin[1], lin[2]) || 1;
  return [lin[0] / m, lin[1] / m, lin[2] / m];
}

export function lightColor(l: LightCommon): Vec3 {
  const c = hexToLinear(l.color);
  if (!l.useTemperature) return c;
  const k = kelvinToLinear(l.temperature);
  return [c[0] * k[0], c[1] * k[1], c[2] * k[2]];
}

export function cssColorOfLight(l: LightCommon): string {
  const c = lightColor(l);
  const toS = (v: number) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
  };
  return `rgb(${toS(c[0])}, ${toS(c[1])}, ${toS(c[2])})`;
}

function shadowTypeIndex(t: ShadowType): number {
  return t === "none" ? 0 : t === "hard" ? 1 : 2;
}

export function pointLightPosition(
  orbit: { azimuth: number; elevation: number; radius: number },
  azOffset: number,
): Vec3 {
  const az = (orbit.azimuth + azOffset) * DEG;
  const el = orbit.elevation * DEG;
  const c = PAINTING_CENTER;
  return [
    c[0] + orbit.radius * Math.cos(el) * Math.sin(az),
    c[1] + orbit.radius * Math.sin(el),
    c[2] + orbit.radius * Math.cos(el) * Math.cos(az),
  ];
}

function t3(v: ArrayLike<number>): Vec3 {
  return [v[0], v[1], v[2]];
}

function upFor(d: Vec3): Vec3 {
  return Math.abs(d[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
}

/** 방향광 그림자 범위: 그림 주변 벽면 (반폭, m) */
const DIR_SHADOW_HALF = 1.25;
const POINT_FOV = 95 * DEG;

export const POINT_FACE_DIRS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export interface LightAnimation {
  dirYaw: number;
  pointAzimuth: number;
}

export function resolveLights(state: SceneState, anim: LightAnimation): ResolvedLights {
  const { directional: dl, spot: sl, point: pl } = state;

  // ── Directional ──
  const dDir = dirFromRotation({ x: dl.rotation.x, y: dl.rotation.y + anim.dirYaw });
  const center: Vec3 = [0, 0, 0.03];
  const eye = vec3.subtract(center, vec3.scale(dDir, 5));
  const dView = mat4.lookAt(eye, center, upFor(dDir));
  const S = DIR_SHADOW_HALF;
  const dProj = mat4.ortho(-S, S, -S, S, 0.1, 10);
  const directional: GpuLight = {
    position: t3(eye),
    kind: 0,
    direction: dDir,
    range: 0,
    color: lightColor(dl),
    intensity: dl.intensity,
    cosInner: 1,
    cosOuter: 0,
    enabled: dl.enabled,
    shadowType: shadowTypeIndex(dl.shadowType),
    shadowStrength: dl.shadowStrength,
    bias: dl.bias,
    normalBias: dl.normalBias,
    softness: dl.softness,
    texelWorld: (2 * S) / dl.shadowResolution,
    shadowMapSize: dl.shadowResolution,
    nearPlane: 0.1,
    depthRange: 9.9,
    viewProj: mat4.multiply(dProj, dView),
  };

  // ── Spot ──
  const sDir = dirFromRotation(sl.rotation);
  const outer = Math.min(Math.max(sl.spotAngle, 1), 179);
  const inner = Math.min(Math.max(sl.innerSpotAngle, 0), outer - 0.5);
  const sFov = Math.min(outer + 6, 170) * DEG;
  const sView = mat4.lookAt(sl.position, vec3.add(sl.position, sDir), upFor(sDir));
  const sProj = mat4.perspective(sFov, 1, sl.nearPlane, sl.range);
  const cosOuter = Math.cos((outer / 2) * DEG);
  const cosInner = Math.max(Math.cos((inner / 2) * DEG), cosOuter + 1e-4);
  const spot: GpuLight = {
    position: sl.position,
    kind: 1,
    direction: sDir,
    range: sl.range,
    color: lightColor(sl),
    intensity: sl.intensity,
    cosInner,
    cosOuter,
    enabled: sl.enabled,
    shadowType: shadowTypeIndex(sl.shadowType),
    shadowStrength: sl.shadowStrength,
    bias: sl.bias,
    normalBias: sl.normalBias,
    softness: sl.softness,
    texelWorld: (2 * Math.tan(sFov / 2)) / sl.shadowResolution,
    shadowMapSize: sl.shadowResolution,
    nearPlane: sl.nearPlane,
    depthRange: sl.range - sl.nearPlane,
    viewProj: mat4.multiply(sProj, sView),
  };

  // ── Point (6면 섀도우맵) ──
  const pPos = pointLightPosition(pl.orbit, anim.pointAzimuth);
  const pProj = mat4.perspective(POINT_FOV, 1, pl.nearPlane, pl.range);
  const pointFaces = POINT_FACE_DIRS.map((d) =>
    mat4.multiply(pProj, mat4.lookAt(pPos, vec3.add(pPos, d), upFor(d))),
  );
  const point: GpuLight = {
    position: pPos,
    kind: 2,
    direction: t3(vec3.normalize(vec3.subtract(PAINTING_CENTER, pPos))),
    range: pl.range,
    color: lightColor(pl),
    intensity: pl.intensity,
    cosInner: 1,
    cosOuter: 0,
    enabled: pl.enabled,
    shadowType: shadowTypeIndex(pl.shadowType),
    shadowStrength: pl.shadowStrength,
    bias: pl.bias,
    normalBias: pl.normalBias,
    softness: pl.softness,
    texelWorld: (2 * Math.tan(POINT_FOV / 2)) / pl.shadowResolution,
    shadowMapSize: pl.shadowResolution,
    nearPlane: pl.nearPlane,
    depthRange: pl.range - pl.nearPlane,
    viewProj: pointFaces[0],
  };

  const lights: [GpuLight, GpuLight, GpuLight] = [directional, spot, point];
  return {
    lights,
    pointFaces,
    castsShadow: lights.map((l) => l.enabled && l.shadowType > 0) as [boolean, boolean, boolean],
  };
}

// ── Frame 유니폼 패킹 (common.wgsl 의 Frame 과 동일 레이아웃) ──
export const FRAME_FLOATS = 272; // 1088 bytes
const LIGHT_BASE = 56; // 224 bytes
const LIGHT_FLOATS = 40; // 160 bytes
const POINT_FACES_BASE = 176; // 704 bytes

export interface FrameData {
  viewProj: Mat4;
  invViewProj: Mat4;
  cameraPos: ArrayLike<number>;
  time: number;
  resolution: [number, number];
  heightScale: number;
  exposure: number;
  paintMin: [number, number];
  paintSize: [number, number];
  paintZ: number;
  ambient: number;
  aoStrength: number;
  microShadow: boolean;
  microSteps: number;
  gloss: number;
  frameIndex: number;
  floorY: number;
  canvasOuter: [number, number, number, number];
  resolved: ResolvedLights;
}

export function packFrame(f: Float32Array, d: FrameData): void {
  f.set(d.viewProj, 0);
  f.set(d.invViewProj, 16);
  f[32] = d.cameraPos[0];
  f[33] = d.cameraPos[1];
  f[34] = d.cameraPos[2];
  f[35] = d.time;
  f[36] = d.resolution[0];
  f[37] = d.resolution[1];
  f[38] = d.heightScale;
  f[39] = d.exposure;
  f[40] = d.paintMin[0];
  f[41] = d.paintMin[1];
  f[42] = d.paintSize[0];
  f[43] = d.paintSize[1];
  f[44] = d.paintZ;
  f[45] = d.ambient;
  f[46] = d.aoStrength;
  f[47] = d.microShadow ? 1 : 0;
  f[48] = d.microSteps;
  f[49] = d.gloss;
  f[50] = d.frameIndex;
  f[51] = d.floorY;
  f.set(d.canvasOuter, 52);

  d.resolved.lights.forEach((l, i) => {
    const o = LIGHT_BASE + i * LIGHT_FLOATS;
    f.set(l.position, o);
    f[o + 3] = l.kind;
    f.set(l.direction, o + 4);
    f[o + 7] = l.range;
    f.set(l.color, o + 8);
    f[o + 11] = l.intensity;
    f[o + 12] = l.cosInner;
    f[o + 13] = l.cosOuter;
    f[o + 14] = l.enabled ? 1 : 0;
    f[o + 15] = l.shadowType;
    f[o + 16] = l.shadowStrength;
    f[o + 17] = l.bias;
    f[o + 18] = l.normalBias;
    f[o + 19] = l.softness;
    f[o + 20] = l.texelWorld;
    f[o + 21] = l.shadowMapSize;
    f[o + 22] = l.nearPlane;
    f[o + 23] = l.depthRange;
    f.set(l.viewProj, o + 24);
  });
  d.resolved.pointFaces.forEach((m, k) => f.set(m, POINT_FACES_BASE + k * 16));
}

// ── 기즈모 라인 ──
function circle(out: number[], c: Vec3, u: Vec3, v: Vec3, r: number, col: Vec3, seg = 24) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    for (const a of [a0, a1]) {
      out.push(
        c[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r,
        c[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r,
        c[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r,
        col[0],
        col[1],
        col[2],
      );
    }
  }
}

function line(out: number[], a: ArrayLike<number>, b: ArrayLike<number>, col: Vec3) {
  out.push(a[0], a[1], a[2], col[0], col[1], col[2], b[0], b[1], b[2], col[0], col[1], col[2]);
}

function perpBasis(d: Vec3): [Vec3, Vec3] {
  const up = upFor(d);
  const u = vec3.normalize(vec3.cross(d, up));
  const v = vec3.cross(u, d);
  return [t3(u), t3(v)];
}

export function buildGizmoLines(state: SceneState, r: ResolvedLights): Float32Array {
  const out: number[] = [];
  const tint = (c: Vec3): Vec3 => {
    const m = Math.max(c[0], c[1], c[2]) || 1;
    return [c[0] / m, c[1] / m, c[2] / m];
  };
  const [dl, sl, pl] = r.lights;

  if (dl.enabled) {
    const col = tint(dl.color);
    const origin = vec3.subtract([0, 0, 0.05], vec3.scale(dl.direction, 0.95));
    const tip = vec3.add(origin, vec3.scale(dl.direction, 0.3));
    const [u, v] = perpBasis(dl.direction);
    circle(out, t3(origin), u, v, 0.05, col, 16);
    for (const k of [0, 1, 2, 3]) {
      const a = (k / 4) * Math.PI * 2;
      const off = vec3.add(vec3.scale(u, Math.cos(a) * 0.05), vec3.scale(v, Math.sin(a) * 0.05));
      line(out, vec3.add(origin, off), vec3.add(tip, off), col);
    }
    line(out, origin, vec3.add(tip, vec3.scale(dl.direction, 0.08)), col);
  }

  if (sl.enabled) {
    const col = tint(sl.color);
    const len = 0.55;
    const [u, v] = perpBasis(sl.direction);
    const c = vec3.add(sl.position, vec3.scale(sl.direction, len));
    const rad = len * Math.tan((Math.min(state.spot.spotAngle, 170) / 2) * DEG);
    circle(out, t3(c), u, v, rad, col, 32);
    for (const k of [0, 1, 2, 3]) {
      const a = (k / 4) * Math.PI * 2;
      const p = vec3.add(c, vec3.add(vec3.scale(u, Math.cos(a) * rad), vec3.scale(v, Math.sin(a) * rad)));
      line(out, sl.position, p, col);
    }
    circle(out, sl.position, u, v, 0.025, col, 12);
  }

  if (pl.enabled) {
    const col = tint(pl.color);
    const p = pl.position;
    circle(out, p, [1, 0, 0], [0, 1, 0], 0.04, col, 16);
    circle(out, p, [1, 0, 0], [0, 0, 1], 0.04, col, 16);
    circle(out, p, [0, 1, 0], [0, 0, 1], 0.04, col, 16);
    // 궤도
    const o = state.point.orbit;
    const center: Vec3 = [PAINTING_CENTER[0], PAINTING_CENTER[1] + o.radius * Math.sin(o.elevation * DEG), PAINTING_CENTER[2]];
    const rr = o.radius * Math.cos(o.elevation * DEG);
    const dim: Vec3 = [col[0] * 0.35, col[1] * 0.35, col[2] * 0.35];
    circle(out, center, [0, 0, 1], [1, 0, 0], rr, dim, 48);
  }

  return new Float32Array(out);
}
