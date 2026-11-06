// 풀스크린 삼각형 (tonemap / mipmap 공용, 다른 셰이더 앞에 붙여 사용)

struct FullscreenOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsFullscreen(@builtin(vertex_index) vi: u32) -> FullscreenOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FullscreenOut;
  o.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
