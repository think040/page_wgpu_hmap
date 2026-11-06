// 섀도우맵 깊이 전용 패스. 뷰(방향광/스팟/포인트 6면)마다 dynamic offset 으로 행렬을 바꾼다.

struct ShadowView {
  viewProj: mat4x4f,
};

@group(0) @binding(0) var<uniform> view: ShadowView;

@vertex
fn vsShadow(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return view.viewProj * vec4f(pos, 1.0);
}
