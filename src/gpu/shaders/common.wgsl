// ─────────────────────────────────────────────────────────────
// 공용 구조체 / 함수 (래스터 · 패스트레이서 공용)
// TS 쪽 레이아웃: src/gpu/uniforms.ts 와 반드시 일치해야 한다.
// ─────────────────────────────────────────────────────────────

const PI: f32 = 3.14159265359;

struct Light {
  position: vec3f, kind: f32,            // kind: 0 directional, 1 spot, 2 point
  direction: vec3f, range: f32,          // direction = 빛이 진행하는 방향
  color: vec3f, intensity: f32,          // color: linear RGB
  cosInner: f32, cosOuter: f32, enabled: f32, shadowType: f32, // shadowType: 0 none, 1 hard, 2 soft
  shadowStrength: f32, bias: f32, normalBias: f32, softness: f32,
  texelWorld: f32, shadowMapSize: f32, nearPlane: f32, depthRange: f32,
  viewProj: mat4x4f,
};

struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  cameraPos: vec3f, time: f32,
  resolution: vec2f, heightScale: f32, exposure: f32,
  paintMin: vec2f, paintSize: vec2f,
  paintZ: f32, ambient: f32, aoStrength: f32, microShadow: f32,
  microSteps: f32, gloss: f32, frameIndex: f32, floorY: f32,
  canvasOuter: vec4f,                    // (halfW, halfH, zBack, zFront)
  lights: array<Light, 3>,
  pointFaces: array<mat4x4f, 6>,
};

const MAT_WALL: u32 = 0u;
const MAT_FLOOR: u32 = 1u;
const MAT_SIDE: u32 = 2u;
const MAT_BACK: u32 = 3u;
const MAT_PAINT: u32 = 4u;

// ── 노이즈 ───────────────────────────────────────────────────
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0));
  let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(q);
    q = q * 2.03 + vec2f(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}

// ── 머티리얼: 회반죽 벽 / 원목 바닥 / 리넨 ─────────────────────
fn wallHeight(p: vec2f) -> f32 {
  return fbm(p * 14.0) * 0.7 + vnoise(p * 70.0) * 0.3;
}

fn wallAlbedo(p: vec2f) -> vec3f {
  let n = fbm(p * 2.5);
  return vec3f(0.80, 0.785, 0.75) * (0.93 + 0.1 * n);
}

fn wallNormal(p: vec2f) -> vec3f {
  let e = 0.0015;
  let amp = 0.00035;
  let gx = (wallHeight(p + vec2f(e, 0.0)) - wallHeight(p - vec2f(e, 0.0))) * amp / (2.0 * e);
  let gy = (wallHeight(p + vec2f(0.0, e)) - wallHeight(p - vec2f(0.0, e))) * amp / (2.0 * e);
  return normalize(vec3f(-gx, -gy, 1.0));
}

fn floorAlbedo(p: vec2f) -> vec3f {
  // p = (x, z). z 방향으로 폭 16cm 마루판
  let row = floor(p.y / 0.16);
  let shift = hash12(vec2f(row, 3.0)) * 1.3;
  let col = floor((p.x + shift) / 1.3);
  let id = hash12(vec2f(row, col));
  var c = mix(vec3f(0.26, 0.17, 0.11), vec3f(0.40, 0.27, 0.17), id);
  let grain = vnoise(vec2f(p.x * 4.0, p.y * 90.0) + id * 31.0);
  c *= 0.85 + 0.25 * grain;
  let fy = fract(p.y / 0.16);
  let fx = fract((p.x + shift) / 1.3);
  let seam = smoothstep(0.0, 0.02, fy) * smoothstep(1.0, 0.98, fy) * smoothstep(0.0, 0.003, fx) * smoothstep(1.0, 0.997, fx);
  return c * mix(0.45, 1.0, seam);
}

fn linenAlbedo(uv: vec2f) -> vec3f {
  let w = vnoise(uv * vec2f(900.0, 30.0)) * 0.5 + vnoise(uv * vec2f(30.0, 900.0)) * 0.5;
  return vec3f(0.72, 0.64, 0.52) * (0.85 + 0.2 * w);
}

// ── 조명 ─────────────────────────────────────────────────────
fn envColor(dir: vec3f, ambient: f32) -> vec3f {
  let sky = vec3f(0.92, 0.94, 1.0);
  let ground = vec3f(0.42, 0.36, 0.30);
  return mix(ground, sky, clamp(dir.y * 0.5 + 0.5, 0.0, 1.0)) * ambient;
}

fn rangeAtten(d: f32, range: f32) -> f32 {
  let x = d / max(range, 1e-3);
  let w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  return w * w / (d * d + 0.01);
}

struct LightSample {
  L: vec3f,        // 표면 → 광원 방향
  radiance: vec3f,
  dist: f32,
};

// lightPos: 패스트레이서는 면광원 샘플링을 위해 흔들린 위치를 넘긴다
fn evalLightAt(light: Light, P: vec3f, lightPos: vec3f) -> LightSample {
  var s: LightSample;
  let base = light.color * light.intensity * PI;
  if (light.kind < 0.5) {
    s.L = -light.direction;
    s.radiance = base;
    s.dist = 1e5;
    return s;
  }
  let toL = lightPos - P;
  let d = max(length(toL), 1e-4);
  s.L = toL / d;
  s.dist = d;
  var a = rangeAtten(d, light.range);
  if (light.kind < 1.5) {
    let cd = dot(-s.L, light.direction);
    a *= smoothstep(light.cosOuter, light.cosInner, cd);
  }
  s.radiance = base * a;
  return s;
}

fn evalLight(light: Light, P: vec3f) -> LightSample {
  return evalLightAt(light, P, light.position);
}

// Schlick Fresnel 가중치 (1 - cos)^5.
// 단위 벡터의 내적도 반올림으로 1 을 살짝 넘을 수 있고, 그때 pow(음수, 5) 는 GPU 에서 NaN 이 된다
// (NVIDIA D3D12 에서 확인). 그래서 pow 대신 clamp 후 곱셈으로 계산한다.
fn schlickWeight(cosTheta: f32) -> f32 {
  let m = clamp(1.0 - cosTheta, 0.0, 1.0);
  let m2 = m * m;
  return m2 * m2 * m;
}

// NaN/Inf 판정. 지수 비트로 검사하므로 fast-math 최적화로 x != x 비교가 사라져도 동작한다
fn finite3(v: vec3f) -> bool {
  return all((bitcast<vec3u>(v) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}

fn finite4(v: vec4f) -> bool {
  return all((bitcast<vec4u>(v) & vec4u(0x7f800000u)) != vec4u(0x7f800000u));
}

// Cook-Torrance (GGX + Smith + Schlick). NdotL 포함, 광원 radiance 미포함
fn brdf(N: vec3f, V: vec3f, L: vec3f, albedo: vec3f, rough: f32, f0: vec3f) -> vec3f {
  let NdotL = max(dot(N, L), 0.0);
  if (NdotL <= 0.0) { return vec3f(0.0); }
  let NdotV = max(dot(N, V), 1e-4);
  let H = normalize(V + L);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  let a = rough * rough;
  let a2 = a * a;
  let dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
  let F = f0 + (1.0 - f0) * schlickWeight(VdotH);
  let spec = D * G * F / (4.0 * NdotV * NdotL + 1e-4);
  let kd = 1.0 - F;
  return (kd * albedo / PI + spec) * NdotL;
}

fn paintRoughness(gloss: f32) -> f32 {
  return mix(0.85, 0.22, gloss);
}

// 월드 xy → 그림 uv (v 는 이미지 아래 방향)
fn worldToPaintUV(p: vec2f, paintMin: vec2f, paintSize: vec2f) -> vec2f {
  return vec2f((p.x - paintMin.x) / paintSize.x, 1.0 - (p.y - paintMin.y) / paintSize.y);
}
