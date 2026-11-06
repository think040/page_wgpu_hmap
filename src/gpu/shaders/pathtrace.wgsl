// ─────────────────────────────────────────────────────────────
// 소프트웨어 패스트레이서 (compute). common.wgsl 뒤에 이어 붙여 컴파일된다.
// WebGPU 에는 하드웨어 RT API 가 없으므로 씬을 해석적으로 교차 계산한다.
//  - 벽/바닥: 평면,  캔버스 몸체: AABB
//  - 그림 면: 하이트필드 레이마칭 + 이분 탐색 정밀화
//  - 직접광: NEE(그림자 레이) + 면광원 샘플링(softness),  간접광: diffuse/GGX 샘플링
//  - 프레임마다 1 spp 씩 누적 (progressive), ptGBuffer 는 디노이저용 1차 히트 정보
// ─────────────────────────────────────────────────────────────

struct RTParams {
  width: u32,
  height: u32,
  sampleIndex: u32,
  maxBounces: u32,
  seed: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var linSampler: sampler;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var heightTex: texture_2d<f32>;
@group(0) @binding(4) var normalTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(6) var<uniform> rt: RTParams;
@group(0) @binding(7) var<storage, read_write> moments: array<vec2f>;   // (Σ휘도, Σ휘도²)
@group(0) @binding(8) var<storage, read_write> gbuf: array<vec4f>;
@group(0) @binding(9) var<storage, read_write> albedoBuf: array<u32>;

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// 픽셀 좌표(내부 해상도 기준) → 월드 공간 레이 방향
fn cameraRay(pixel: vec2f) -> vec3f {
  let px = pixel / vec2f(f32(rt.width), f32(rt.height));
  let ndc = vec2f(px.x * 2.0 - 1.0, 1.0 - px.y * 2.0);
  let nearH = frame.invViewProj * vec4f(ndc, 0.0, 1.0);
  let farH = frame.invViewProj * vec4f(ndc, 1.0, 1.0);
  return normalize(farH.xyz / farH.w - nearH.xyz / nearH.w);
}

// ── RNG ──────────────────────────────────────────────────────
var<private> rngState: u32;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand() -> f32 {
  rngState = pcg(rngState);
  return f32(rngState >> 8u) / 16777216.0;
}

// ── 샘플링 헬퍼 ──────────────────────────────────────────────
fn basis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  let t = vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  let bt = vec3f(b, s + n.y * n.y * a, -n.y);
  return mat3x3f(t, bt, n);
}

fn cosineSample(n: vec3f) -> vec3f {
  let r1 = rand();
  let r2 = rand();
  let phi = 2.0 * PI * r1;
  let r = sqrt(r2);
  return basis(n) * vec3f(r * cos(phi), r * sin(phi), sqrt(max(1.0 - r2, 0.0)));
}

fn ggxSampleH(n: vec3f, rough: f32) -> vec3f {
  let a = rough * rough;
  let r1 = rand();
  let r2 = rand();
  let phi = 2.0 * PI * r1;
  let cosT = sqrt((1.0 - r2) / (1.0 + (a * a - 1.0) * r2));
  let sinT = sqrt(max(1.0 - cosT * cosT, 0.0));
  return normalize(basis(n) * vec3f(sinT * cos(phi), sinT * sin(phi), cosT));
}

fn diskSample() -> vec2f {
  let r = sqrt(rand());
  let phi = 2.0 * PI * rand();
  return vec2f(cos(phi), sin(phi)) * r;
}

fn sphereSample() -> vec3f {
  let z = rand() * 2.0 - 1.0;
  let phi = 2.0 * PI * rand();
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(phi), r * sin(phi), z) * pow(max(rand(), 1e-6), 1.0 / 3.0);
}

// ── 교차 ────────────────────────────────────────────────────
const MISS: u32 = 99u;

struct Hit {
  t: f32,
  N: vec3f,
  mat: u32,
  uv: vec2f,
};

fn safeInv(d: vec3f) -> vec3f {
  let e = 1e-8;
  let s = select(vec3f(-1.0), vec3f(1.0), d >= vec3f(0.0));
  return 1.0 / select(d, s * e, abs(d) < vec3f(e));
}

fn rayBox(ro: vec3f, inv: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let t0 = (bmin - ro) * inv;
  let t1 = (bmax - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2f(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

fn boxNormal(p: vec3f, bmin: vec3f, bmax: vec3f) -> vec3f {
  let c = (bmin + bmax) * 0.5;
  let e = (bmax - bmin) * 0.5;
  let d = (p - c) / e;
  let a = abs(d);
  if (a.x > a.y && a.x > a.z) { return vec3f(sign(d.x), 0.0, 0.0); }
  if (a.y > a.z) { return vec3f(0.0, sign(d.y), 0.0); }
  return vec3f(0.0, 0.0, sign(d.z));
}

fn paintUV(p: vec3f) -> vec2f {
  return worldToPaintUV(p.xy, frame.paintMin, frame.paintSize);
}

fn heightAt(uv: vec2f) -> f32 {
  return textureSampleLevel(heightTex, linSampler, uv, 0.0).r;
}

// 하이트필드 볼륨(그림 면 위 두께 heightScale 의 슬랩)을 레이마칭. 실패 시 -1
fn traceHeightfield(ro: vec3f, rd: vec3f, inv: vec3f, tLimit: f32) -> f32 {
  let hs = max(frame.heightScale, 1e-5);
  let bmin = vec3f(frame.paintMin, frame.paintZ);
  let bmax = vec3f(frame.paintMin + frame.paintSize, frame.paintZ + hs);
  let tt = rayBox(ro, inv, bmin, bmax);
  let t0 = max(tt.x, 0.0);
  let t1 = min(tt.y, tLimit);
  if (t0 >= t1) { return -1.0; }

  let texels = length(paintUV(ro + rd * t1) - paintUV(ro + rd * t0)) * f32(textureDimensions(heightTex).x);
  let n = clamp(i32(texels * 0.6) + 4, 4, 160);
  var tPrev = t0;
  for (var i = 1; i <= n; i++) {
    let t = mix(t0, t1, f32(i) / f32(n));
    let p = ro + rd * t;
    if ((p.z - frame.paintZ) / hs < heightAt(paintUV(p))) {
      var a = tPrev;
      var b = t;
      for (var j = 0; j < 6; j++) {
        let m = 0.5 * (a + b);
        let q = ro + rd * m;
        if ((q.z - frame.paintZ) / hs < heightAt(paintUV(q))) { b = m; } else { a = m; }
      }
      return b;
    }
    tPrev = t;
  }
  return -1.0;
}

fn traceScene(ro: vec3f, rd: vec3f, tMax: f32) -> Hit {
  var hit: Hit;
  hit.t = tMax;
  hit.mat = MISS;
  let inv = safeInv(rd);

  // 벽 (z = 0)
  if (rd.z < -1e-6) {
    let t = -ro.z / rd.z;
    if (t > 1e-4 && t < hit.t) {
      let p = ro + rd * t;
      if (abs(p.x) <= 4.0 && p.y >= frame.floorY && p.y <= 2.6) {
        hit.t = t; hit.N = vec3f(0.0, 0.0, 1.0); hit.mat = MAT_WALL;
      }
    }
  }
  // 바닥
  if (rd.y < -1e-6) {
    let t = (frame.floorY - ro.y) / rd.y;
    if (t > 1e-4 && t < hit.t) {
      let p = ro + rd * t;
      if (abs(p.x) <= 4.0 && p.z >= 0.0 && p.z <= 5.0) {
        hit.t = t; hit.N = vec3f(0.0, 1.0, 0.0); hit.mat = MAT_FLOOR;
      }
    }
  }
  // 캔버스 몸체
  let co = frame.canvasOuter;
  let bmin = vec3f(-co.x, -co.y, co.z);
  let bmax = vec3f(co.x, co.y, co.w);
  let tb = rayBox(ro, inv, bmin, bmax);
  if (tb.x <= tb.y && tb.x > 1e-4 && tb.x < hit.t) {
    let p = ro + rd * tb.x;
    let n = boxNormal(p, bmin, bmax);
    hit.t = tb.x;
    hit.N = n;
    let uv = paintUV(p);
    hit.uv = clamp(uv, vec2f(0.0), vec2f(1.0));
    if (n.z > 0.5) {
      let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
      hit.mat = select(MAT_SIDE, MAT_PAINT, inside);
    } else if (n.z < -0.5) {
      hit.mat = MAT_BACK;
    } else {
      hit.mat = MAT_SIDE;
    }
  }
  // 그림 면 (하이트필드)
  let th = traceHeightfield(ro, rd, inv, hit.t);
  if (th > 0.0) {
    let p = ro + rd * th;
    hit.t = th;
    hit.uv = paintUV(p);
    hit.N = normalize(textureSampleLevel(normalTex, linSampler, hit.uv, 0.0).xyz);
    hit.mat = MAT_PAINT;
  }
  return hit;
}

// ── 머티리얼 ─────────────────────────────────────────────────
struct Surf {
  albedo: vec3f,
  N: vec3f,
  rough: f32,
  pSpec: f32,
};

fn surface(hit: Hit, P: vec3f, Ng: vec3f) -> Surf {
  var s: Surf;
  s.N = Ng;
  switch (hit.mat) {
    case 0u: {
      s.albedo = wallAlbedo(P.xy); s.N = wallNormal(P.xy); s.rough = 0.92; s.pSpec = 0.08;
    }
    case 1u: {
      s.albedo = floorAlbedo(P.xz); s.rough = 0.5; s.pSpec = 0.2;
    }
    case 2u: {
      s.albedo = textureSampleLevel(colorTex, linSampler, hit.uv, 0.0).rgb * 0.92;
      s.rough = min(paintRoughness(frame.gloss) + 0.1, 1.0); s.pSpec = 0.2;
    }
    case 3u: {
      s.albedo = linenAlbedo(hit.uv); s.rough = 0.95; s.pSpec = 0.05;
    }
    default: {
      s.albedo = textureSampleLevel(colorTex, linSampler, hit.uv, 0.0).rgb;
      s.N = hit.N;
      s.rough = paintRoughness(frame.gloss); s.pSpec = 0.25;
    }
  }
  return s;
}

// ── 직접광 (Next Event Estimation) ──────────────────────────
fn directLight(light: Light, P: vec3f, Ng: vec3f, V: vec3f, s: Surf) -> vec3f {
  if (light.enabled < 0.5) { return vec3f(0.0); }
  var ls: LightSample;
  if (light.kind < 0.5) {
    // 방향광: 원뿔 각 안에서 방향 샘플 (태양 원반)
    let d = diskSample() * tan(light.softness * 0.06);
    ls.L = normalize(basis(-light.direction) * vec3f(d, 1.0));
    ls.radiance = light.color * light.intensity * PI;
    ls.dist = 1e4;
  } else {
    // 스팟/포인트: 구형 면광원 샘플
    let lp = light.position + sphereSample() * (light.softness * 0.12);
    ls = evalLightAt(light, P, lp);
  }
  if (max(ls.radiance.x, max(ls.radiance.y, ls.radiance.z)) <= 0.0) { return vec3f(0.0); }
  if (dot(Ng, ls.L) <= 0.0) { return vec3f(0.0); }
  let f = brdf(s.N, V, ls.L, s.albedo, s.rough, vec3f(0.04));
  if (max(f.x, max(f.y, f.z)) <= 0.0) { return vec3f(0.0); }

  var vis = 1.0;
  if (light.shadowType > 0.5) {
    let h = traceScene(P + Ng * 3e-4, ls.L, ls.dist - 1e-3);
    if (h.mat != MISS) { vis = 0.0; }
    vis = mix(1.0, vis, light.shadowStrength);
  }
  return f * ls.radiance * vis;
}

@compute @workgroup_size(8, 8)
fn ptMain(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= rt.width || gid.y >= rt.height) { return; }
  rngState = pcg(gid.x * 1973u + gid.y * 9277u + rt.sampleIndex * 26699u + rt.seed) | 1u;

  var ro = frame.cameraPos;
  var rd = cameraRay(vec2f(gid.xy) + vec2f(rand(), rand()));

  var radiance = vec3f(0.0);
  var thr = vec3f(1.0);

  for (var bounce = 0u; bounce <= rt.maxBounces; bounce++) {
    let hit = traceScene(ro, rd, 1e4);
    if (hit.mat == MISS) {
      radiance += thr * envColor(rd, frame.ambient);
      break;
    }
    let P = ro + rd * hit.t;
    var Ng = hit.N;
    if (dot(Ng, rd) > 0.0) { Ng = -Ng; }
    var s = surface(hit, P, Ng);
    let V = -rd;
    if (dot(s.N, V) <= 0.0) { s.N = Ng; }

    for (var i = 0u; i < 3u; i++) {
      radiance += thr * min(directLight(frame.lights[i], P, Ng, V, s), vec3f(24.0));
    }
    if (bounce == rt.maxBounces) { break; }

    // 다음 방향 샘플
    var L: vec3f;
    if (rand() < s.pSpec) {
      let H = ggxSampleH(s.N, s.rough);
      L = reflect(-V, H);
      let NdotL = dot(s.N, L);
      if (NdotL <= 0.0 || dot(Ng, L) <= 0.0) { break; }
      let NdotV = max(dot(s.N, V), 1e-4);
      let NdotH = max(dot(s.N, H), 1e-4);
      let VdotH = max(dot(V, H), 0.0);
      let a = s.rough * s.rough;
      let k = a * 0.5;
      let G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
      let F = 0.04 + 0.96 * schlickWeight(VdotH);
      thr *= F * G * VdotH / (NdotV * NdotH) / s.pSpec;
    } else {
      L = cosineSample(s.N);
      if (dot(Ng, L) <= 0.0) { break; }
      thr *= s.albedo * 0.96 / (1.0 - s.pSpec);
    }
    ro = P + Ng * 3e-4;
    rd = L;

    // Russian roulette
    if (bounce >= 1u) {
      let q = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
      if (rand() > q) { break; }
      thr /= q;
    }
  }

  // 누적 버퍼는 리셋 시 clearBuffer 로 비우거나 재투영으로 채워진다 → 항상 더한다
  // 비정상 샘플은 버린다. 누적 버퍼는 합계라서 NaN 이 한 번 들어가면 영구히 남고,
  // 디노이저(공간)와 재투영(시간)을 통해 주변으로 번진다.
  if (!finite3(radiance)) { radiance = vec3f(0.0); }
  let idx = gid.y * rt.width + gid.x;
  accum[idx] = accum[idx] + vec4f(radiance, 1.0);
  let l = luminance(radiance);
  moments[idx] = moments[idx] + vec2f(l, l * l);
}

// ── G-buffer (디노이저 / 재투영용): 픽셀 중심 1차 레이 ──────────
// gbuf: (노멀, 카메라로부터 거리 t),  t < 0 이면 배경
@compute @workgroup_size(8, 8)
fn ptGBuffer(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= rt.width || gid.y >= rt.height) { return; }
  let idx = gid.y * rt.width + gid.x;
  let rd = cameraRay(vec2f(gid.xy) + 0.5);
  let hit = traceScene(frame.cameraPos, rd, 1e4);
  if (hit.mat == MISS) {
    gbuf[idx] = vec4f(0.0, 0.0, 0.0, -1.0);
    albedoBuf[idx] = pack4x8unorm(vec4f(1.0));
    return;
  }
  let P = frame.cameraPos + rd * hit.t;
  var Ng = hit.N;
  if (dot(Ng, rd) > 0.0) { Ng = -Ng; }
  var s = surface(hit, P, Ng);
  if (dot(s.N, -rd) <= 0.0) { s.N = Ng; }
  gbuf[idx] = vec4f(s.N, hit.t);
  albedoBuf[idx] = pack4x8unorm(vec4f(clamp(s.albedo, vec3f(0.0), vec3f(1.0)), 1.0));
}
