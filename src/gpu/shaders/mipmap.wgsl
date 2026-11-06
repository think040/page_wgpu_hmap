// 밉맵 생성: 이전 레벨을 bilinear 로 다운샘플 (fullscreen.wgsl 뒤에 붙여 사용)

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;

@fragment
fn fsMip(in: FullscreenOut) -> @location(0) vec4f {
  return textureSampleLevel(srcTex, srcSampler, in.uv, 0.0);
}
