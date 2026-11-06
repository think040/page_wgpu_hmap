import fullscreenWGSL from "./shaders/fullscreen.wgsl";
import mipmapWGSL from "./shaders/mipmap.wgsl";

/** 다운로드 진행률을 보고하면서 이미지를 ImageBitmap 으로 디코드 */
export async function fetchBitmap(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  maxSize?: number,
): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 로드 실패 (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let blob: Blob;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
    blob = new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") ?? "" });
  } else {
    blob = await res.blob();
  }
  // 하이트맵 값이 색공간 변환으로 왜곡되지 않도록 변환을 끈다
  const options: ImageBitmapOptions = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
  if (maxSize) {
    // 저사양 프리셋: 디코드 단계에서 바로 축소해 GPU 메모리를 줄인다 (정사각 에셋 기준, 높이는 비율 유지)
    return createImageBitmap(blob, { ...options, resizeWidth: maxSize, resizeQuality: "high" });
  }
  return createImageBitmap(blob, options);
}

export function mipLevelCount(w: number, h: number): number {
  return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

export function textureFromBitmap(
  device: GPUDevice,
  bitmap: ImageBitmap,
  format: GPUTextureFormat,
  withMips: boolean,
  label: string,
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [bitmap.width, bitmap.height],
    format,
    mipLevelCount: withMips ? mipLevelCount(bitmap.width, bitmap.height) : 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
  return texture;
}

/** 렌더 패스 기반 밉맵 생성기 (포맷별 파이프라인 캐시) */
export class MipGenerator {
  private module: GPUShaderModule;
  private sampler: GPUSampler;
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(private device: GPUDevice) {
    this.module = device.createShaderModule({ label: "mipmap", code: fullscreenWGSL + mipmapWGSL });
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        label: `mipmap ${format}`,
        layout: "auto",
        vertex: { module: this.module, entryPoint: "vsFullscreen" },
        fragment: { module: this.module, entryPoint: "fsMip", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.pipelines.set(format, p);
    }
    return p;
  }

  generate(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    const pipeline = this.pipeline(texture.format);
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
  }
}
