// 조명 기즈모 (라인). common.wgsl 뒤에 이어 붙여 컴파일된다.

@group(0) @binding(0) var<uniform> frame: Frame;

struct GizmoOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vsGizmo(@location(0) pos: vec3f, @location(1) color: vec3f) -> GizmoOut {
  var o: GizmoOut;
  o.clip = frame.viewProj * vec4f(pos, 1.0);
  o.color = color;
  return o;
}

@fragment
fn fsGizmo(in: GizmoOut) -> @location(0) vec4f {
  return vec4f(in.color * 1.6, 1.0);
}
