// HDR → 화면. mode 0: 래스터 HDR 텍스처, mode 1: 패스트레이서 누적 버퍼
// (fullscreen.wgsl 뒤에 붙여 사용)

struct Post {
  exposure: f32,
  mode: f32,
  rtWidth: f32,
  rtHeight: f32,
  outWidth: f32,
  outHeight: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> accum: array<vec4f>;

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn accumAt(p: vec2i) -> vec3f {
  let w = i32(post.rtWidth);
  let h = i32(post.rtHeight);
  let q = clamp(p, vec2i(0), vec2i(w - 1, h - 1));
  let v = accum[q.y * w + q.x];
  return v.rgb / max(v.a, 1.0);
}

@fragment
fn fsTonemap(in: FullscreenOut) -> @location(0) vec4f {
  var hdr: vec3f;
  if (post.mode < 0.5) {
    hdr = textureLoad(hdrTex, vec2i(in.clip.xy), 0).rgb;
  } else {
    // 패스트레이서 해상도가 화면보다 작을 수 있으므로 bilinear 업샘플
    let p = in.uv * vec2f(post.rtWidth, post.rtHeight) - 0.5;
    let i = vec2i(floor(p));
    let f = fract(p);
    let a = accumAt(i);
    let b = accumAt(i + vec2i(1, 0));
    let c = accumAt(i + vec2i(0, 1));
    let d = accumAt(i + vec2i(1, 1));
    hdr = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  if (any((bitcast<vec3u>(hdr) & vec3u(0x7f800000u)) == vec3u(0x7f800000u))) { hdr = vec3f(0.0); }
  var c = aces(hdr * post.exposure);
  c = linearToSrgb(c);
  // 8bit 밴딩 방지 디더
  let n = fract(sin(dot(in.clip.xy, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += n / 255.0;
  return vec4f(c, 1.0);
}
