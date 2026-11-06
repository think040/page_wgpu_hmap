// ─────────────────────────────────────────────────────────────
// 래스터 메인 패스 (common.wgsl 뒤에 이어 붙여 컴파일된다)
//  - 정적 메시(벽/바닥/캔버스 몸체)와 하이트맵 변위 그림 면
//  - 그림자: 섀도우맵(PCSS) × 하이트필드 레이마칭 자기그림자
// ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var linSampler: sampler;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var heightTex: texture_2d<f32>;
@group(0) @binding(4) var normalTex: texture_2d<f32>;
@group(0) @binding(5) var shadowSampler: sampler_comparison;
@group(0) @binding(6) var dirShadow: texture_depth_2d;
@group(0) @binding(7) var spotShadow: texture_depth_2d;
@group(0) @binding(8) var pointShadow: texture_depth_2d_array;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) material: u32,
  @location(4) basePos: vec3f, // 그림 면: 변위 전 위치 (섀도우맵 조회용)
};

@vertex
fn vsStatic(
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat: f32,
) -> VSOut {
  var o: VSOut;
  o.clip = frame.viewProj * vec4f(pos, 1.0);
  o.worldPos = pos;
  o.basePos = pos;
  o.normal = nrm;
  o.uv = uv;
  o.material = u32(mat + 0.5);
  return o;
}

fn paintHeight(uv: vec2f) -> f32 {
  return textureSampleLevel(heightTex, linSampler, uv, 0.0).r;
}

@vertex
fn vsPainting(@location(0) uv: vec2f) -> VSOut {
  let base = vec3f(
    frame.paintMin.x + uv.x * frame.paintSize.x,
    frame.paintMin.y + (1.0 - uv.y) * frame.paintSize.y,
    frame.paintZ,
  );
  let p = base + vec3f(0.0, 0.0, paintHeight(uv) * frame.heightScale);
  var o: VSOut;
  o.clip = frame.viewProj * vec4f(p, 1.0);
  o.worldPos = p;
  o.basePos = base;
  o.normal = vec3f(0.0, 0.0, 1.0);
  o.uv = uv;
  o.material = MAT_PAINT;
  return o;
}

// ── 섀도우맵 ─────────────────────────────────────────────────
// 품질 프리셋에 따라 파이프라인 생성 시 8/12/16 으로 지정
override PCF_SAMPLES: i32 = 16;

const POISSON = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725),
  vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464),
  vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420),
  vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590),
  vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790),
);

fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn rot(v: vec2f, cs: vec2f) -> vec2f {
  return vec2f(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

fn projectShadow(m: mat4x4f, p: vec3f) -> vec3f {
  let c = m * vec4f(p, 1.0);
  let n = c.xyz / c.w;
  return vec3f(n.x * 0.5 + 0.5, -n.y * 0.5 + 0.5, n.z);
}

fn outsideShadow(sc: vec3f) -> bool {
  return sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0;
}

fn linearDepth(d: f32, n: f32, f: f32) -> f32 {
  return n * f / (f - d * (f - n));
}

// PCSS: 차폐물-수신면 거리에 비례하는 반그림자 폭(텍셀)
fn penumbraTexels(light: Light, depth: f32, blocker: f32, texelAtP: f32) -> f32 {
  if (light.kind < 0.5) {
    let dz = max(depth - blocker, 0.0) * light.depthRange;
    return dz * tan(light.softness * 0.06) * 2.0 / texelAtP;
  }
  let dR = linearDepth(depth, light.nearPlane, light.range);
  let dB = linearDepth(blocker, light.nearPlane, light.range);
  let pen = max(dR - dB, 0.0) / max(dB, 1e-3) * (light.softness * 0.12);
  return pen / texelAtP;
}

// 텍셀 크기 기준 bias / normal bias 를 월드 공간 오프셋으로 적용 (Unity 방식)
fn biasedPos(light: Light, P: vec3f, Ng: vec3f, L: vec3f, texelAtP: f32) -> vec3f {
  let NdotL = clamp(dot(Ng, L), 0.0, 1.0);
  let sinT = sqrt(1.0 - NdotL * NdotL);
  return P + Ng * (light.normalBias * texelAtP * sinT) + L * (light.bias * texelAtP);
}

fn shadow2D(tex: texture_depth_2d, light: Light, P: vec3f, Ng: vec3f, L: vec3f, noise: f32) -> f32 {
  var texelAtP = light.texelWorld;
  if (light.kind > 0.5) {
    texelAtP = light.texelWorld * max(dot(P - light.position, light.direction), 0.01);
  }
  let sc = projectShadow(light.viewProj, biasedPos(light, P, Ng, L, texelAtP));
  if (outsideShadow(sc)) { return 1.0; }
  if (light.shadowType < 1.5) {
    return textureSampleCompareLevel(tex, shadowSampler, sc.xy, sc.z);
  }
  let size = light.shadowMapSize;
  let a = noise * 2.0 * PI;
  let cs = vec2f(cos(a), sin(a));
  let searchR = (2.0 + 22.0 * light.softness) / size;
  var sum = 0.0;
  var cnt = 0.0;
  for (var i = 0; i < PCF_SAMPLES; i++) {
    let uv = sc.xy + rot(POISSON[i], cs) * searchR;
    let c = vec2i(clamp(uv * size, vec2f(0.0), vec2f(size - 1.0)));
    let d = textureLoad(tex, c, 0);
    if (d < sc.z) { sum += d; cnt += 1.0; }
  }
  if (cnt < 0.5) { return 1.0; }
  let r = clamp(penumbraTexels(light, sc.z, sum / cnt, texelAtP), 1.0, 32.0) / size;
  var lit = 0.0;
  for (var i = 0; i < PCF_SAMPLES; i++) {
    lit += textureSampleCompareLevel(tex, shadowSampler, sc.xy + rot(POISSON[i], cs) * r, sc.z);
  }
  return lit / f32(PCF_SAMPLES);
}

fn pointFace(v: vec3f) -> i32 {
  let a = abs(v);
  if (a.x >= a.y && a.x >= a.z) { return select(1, 0, v.x > 0.0); }
  if (a.y >= a.z) { return select(3, 2, v.y > 0.0); }
  return select(5, 4, v.z > 0.0);
}

fn shadowPoint(light: Light, P: vec3f, Ng: vec3f, L: vec3f, noise: f32) -> f32 {
  let v = P - light.position;
  let face = pointFace(v);
  let major = max(abs(v.x), max(abs(v.y), abs(v.z)));
  let texelAtP = light.texelWorld * major;
  let m = frame.pointFaces[face];
  let sc = projectShadow(m, biasedPos(light, P, Ng, L, texelAtP));
  if (outsideShadow(sc)) { return 1.0; }
  if (light.shadowType < 1.5) {
    return textureSampleCompareLevel(pointShadow, shadowSampler, sc.xy, face, sc.z);
  }
  let size = light.shadowMapSize;
  let a = noise * 2.0 * PI;
  let cs = vec2f(cos(a), sin(a));
  let searchR = (2.0 + 22.0 * light.softness) / size;
  var sum = 0.0;
  var cnt = 0.0;
  for (var i = 0; i < PCF_SAMPLES; i++) {
    let uv = sc.xy + rot(POISSON[i], cs) * searchR;
    let c = vec2i(clamp(uv * size, vec2f(0.0), vec2f(size - 1.0)));
    let d = textureLoad(pointShadow, c, face, 0);
    if (d < sc.z) { sum += d; cnt += 1.0; }
  }
  if (cnt < 0.5) { return 1.0; }
  let r = clamp(penumbraTexels(light, sc.z, sum / cnt, texelAtP), 1.0, 32.0) / size;
  var lit = 0.0;
  for (var i = 0; i < PCF_SAMPLES; i++) {
    lit += textureSampleCompareLevel(pointShadow, shadowSampler, sc.xy + rot(POISSON[i], cs) * r, face, sc.z);
  }
  return lit / f32(PCF_SAMPLES);
}

// ── 하이트필드 자기그림자 (붓자국이 옆 붓자국에 드리우는 그림자) ──
// 그림 면은 높이장이므로 광원 방향으로 높이장을 직접 레이마칭한다.
// SDF 소프트섀도우와 같은 방식으로 (높이 여유 / 거리) 최소값으로 반그림자를 근사.
fn microShadow(uv: vec2f, h0: f32, L: vec3f, light: Light) -> f32 {
  if (L.z <= 0.0) { return 0.0; }
  let hs = max(frame.heightScale, 1e-5);
  // 월드 길이 1 당 (u, v, 정규화 높이) 변화량
  let d = vec3f(L.x / frame.paintSize.x, -L.y / frame.paintSize.y, L.z / hs);
  let start = h0 + 0.002;
  let tMax = min((1.0 - start) / d.z, 0.06);
  if (tMax <= 0.0) { return 1.0; }
  let texel = frame.paintSize.x / f32(textureDimensions(heightTex).x);
  let steps = i32(frame.microSteps);
  let k = select(mix(48.0, 5.0, light.softness), 400.0, light.shadowType < 1.5);
  var res = 1.0;
  for (var i = 1; i <= steps; i++) {
    let f = f32(i) / f32(steps);
    let t = texel * 0.75 + tMax * f * f;
    let p = vec3f(uv, start) + d * t;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { break; }
    let dh = (p.z - paintHeight(p.xy)) * hs; // 표면 위 여유 높이 (m)
    res = min(res, k * dh / t);
    if (res <= 0.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

// 벽-캔버스 접촉부의 간단한 해석적 AO (앰비언트 전용)
fn wallContactAO(P: vec3f) -> f32 {
  let q = abs(P.xy) - frame.canvasOuter.xy;
  let outside = length(max(q, vec2f(0.0)));
  let inside = max(q.x, q.y) < 0.0;
  return select(mix(0.55, 1.0, smoothstep(0.0, 0.06, outside)), 0.35, inside);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  let duvx = dpdx(in.uv);
  let duvy = dpdy(in.uv);
  let P = in.worldPos;
  let noise = ign(in.clip.xy);

  var Ng = normalize(in.normal);
  var N = Ng;
  var albedo = vec3f(0.5);
  var rough = 0.9;
  var ao = 1.0;
  var h0 = 0.0;
  let isPaint = in.material == MAT_PAINT;

  switch (in.material) {
    case 0u: {
      albedo = wallAlbedo(P.xy);
      N = wallNormal(P.xy);
      rough = 0.92;
      ao = wallContactAO(P);
    }
    case 1u: {
      albedo = floorAlbedo(P.xz);
      rough = 0.5;
      ao = mix(0.6, 1.0, smoothstep(0.0, 0.35, P.z));
    }
    case 2u: {
      albedo = textureSampleGrad(colorTex, linSampler, in.uv, duvx, duvy).rgb * 0.92;
      rough = min(paintRoughness(frame.gloss) + 0.1, 1.0);
    }
    case 3u: {
      albedo = linenAlbedo(in.uv);
      rough = 0.95;
    }
    default: {
      albedo = textureSampleGrad(colorTex, linSampler, in.uv, duvx, duvy).rgb;
      let nm = textureSampleGrad(normalTex, linSampler, in.uv, duvx, duvy);
      N = normalize(nm.xyz);
      ao = mix(1.0, nm.w, frame.aoStrength);
      rough = paintRoughness(frame.gloss);
      h0 = paintHeight(in.uv);
      Ng = vec3f(0.0, 0.0, 1.0);
    }
  }

  let f0 = vec3f(0.04);
  let V = normalize(frame.cameraPos - P);
  var color = albedo * envColor(N, frame.ambient) * ao;

  for (var i = 0u; i < 3u; i++) {
    let light = frame.lights[i];
    if (light.enabled < 0.5) { continue; }
    let ls = evalLight(light, P);
    if (dot(N, ls.L) <= 0.0) { continue; }
    if (max(ls.radiance.x, max(ls.radiance.y, ls.radiance.z)) <= 0.0) { continue; }

    var sh = 1.0;
    if (light.shadowType > 0.5) {
      let sp = select(P, in.basePos, isPaint);
      if (i == 0u) {
        sh = shadow2D(dirShadow, light, sp, Ng, ls.L, noise);
      } else if (i == 1u) {
        sh = shadow2D(spotShadow, light, sp, Ng, ls.L, noise);
      } else {
        sh = shadowPoint(light, sp, Ng, ls.L, noise);
      }
      if (isPaint && frame.microShadow > 0.5) {
        sh *= microShadow(in.uv, h0, ls.L, light);
      }
      sh = mix(1.0, sh, light.shadowStrength);
    }
    color += brdf(N, V, ls.L, albedo, rough, f0) * ls.radiance * sh;
  }

  return vec4f(color, 1.0);
}
