// ─────────────────────────────────────────────────────────────
// 하이트맵 전처리 (compute)
//  1) smoothHeight : 8bit 하이트맵의 계단(256단계) 완화 + 가장자리 페이드
//  2) buildNormal  : Sobel 노멀 + 하이트필드 Horizon AO
// ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var srcHeight: texture_2d<f32>;
@group(0) @binding(1) var outHeight: texture_storage_2d<rgba16float, write>;

fn srcAt(p: vec2i, size: vec2i) -> f32 {
  return textureLoad(srcHeight, clamp(p, vec2i(0), size - 1), 0).r;
}

@compute @workgroup_size(8, 8)
fn smoothHeight(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(srcHeight));
  let p = vec2i(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }

  // 5x5 가우시안 (1 4 6 4 1)
  let w = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  var sum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      sum += srcAt(p + vec2i(x, y), size) * w[x + 2] * w[y + 2];
    }
  }
  var h = sum / 256.0;

  // 캔버스 모서리(베벨)와 자연스럽게 이어지도록 가장자리에서 0 으로 페이드
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  h *= smoothstep(0.0, 0.008, e);

  textureStore(outHeight, p, vec4f(h, 0.0, 0.0, 1.0));
}

struct PreParams {
  texelWorld: vec2f,   // 텍셀 1개의 월드 크기 (m)
  heightScale: f32,    // 높이 1.0 의 월드 두께 (m)
  aoRadius: f32,       // AO 탐색 반경 (텍셀)
};

@group(0) @binding(2) var inHeight: texture_2d<f32>;
@group(0) @binding(3) var outNormal: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: PreParams;

fn hAt(p: vec2i, size: vec2i) -> f32 {
  return textureLoad(inHeight, clamp(p, vec2i(0), size - 1), 0).r;
}

@compute @workgroup_size(8, 8)
fn buildNormal(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(inHeight));
  let p = vec2i(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }

  let tl = hAt(p + vec2i(-1, -1), size);
  let t  = hAt(p + vec2i( 0, -1), size);
  let tr = hAt(p + vec2i( 1, -1), size);
  let l  = hAt(p + vec2i(-1,  0), size);
  let r  = hAt(p + vec2i( 1,  0), size);
  let bl = hAt(p + vec2i(-1,  1), size);
  let b  = hAt(p + vec2i( 0,  1), size);
  let br = hAt(p + vec2i( 1,  1), size);

  // 텍셀당 높이 변화 (이미지 x+, 이미지 y+ = 아래)
  let gu = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0;
  let gv = ((bl + 2.0 * b + br) - (tl + 2.0 * t + tr)) / 8.0;
  let dzdx = gu * params.heightScale / params.texelWorld.x;
  let dzdDown = gv * params.heightScale / params.texelWorld.y;
  // 월드 y = 이미지 아래의 반대 → N = (-dz/dx, -dz/dy, 1) = (-dzdx, +dzdDown, 1)
  let N = normalize(vec3f(-dzdx, dzdDown, 1.0));

  // Horizon based AO: 8 방향으로 지평선 고도각 탐색
  let h0 = hAt(p, size);
  let dists = array<f32, 6>(1.0, 2.0, 4.0, 7.0, 11.0, 16.0);
  var occ = 0.0;
  for (var k = 0; k < 8; k++) {
    let ang = f32(k) * (PI_PRE / 4.0);
    let dir = vec2f(cos(ang), sin(ang));
    var maxSin = 0.0;
    for (var s = 0; s < 6; s++) {
      let dist = dists[s] * params.aoRadius / 16.0;
      let q = p + vec2i(round(dir * dist));
      let dh = (hAt(q, size) - h0) * params.heightScale;
      let horiz = dist * params.texelWorld.x;
      let sinH = dh / sqrt(dh * dh + horiz * horiz);
      maxSin = max(maxSin, sinH);
    }
    occ += maxSin;
  }
  let ao = clamp(1.0 - occ / 8.0, 0.0, 1.0);

  textureStore(outNormal, p, vec4f(N, ao));
}

const PI_PRE: f32 = 3.14159265359;
