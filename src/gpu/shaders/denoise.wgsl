// ─────────────────────────────────────────────────────────────
// 패스트레이서 디노이저 (SVGF 계열, compute)
//  reproject : 카메라만 움직였을 때 이전 누적값을 새 시점으로 재투영 (시간축 재사용)
//  prepare   : 누적값 / 알베도 = 조명 성분(irradiance) + 휘도 분산 추정
//  atrous    : 에지 보존 À-Trous 웨이블릿 (노멀 · 평면거리 · 휘도 분산으로 가중) × N 회
//  finalize  : 알베도 재곱(remodulation) + 샘플 수에 따른 원본과의 블렌드
// 알베도를 나눈 뒤 흐리므로 그림의 색·붓자국 텍스처는 흐려지지 않는다.
// ─────────────────────────────────────────────────────────────

struct DnParams {
  invViewProj: mat4x4f,
  prevViewProj: mat4x4f,
  prevInvViewProj: mat4x4f,
  cameraPos: vec3f, pixelAngle: f32,      // pixelAngle: 픽셀 1개의 시야각 (거리 1 에서의 크기)
  prevCameraPos: vec3f, maxHistory: f32,
  width: u32, height: u32, stepSize: u32, view: u32, // view: 0 denoised, 1 raw, 2 split
  sigmaL: f32, sigmaN: f32, sigmaZ: f32, strength: f32,
  fadeSpp: f32, pad0: f32, pad1: f32, pad2: f32,
};

@group(0) @binding(0) var<uniform> dn: DnParams;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> moments: array<vec2f>;
@group(0) @binding(3) var<storage, read> gbuf: array<vec4f>;
@group(0) @binding(4) var<storage, read> albedoBuf: array<u32>;
@group(0) @binding(5) var<storage, read> dnIn: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> dnOut: array<vec4f>;
// 재투영 전용
@group(0) @binding(7) var<storage, read> prevGbuf: array<vec4f>;
@group(0) @binding(8) var<storage, read> prevAccum: array<vec4f>;
@group(0) @binding(9) var<storage, read> prevMoments: array<vec2f>;
@group(0) @binding(10) var<storage, read_write> outAccum: array<vec4f>;
@group(0) @binding(11) var<storage, read_write> outMoments: array<vec2f>;

// NaN/Inf 판정. 지수 비트로 검사하므로 fast-math 최적화로 x != x 비교가 사라져도 동작한다
fn finite3(v: vec3f) -> bool {
  return all((bitcast<vec3u>(v) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}

fn finite4(v: vec4f) -> bool {
  return all((bitcast<vec4u>(v) & vec4u(0x7f800000u)) != vec4u(0x7f800000u));
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rayDir(inv: mat4x4f, pixel: vec2f) -> vec3f {
  let px = pixel / vec2f(f32(dn.width), f32(dn.height));
  let ndc = vec2f(px.x * 2.0 - 1.0, 1.0 - px.y * 2.0);
  let nearH = inv * vec4f(ndc, 0.0, 1.0);
  let farH = inv * vec4f(ndc, 1.0, 1.0);
  return normalize(farH.xyz / farH.w - nearH.xyz / nearH.w);
}

fn worldPos(p: vec2i, t: f32) -> vec3f {
  return dn.cameraPos + rayDir(dn.invViewProj, vec2f(p) + 0.5) * t;
}

fn inBounds(p: vec2i) -> bool {
  return p.x >= 0 && p.y >= 0 && p.x < i32(dn.width) && p.y < i32(dn.height);
}

fn pix(p: vec2i) -> u32 {
  return u32(p.y) * dn.width + u32(p.x);
}

fn albedoAt(i: u32) -> vec3f {
  return max(unpack4x8unorm(albedoBuf[i]).rgb, vec3f(0.02));
}

// ── 시간축 재투영 ────────────────────────────────────────────
@compute @workgroup_size(8, 8)
fn reproject(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= dn.width || gid.y >= dn.height) { return; }
  let p = vec2i(gid.xy);
  let idx = pix(p);
  let g = gbuf[idx];
  outAccum[idx] = vec4f(0.0);
  outMoments[idx] = vec2f(0.0);
  if (g.w < 0.0) { return; }

  let P = worldPos(p, g.w);
  let clip = dn.prevViewProj * vec4f(P, 1.0);
  if (clip.w <= 1e-5) { return; }
  let ndc = clip.xy / clip.w;
  let pp = vec2f((ndc.x * 0.5 + 0.5) * f32(dn.width), (0.5 - ndc.y * 0.5) * f32(dn.height)) - 0.5;
  let base = vec2i(floor(pp));
  let f = fract(pp);
  let tol = g.w * dn.pixelAngle * 3.0 + 0.002;

  var sumW = 0.0;
  var sumMean = vec3f(0.0);
  var sumCount = 0.0;
  var sumMom = vec2f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let q = base + vec2i(i, j);
      if (!inBounds(q)) { continue; }
      let qi = pix(q);
      let pg = prevGbuf[qi];
      if (pg.w < 0.0 || dot(pg.xyz, g.xyz) < 0.9) { continue; }
      let Pq = dn.prevCameraPos + rayDir(dn.prevInvViewProj, vec2f(q) + 0.5) * pg.w;
      if (length(Pq - P) > tol) { continue; }
      let pa = prevAccum[qi];
      // 비정상 히스토리는 이어받지 않는다 (NaN 이 시점 이동마다 번지는 것을 차단)
      if (pa.w < 0.5 || !finite4(pa) || !finite4(vec4f(prevMoments[qi], 0.0, 0.0))) { continue; }
      let w = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1);
      sumW += w;
      sumMean += w * pa.rgb / pa.w;
      sumCount += w * pa.w;
      sumMom += w * prevMoments[qi] / pa.w;
    }
  }
  if (sumW < 0.01) { return; }
  // 히스토리 길이를 제한해 시점 의존(스페큘러) 성분의 잔상을 줄인다
  let cnt = min(sumCount / sumW, dn.maxHistory);
  outAccum[idx] = vec4f(sumMean / sumW * cnt, cnt);
  outMoments[idx] = sumMom / sumW * cnt;
}

// ── 1) 알베도 분리 + 분산 추정 ───────────────────────────────
@compute @workgroup_size(8, 8)
fn prepare(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= dn.width || gid.y >= dn.height) { return; }
  let p = vec2i(gid.xy);
  let idx = pix(p);
  let a = accum[idx];
  let n = a.w;
  let g = gbuf[idx];
  if (g.w < 0.0 || n < 0.5) {
    dnOut[idx] = vec4f(a.rgb / max(n, 1.0), 0.0);
    return;
  }
  let alb = albedoAt(idx);
  let irr = a.rgb / n / alb;
  let albL = max(lum(alb), 0.02);

  var variance: f32;
  if (n >= 4.0) {
    // 시간축 모멘트: 표본 분산 / n = 평균의 분산
    let m = moments[idx] / n;
    variance = max(m.y - m.x * m.x, 0.0) / n / (albL * albL);
  } else {
    // 샘플이 적을 때는 주변 7x7 의 공간 분산으로 대체 (과소추정 방지로 크게 잡음)
    var s1 = 0.0;
    var s2 = 0.0;
    var cnt = 0.0;
    for (var y = -3; y <= 3; y++) {
      for (var x = -3; x <= 3; x++) {
        let q = p + vec2i(x, y);
        if (!inBounds(q)) { continue; }
        let qi = pix(q);
        let aq = accum[qi];
        if (gbuf[qi].w < 0.0 || aq.w < 0.5) { continue; }
        let l = lum(aq.rgb / aq.w / albedoAt(qi));
        s1 += l;
        s2 += l * l;
        cnt += 1.0;
      }
    }
    let mean = s1 / max(cnt, 1.0);
    variance = max(s2 / max(cnt, 1.0) - mean * mean, 0.0) * 4.0 / n;
  }
  let o = vec4f(irr, variance);
  dnOut[idx] = select(vec4f(0.0), o, finite4(o));
}

// ── 2) À-Trous 웨이블릿 (stepSize = 1, 2, 4, 8, 16) ─────────
@compute @workgroup_size(8, 8)
fn atrous(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= dn.width || gid.y >= dn.height) { return; }
  let p = vec2i(gid.xy);
  let idx = pix(p);
  let c = dnIn[idx];
  let g = gbuf[idx];
  if (g.w < 0.0 || !finite4(c)) {
    dnOut[idx] = c;
    return;
  }
  let Pp = worldPos(p, g.w);
  let np = g.xyz;
  let lp = lum(c.rgb);
  let stride = i32(dn.stepSize);
  let footprint = g.w * dn.pixelAngle * f32(stride);

  // 분산을 3x3 로 살짝 평활해 휘도 가중치를 안정화
  var vsum = 0.0;
  var vcnt = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = p + vec2i(x, y);
      if (inBounds(q)) {
        vsum += dnIn[pix(q)].w;
        vcnt += 1.0;
      }
    }
  }
  let sigL = dn.sigmaL * sqrt(vsum / vcnt) + 1e-4;

  let h = array<f32, 3>(0.375, 0.25, 0.0625);
  var sumC = c.rgb * (h[0] * h[0]);
  var sumV = c.w * (h[0] * h[0]) * (h[0] * h[0]);
  var sumW = h[0] * h[0];

  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) { continue; }
      let q = p + vec2i(x, y) * stride;
      if (!inBounds(q)) { continue; }
      let qi = pix(q);
      let gq = gbuf[qi];
      if (gq.w < 0.0) { continue; }
      let cq = dnIn[qi];
      if (!finite4(cq)) { continue; }
      let wn = pow(max(dot(np, gq.xyz), 0.0), dn.sigmaN);
      let dz = abs(dot(np, worldPos(q, gq.w) - Pp));
      let wz = exp(-dz / (dn.sigmaZ * footprint + 1e-5));
      let wl = exp(-abs(lum(cq.rgb) - lp) / sigL);
      let w = h[abs(x)] * h[abs(y)] * wn * wz * wl;
      sumC += cq.rgb * w;
      sumV += cq.w * w * w;
      sumW += w;
    }
  }
  dnOut[idx] = vec4f(sumC / sumW, sumV / (sumW * sumW));
}

// ── 3) 알베도 재곱 + 원본과 블렌드 ───────────────────────────
@compute @workgroup_size(8, 8)
fn finalize(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= dn.width || gid.y >= dn.height) { return; }
  let p = vec2i(gid.xy);
  let idx = pix(p);
  let a = accum[idx];
  let n = a.w;
  let raw = a.rgb / max(n, 1.0);
  var c = raw;
  if (gbuf[idx].w >= 0.0 && n >= 0.5) {
    let filtered = dnIn[idx].rgb * albedoAt(idx);
    let blend = dn.strength * (1.0 - smoothstep(0.0, dn.fadeSpp, n));
    c = mix(raw, filtered, blend);
  }
  let mid = i32(dn.width / 2u);
  if (dn.view == 1u || (dn.view == 2u && p.x > mid)) { c = raw; }
  if (dn.view == 2u && p.x == mid) { c = vec3f(1.0, 0.8, 0.5); }
  // 최종 방어선: 비정상 값은 원본 → 그것도 비정상이면 0
  if (!finite3(c)) { c = select(vec3f(0.0), raw, finite3(raw)); }
  dnOut[idx] = vec4f(c, 1.0);
}
