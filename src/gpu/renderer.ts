import { mat4, type Mat4 } from "wgpu-matrix";
import type { QualityLevel, RenderMode, RenderSettings, SceneState, SceneStore } from "@/scene/state";
import type { QualityProfile } from "@/scene/quality";
import { CANVAS, SCENE, STATIC_STRIDE, buildCasterMesh, buildPaintingGrid, buildStaticMesh } from "./geometry";
import {
  FRAME_FLOATS,
  buildGizmoLines,
  packFrame,
  resolveLights,
  type LightAnimation,
  type ResolvedLights,
} from "./lights";
import { OrbitControls, cameraEye, effectiveFovY } from "./controls";
import { MipGenerator, fetchBitmap, mipLevelCount, textureFromBitmap } from "./textures";

import commonWGSL from "./shaders/common.wgsl";
import sceneWGSL from "./shaders/scene.wgsl";
import shadowWGSL from "./shaders/shadow.wgsl";
import gizmoWGSL from "./shaders/gizmo.wgsl";
import fullscreenWGSL from "./shaders/fullscreen.wgsl";
import tonemapWGSL from "./shaders/tonemap.wgsl";
import preprocessWGSL from "./shaders/preprocess.wgsl";
import pathtraceWGSL from "./shaders/pathtrace.wgsl";
import denoiseWGSL from "./shaders/denoise.wgsl";

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const SHADOW_FORMAT: GPUTextureFormat = "depth32float";
const SHADOW_SLOT = 256; // dynamic offset 정렬
const SHADOW_SLOTS = 8; // 0: directional, 1: spot, 2..7: point 6면
const MAX_GIZMO_VERTS = 1024;
const DN_SLOT = 512; // 디노이저 파라미터 슬롯 (256 정렬, 구조체 272B)
const DN_SLOTS = 6; // 0: prepare/finalize/reproject, 1..5: À-Trous 반복
const DN_FLOATS = 68;
const MAX_HISTORY = 16; // 재투영 시 이어받는 최대 샘플 수

export interface RendererStats {
  fps: number;
  idle: boolean;
  mode: RenderMode;
  quality: QualityLevel;
  samples: number;
  rtWidth: number;
  rtHeight: number;
}

export interface RendererOptions {
  colorUrl: string;
  heightUrl: string;
  quality: QualityProfile;
  onProgress?: (ratio: number, label: string) => void;
  onStats?: (stats: RendererStats) => void;
  onError?: (message: string) => void;
}

async function compile(device: GPUDevice, label: string, code: string): Promise<GPUShaderModule> {
  const shader = device.createShaderModule({ label, code });
  const info = await shader.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length) {
    throw new Error(
      `WGSL 컴파일 오류 (${label}):\n` + errors.map((e) => `  ${e.lineNum}:${e.linePos} ${e.message}`).join("\n"),
    );
  }
  return shader;
}

/** 패스트레이싱 누적값에 영향을 주는 렌더 설정 (노출·디노이저 설정은 누적을 초기화하지 않는다) */
function ptSceneChanged(a: RenderSettings, b: RenderSettings) {
  return (
    a.mode !== b.mode ||
    a.heightScale !== b.heightScale ||
    a.gloss !== b.gloss ||
    a.ambient !== b.ambient ||
    a.ptMaxBounces !== b.ptMaxBounces
  );
}

interface PTBuffers {
  w: number;
  h: number;
  accum: [GPUBuffer, GPUBuffer];
  moments: [GPUBuffer, GPUBuffer];
  gbuf: [GPUBuffer, GPUBuffer];
  albedo: GPUBuffer;
  dnA: GPUBuffer;
  dnB: GPUBuffer;
  display: GPUBuffer;
}

interface CameraSnapshot {
  viewProj: Mat4;
  invViewProj: Mat4;
  pos: ArrayLike<number>;
}

export class PaintingRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private canvasFormat!: GPUTextureFormat;
  private controls: OrbitControls;
  private resizeObserver?: ResizeObserver;
  private disposed = false;
  private raf = 0;
  private active = true;
  private readonly q: QualityProfile;

  // 리소스
  private frameBuffer!: GPUBuffer;
  private frameData = new Float32Array(FRAME_FLOATS);
  private shadowViewBuffer!: GPUBuffer;
  private postBuffer!: GPUBuffer;
  private rtParamBuffer!: GPUBuffer;
  private dnParamBuffer!: GPUBuffer;
  private dnData = new ArrayBuffer(DN_FLOATS * 4);
  private staticVB!: GPUBuffer;
  private staticIB!: GPUBuffer;
  private staticCount = 0;
  private casterVB!: GPUBuffer;
  private casterIB!: GPUBuffer;
  private casterCount = 0;
  private gridVB!: GPUBuffer;
  private gridIB!: GPUBuffer;
  private gridCount = 0;
  private gizmoVB!: GPUBuffer;
  private gizmoCount = 0;

  private colorTex!: GPUTexture;
  private srcHeightTex!: GPUTexture;
  private heightTex!: GPUTexture;
  private normalTex!: GPUTexture;
  private linearSampler!: GPUSampler;
  private shadowSampler!: GPUSampler;
  private shadowMaps: { dir?: GPUTexture; spot?: GPUTexture; point?: GPUTexture } = {};
  private shadowSizes = [0, 0, 0];

  private hdrTex?: GPUTexture;
  private msaaTex?: GPUTexture;
  private depthTex?: GPUTexture;
  private pt?: PTBuffers;
  private ptCur = 0;

  // 파이프라인
  private mainLayout!: GPUBindGroupLayout;
  private shadowLayout!: GPUBindGroupLayout;
  private staticPipeline!: GPURenderPipeline;
  private paintingPipeline!: GPURenderPipeline;
  private gizmoPipeline!: GPURenderPipeline;
  private shadowPipeline!: GPURenderPipeline;
  private tonemapPipeline!: GPURenderPipeline;
  private ptPipeline!: GPUComputePipeline;
  private gbufPipeline!: GPUComputePipeline;
  private reprojectPipeline!: GPUComputePipeline;
  private dnPreparePipeline!: GPUComputePipeline;
  private dnAtrousPipeline!: GPUComputePipeline;
  private dnFinalizePipeline!: GPUComputePipeline;
  private smoothPipeline!: GPUComputePipeline;
  private normalPipeline!: GPUComputePipeline;
  private normalParams!: GPUBuffer;
  private mips!: MipGenerator;

  private mainBindGroup?: GPUBindGroup;
  private shadowBindGroup!: GPUBindGroup;
  private computeGroups = new Map<string, GPUBindGroup>();

  // 상태
  private lastState?: SceneState;
  private shadowsDirty = true;
  private forceRender = true;
  private ptReset = true;
  private ptSample = 0;
  private ptCamera?: CameraSnapshot;
  private builtHeightScale = -1;
  private heightChangedAt = 0;
  private anim: LightAnimation = { dirYaw: 0, pointAzimuth: 0 };
  private lastTime = 0;
  private frameIndex = 0;
  private statsWindow = { frames: 0, start: 0 };

  private constructor(
    private canvas: HTMLCanvasElement,
    private store: SceneStore,
    private opts: RendererOptions,
  ) {
    this.q = opts.quality;
    this.controls = new OrbitControls(canvas, store);
  }

  static async create(canvas: HTMLCanvasElement, store: SceneStore, opts: RendererOptions) {
    const r = new PaintingRenderer(canvas, store, opts);
    try {
      await r.init();
    } catch (e) {
      r.dispose();
      throw e;
    }
    return r;
  }

  // ───────────────────────────── 초기화 ─────────────────────────────
  private async init() {
    if (!navigator.gpu) throw new Error("이 브라우저는 WebGPU 를 지원하지 않습니다.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: this.q.level === "low" ? "low-power" : "high-performance",
    });
    if (!adapter) throw new Error("WebGPU 어댑터를 찾을 수 없습니다.");
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 8),
      },
    });
    this.device = device;
    device.addEventListener("uncapturederror", (e) => {
      const msg = (e as GPUUncapturedErrorEvent).error.message;
      console.error("[WebGPU]", msg);
      this.opts.onError?.(msg);
    });
    device.lost.then((info) => {
      if (!this.disposed) this.opts.onError?.(`GPU 디바이스 손실: ${info.message}`);
    });

    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.canvasFormat, alphaMode: "opaque" });

    // 텍스처 다운로드 (진행률 합산)
    const [colorBmp, heightBmp] = await this.fetchArtwork(this.opts.colorUrl, this.opts.heightUrl, (ratio) =>
      this.opts.onProgress?.(ratio, "텍스처 다운로드"),
    );
    if (this.disposed) {
      colorBmp.close();
      heightBmp.close();
      return;
    }
    this.opts.onProgress?.(1, "셰이더 컴파일");

    this.createSamplersAndBuffers();
    this.createGeometry();

    this.mips = new MipGenerator(device);
    this.uploadArtwork(colorBmp, heightBmp);

    await this.createPipelines();
    if (this.disposed) return;

    this.preprocessHeight();
    this.rebuildNormals(this.store.get().render.heightScale);

    this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    this.resizeObserver.observe(this.canvas);
    this.syncCanvasSize();

    this.lastTime = performance.now();
    this.statsWindow.start = this.lastTime;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** 작품 이미지 두 장을 다운로드 · 디코드 (진행률은 두 파일 평균) */
  private fetchArtwork(colorUrl: string, heightUrl: string, onProgress?: (ratio: number) => void) {
    const progress = [0, 0];
    const report = () => onProgress?.((progress[0] + progress[1]) / 2);
    const maxSize = this.q.textureSize < 2048 ? this.q.textureSize : undefined;
    return Promise.all([
      fetchBitmap(colorUrl, (l, t) => ((progress[0] = l / t), report()), maxSize),
      fetchBitmap(heightUrl, (l, t) => ((progress[1] = l / t), report()), maxSize),
    ]);
  }

  /** 디코드된 이미지를 원본 텍스처로 올린다 (비트맵은 여기서 해제) */
  private uploadArtwork(colorBmp: ImageBitmap, heightBmp: ImageBitmap) {
    this.colorTex = textureFromBitmap(this.device, colorBmp, "rgba8unorm-srgb", true, "colorMap");
    this.srcHeightTex = textureFromBitmap(this.device, heightBmp, "rgba8unorm", false, "heightMap(src)");
    colorBmp.close();
    heightBmp.close();
  }

  private createSamplersAndBuffers() {
    const d = this.device;
    this.linearSampler = d.createSampler({
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: this.q.level === "low" ? 4 : 8,
    });
    this.shadowSampler = d.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" });
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.frameBuffer = d.createBuffer({ label: "frame", size: FRAME_FLOATS * 4, usage: U });
    this.shadowViewBuffer = d.createBuffer({ label: "shadowViews", size: SHADOW_SLOT * SHADOW_SLOTS, usage: U });
    this.postBuffer = d.createBuffer({ label: "post", size: 32, usage: U });
    this.rtParamBuffer = d.createBuffer({ label: "rtParams", size: 32, usage: U });
    this.dnParamBuffer = d.createBuffer({ label: "dnParams", size: DN_SLOT * DN_SLOTS, usage: U });
    this.normalParams = d.createBuffer({ label: "normalParams", size: 16, usage: U });
  }

  private buffer(data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number, label: string) {
    const b = this.device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }

  private createGeometry() {
    const V = GPUBufferUsage.VERTEX;
    const I = GPUBufferUsage.INDEX;
    const s = buildStaticMesh();
    this.staticVB = this.buffer(s.vertices, V, "static.vb");
    this.staticIB = this.buffer(s.indices, I, "static.ib");
    this.staticCount = s.indices.length;
    const c = buildCasterMesh();
    this.casterVB = this.buffer(c.vertices, V, "caster.vb");
    this.casterIB = this.buffer(c.indices, I, "caster.ib");
    this.casterCount = c.indices.length;
    const g = buildPaintingGrid(this.q.gridSegments);
    this.gridVB = this.buffer(g.uvs, V, "grid.vb");
    this.gridIB = this.buffer(g.indices, I, "grid.ib");
    this.gridCount = g.indices.length;
    this.gizmoVB = this.device.createBuffer({
      label: "gizmo.vb",
      size: MAX_GIZMO_VERTS * 24,
      usage: V | GPUBufferUsage.COPY_DST,
    });
  }

  private async createPipelines() {
    const d = this.device;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const F = GPUShaderStage.FRAGMENT;
    const msaa = this.q.msaa;

    this.mainLayout = d.createBindGroupLayout({
      label: "main",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: VF, sampler: { type: "filtering" } },
        { binding: 2, visibility: VF, texture: { sampleType: "float" } },
        { binding: 3, visibility: VF, texture: { sampleType: "float" } },
        { binding: 4, visibility: F, texture: { sampleType: "float" } },
        { binding: 5, visibility: F, sampler: { type: "comparison" } },
        { binding: 6, visibility: F, texture: { sampleType: "depth" } },
        { binding: 7, visibility: F, texture: { sampleType: "depth" } },
        { binding: 8, visibility: F, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      ],
    });
    this.shadowLayout = d.createBindGroupLayout({
      label: "shadow",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 64 },
        },
      ],
    });
    const mainPL = d.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] });

    const [sceneMod, shadowMod, gizmoMod, tonemapMod, ptMod, preMod, dnMod] = await Promise.all([
      compile(d, "scene", commonWGSL + sceneWGSL),
      compile(d, "shadow", shadowWGSL),
      compile(d, "gizmo", commonWGSL + gizmoWGSL),
      compile(d, "tonemap", fullscreenWGSL + tonemapWGSL),
      compile(d, "pathtrace", commonWGSL + pathtraceWGSL),
      compile(d, "preprocess", preprocessWGSL),
      compile(d, "denoise", denoiseWGSL),
    ]);

    const staticBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: STATIC_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
          { shaderLocation: 2, offset: 24, format: "float32x2" },
          { shaderLocation: 3, offset: 32, format: "float32" },
        ],
      },
    ];
    const sceneFragment: GPUFragmentState = {
      module: sceneMod,
      entryPoint: "fsMain",
      targets: [{ format: HDR_FORMAT }],
      constants: { PCF_SAMPLES: this.q.pcfSamples },
    };
    const depthState: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" };

    [this.staticPipeline, this.paintingPipeline, this.gizmoPipeline, this.shadowPipeline, this.tonemapPipeline] =
      await Promise.all([
        d.createRenderPipelineAsync({
          label: "static",
          layout: mainPL,
          vertex: { module: sceneMod, entryPoint: "vsStatic", buffers: staticBuffers },
          fragment: sceneFragment,
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: depthState,
          multisample: { count: msaa },
        }),
        d.createRenderPipelineAsync({
          label: "painting",
          layout: mainPL,
          vertex: {
            module: sceneMod,
            entryPoint: "vsPainting",
            buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
          },
          fragment: sceneFragment,
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: depthState,
          multisample: { count: msaa },
        }),
        d.createRenderPipelineAsync({
          label: "gizmo",
          layout: mainPL,
          vertex: {
            module: gizmoMod,
            entryPoint: "vsGizmo",
            buffers: [
              {
                arrayStride: 24,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: "float32x3" },
                  { shaderLocation: 1, offset: 12, format: "float32x3" },
                ],
              },
            ],
          },
          fragment: { module: gizmoMod, entryPoint: "fsGizmo", targets: [{ format: HDR_FORMAT }] },
          primitive: { topology: "line-list" },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less" },
          multisample: { count: msaa },
        }),
        d.createRenderPipelineAsync({
          label: "shadow",
          layout: d.createPipelineLayout({ bindGroupLayouts: [this.shadowLayout] }),
          vertex: {
            module: shadowMod,
            entryPoint: "vsShadow",
            buffers: [{ arrayStride: STATIC_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: SHADOW_FORMAT,
            depthWriteEnabled: true,
            depthCompare: "less",
            depthBias: 2,
            depthBiasSlopeScale: 1.5,
          },
        }),
        d.createRenderPipelineAsync({
          label: "tonemap",
          layout: "auto",
          vertex: { module: tonemapMod, entryPoint: "vsFullscreen" },
          fragment: { module: tonemapMod, entryPoint: "fsTonemap", targets: [{ format: this.canvasFormat }] },
          primitive: { topology: "triangle-list" },
        }),
      ]);

    const compute = (label: string, module: GPUShaderModule, entryPoint: string) =>
      d.createComputePipelineAsync({ label, layout: "auto", compute: { module, entryPoint } });
    [
      this.ptPipeline,
      this.gbufPipeline,
      this.reprojectPipeline,
      this.dnPreparePipeline,
      this.dnAtrousPipeline,
      this.dnFinalizePipeline,
      this.smoothPipeline,
      this.normalPipeline,
    ] = await Promise.all([
      compute("pathtrace", ptMod, "ptMain"),
      compute("gbuffer", ptMod, "ptGBuffer"),
      compute("reproject", dnMod, "reproject"),
      compute("dn.prepare", dnMod, "prepare"),
      compute("dn.atrous", dnMod, "atrous"),
      compute("dn.finalize", dnMod, "finalize"),
      compute("smoothHeight", preMod, "smoothHeight"),
      compute("buildNormal", preMod, "buildNormal"),
    ]);

    this.shadowBindGroup = d.createBindGroup({
      layout: this.shadowLayout,
      entries: [{ binding: 0, resource: { buffer: this.shadowViewBuffer, size: 64 } }],
    });
  }

  // ───────────────────────────── 하이트맵 전처리 ─────────────────────────────
  private preprocessHeight() {
    const d = this.device;
    const { width, height } = this.srcHeightTex;
    this.heightTex = d.createTexture({
      label: "height(smoothed)",
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.normalTex = d.createTexture({
      label: "normal+ao",
      size: [width, height],
      format: "rgba16float",
      mipLevelCount: mipLevelCount(width, height),
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const bg = d.createBindGroup({
      layout: this.smoothPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.srcHeightTex.createView() },
        { binding: 1, resource: this.heightTex.createView() },
      ],
    });
    const enc = d.createCommandEncoder({ label: "preprocess" });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.smoothPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    this.mips.generate(enc, this.colorTex);
    d.queue.submit([enc.finish()]);
  }

  /** 높이 스케일에 따라 노멀/AO 재계산 (슬라이더 조작 후 디바운스) */
  private rebuildNormals(heightScaleMM: number) {
    const d = this.device;
    const { width, height } = this.heightTex;
    const texel = [CANVAS.paintSize[0] / width, CANVAS.paintSize[1] / height];
    // AO 탐색 반경은 월드 크기가 일정하도록 텍스처 해상도에 비례
    const aoRadius = (16 * width) / 2048;
    d.queue.writeBuffer(this.normalParams, 0, new Float32Array([texel[0], texel[1], heightScaleMM / 1000, aoRadius]));
    const bg = d.createBindGroup({
      layout: this.normalPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: this.heightTex.createView() },
        { binding: 3, resource: this.normalTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 4, resource: { buffer: this.normalParams } },
      ],
    });
    const enc = d.createCommandEncoder({ label: "normals" });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.normalPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    this.mips.generate(enc, this.normalTex);
    d.queue.submit([enc.finish()]);
    this.builtHeightScale = heightScaleMM;
  }

  // ───────────────────────────── 리사이즈 / 타깃 ─────────────────────────────
  private syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.maxDpr);
    const max = this.device.limits.maxTextureDimension2D;
    const w = Math.min(max, Math.max(1, Math.round(this.canvas.clientWidth * dpr)));
    const h = Math.min(max, Math.max(1, Math.round(this.canvas.clientHeight * dpr)));
    if (this.canvas.width !== w || this.canvas.height !== h || !this.hdrTex) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.createTargets();
    }
  }

  private createTargets() {
    const d = this.device;
    const size = [this.canvas.width, this.canvas.height];
    this.hdrTex?.destroy();
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.hdrTex = d.createTexture({
      label: "hdr",
      size,
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.msaaTex =
      this.q.msaa > 1
        ? d.createTexture({
            label: "hdr.msaa",
            size,
            format: HDR_FORMAT,
            sampleCount: this.q.msaa,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          })
        : undefined;
    this.depthTex = d.createTexture({
      label: "depth",
      size,
      format: DEPTH_FORMAT,
      sampleCount: this.q.msaa,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.computeGroups.clear(); // 톤맵 바인드 그룹이 hdr 텍스처를 참조
    this.forceRender = true;
    this.destroyPT(); // 패스트레이서 버퍼도 다시 맞춘다
  }

  private destroyPT() {
    if (!this.pt) return;
    const p = this.pt;
    [...p.accum, ...p.moments, ...p.gbuf, p.albedo, p.dnA, p.dnB, p.display].forEach((b) => b.destroy());
    this.pt = undefined;
    this.computeGroups.clear();
  }

  private ensurePT(state: SceneState): PTBuffers {
    const scale = Math.min(Math.max(state.render.ptScale, 0.1), 1);
    let w = Math.max(1, Math.floor(this.canvas.width * scale));
    let h = Math.max(1, Math.floor(this.canvas.height * scale));
    const limit = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    // 품질 프리셋의 픽셀 수 상한 + 디바이스 한계
    while (w * h > this.q.ptMaxPixels || w * h * 16 > limit) {
      w = Math.max(1, Math.floor(w * 0.9));
      h = Math.max(1, Math.floor(h * 0.9));
    }
    if (this.pt && this.pt.w === w && this.pt.h === h) return this.pt;
    this.destroyPT();
    const n = w * h;
    const S = GPUBufferUsage.STORAGE;
    const make = (label: string, bytes: number, extra = 0) =>
      this.device.createBuffer({ label, size: Math.max(16, n * bytes), usage: S | extra });
    const C = GPUBufferUsage.COPY_DST; // clearBuffer 용
    this.pt = {
      w,
      h,
      accum: [make("pt.accum0", 16, C), make("pt.accum1", 16, C)],
      moments: [make("pt.moments0", 8, C), make("pt.moments1", 8, C)],
      gbuf: [make("pt.gbuf0", 16), make("pt.gbuf1", 16)],
      albedo: make("pt.albedo", 4),
      dnA: make("dn.a", 16),
      dnB: make("dn.b", 16),
      display: make("dn.display", 16),
    };
    this.ptCur = 0;
    this.ptReset = true;
    return this.pt;
  }

  private ensureShadowMaps(state: SceneState) {
    const sizes = [state.directional.shadowResolution, state.spot.shadowResolution, state.point.shadowResolution].map(
      (s) => Math.min(s, this.q.maxShadowResolution, this.device.limits.maxTextureDimension2D),
    );
    const d = this.device;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    let changed = false;
    if (sizes[0] !== this.shadowSizes[0] || !this.shadowMaps.dir) {
      this.shadowMaps.dir?.destroy();
      this.shadowMaps.dir = d.createTexture({ label: "shadow.dir", size: [sizes[0], sizes[0]], format: SHADOW_FORMAT, usage });
      changed = true;
    }
    if (sizes[1] !== this.shadowSizes[1] || !this.shadowMaps.spot) {
      this.shadowMaps.spot?.destroy();
      this.shadowMaps.spot = d.createTexture({ label: "shadow.spot", size: [sizes[1], sizes[1]], format: SHADOW_FORMAT, usage });
      changed = true;
    }
    if (sizes[2] !== this.shadowSizes[2] || !this.shadowMaps.point) {
      this.shadowMaps.point?.destroy();
      this.shadowMaps.point = d.createTexture({
        label: "shadow.point",
        size: [sizes[2], sizes[2], 6],
        format: SHADOW_FORMAT,
        usage,
      });
      changed = true;
    }
    if (changed) {
      this.shadowSizes = sizes;
      this.mainBindGroup = undefined;
      this.shadowsDirty = true;
      this.forceRender = true;
    }
  }

  private getMainBindGroup() {
    if (!this.mainBindGroup) {
      this.mainBindGroup = this.device.createBindGroup({
        label: "main",
        layout: this.mainLayout,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer } },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: this.colorTex.createView() },
          { binding: 3, resource: this.heightTex.createView() },
          { binding: 4, resource: this.normalTex.createView() },
          { binding: 5, resource: this.shadowSampler },
          { binding: 6, resource: this.shadowMaps.dir!.createView() },
          { binding: 7, resource: this.shadowMaps.spot!.createView() },
          { binding: 8, resource: this.shadowMaps.point!.createView({ dimension: "2d-array" }) },
        ],
      });
    }
    return this.mainBindGroup;
  }

  /** auto 레이아웃 파이프라인용 바인드 그룹 캐시 (버퍼 재생성 / 리사이즈 시 비운다) */
  private group(
    key: string,
    pipeline: GPUComputePipeline | GPURenderPipeline,
    entries: [number, GPUBindingResource][],
  ): GPUBindGroup {
    let g = this.computeGroups.get(key);
    if (!g) {
      g = this.device.createBindGroup({
        label: key,
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map(([binding, resource]) => ({ binding, resource })),
      });
      this.computeGroups.set(key, g);
    }
    return g;
  }

  private dnSlot(i: number): GPUBindingResource {
    return { buffer: this.dnParamBuffer, offset: i * DN_SLOT, size: DN_FLOATS * 4 };
  }

  // ───────────────────────────── 프레임 ─────────────────────────────
  private frame = (now: number) => {
    if (this.disposed || !this.active) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    this.controls.update(dt);
    const state = this.store.get();
    const prev = this.lastState;
    this.lastState = state;

    const anyChanged = state !== prev;
    const cameraChanged = !prev || state.camera !== prev.camera;
    let lightsChanged =
      !prev || state.directional !== prev.directional || state.spot !== prev.spot || state.point !== prev.point;
    if (state.directional.enabled && state.directional.autoRotate !== 0) {
      this.anim.dirYaw = (this.anim.dirYaw + state.directional.autoRotate * dt) % 360;
      lightsChanged = true;
    }
    if (state.point.enabled && state.point.autoOrbit !== 0) {
      this.anim.pointAzimuth = (this.anim.pointAzimuth + state.point.autoOrbit * dt) % 360;
      lightsChanged = true;
    }
    let ptSceneDirty = lightsChanged || (!!prev && ptSceneChanged(state.render, prev.render));

    // 높이 스케일 변경 → 잠시 후 노멀/AO 재계산
    let heightRebuilt = false;
    if (state.render.heightScale !== this.builtHeightScale) {
      if (this.heightChangedAt === 0) this.heightChangedAt = now;
      if (now - this.heightChangedAt > 120) {
        this.rebuildNormals(state.render.heightScale);
        this.heightChangedAt = 0;
        heightRebuilt = true;
        ptSceneDirty = true;
      }
    }
    if (lightsChanged) this.shadowsDirty = true;

    this.ensureShadowMaps(state);
    const pathTrace = state.render.mode === "pathtrace";

    if (pathTrace) {
      const pt = this.ensurePT(state);
      if (ptSceneDirty) this.ptReset = true;
      const accumulating = this.ptSample < state.render.ptMaxSamples;
      // 필요할 때만 렌더: 누적 중이거나 무언가 바뀐 경우
      if (!accumulating && !anyChanged && !this.ptReset && !this.forceRender && !heightRebuilt) return;
      const resolved = resolveLights(state, this.anim);
      const cam = this.writeFrameUniforms(state, resolved, now, pt.w, pt.h);
      const enc = this.device.createCommandEncoder({ label: "frame.pt" });
      this.encodePathTrace(enc, state, pt, cam, cameraChanged);
      this.encodeTonemap(enc, state, true);
      this.device.queue.submit([enc.finish()]);
    } else {
      const animating = lightsChanged && !anyChanged; // 자동 회전
      if (!anyChanged && !animating && !this.forceRender && !heightRebuilt) return;
      const resolved = resolveLights(state, this.anim);
      this.writeFrameUniforms(state, resolved, now, this.canvas.width, this.canvas.height);
      const enc = this.device.createCommandEncoder({ label: "frame" });
      if (this.shadowsDirty) {
        this.encodeShadows(enc, resolved);
        this.shadowsDirty = false;
      }
      this.encodeScene(enc, state, resolved);
      this.encodeTonemap(enc, state, false);
      this.device.queue.submit([enc.finish()]);
      // 래스터에서 패스트레이스로 돌아오면 누적을 새로 시작
      this.ptReset = true;
    }
    this.forceRender = false;
    this.frameIndex++;
    this.statsWindow.frames++;
    this.reportStats(now, state);
  };

  private writeFrameUniforms(
    state: SceneState,
    resolved: ResolvedLights,
    now: number,
    width: number,
    height: number,
  ): CameraSnapshot {
    const c = state.camera;
    const aspect = this.canvas.width / this.canvas.height;
    const eye = cameraEye(c);
    const proj = mat4.perspective(effectiveFovY(c.fov, aspect), aspect, 0.02, 30);
    const view = mat4.lookAt(eye, c.target, [0, 1, 0]);
    const viewProj = mat4.multiply(proj, view);
    const invViewProj = mat4.inverse(viewProj);
    const r = state.render;
    packFrame(this.frameData, {
      viewProj,
      invViewProj,
      cameraPos: eye,
      time: now / 1000,
      resolution: [width, height],
      heightScale: r.heightScale / 1000,
      exposure: r.exposure,
      paintMin: CANVAS.paintMin,
      paintSize: CANVAS.paintSize,
      paintZ: CANVAS.zFront,
      ambient: r.ambient,
      aoStrength: r.aoStrength,
      microShadow: r.microShadow,
      microSteps: r.microSteps,
      gloss: r.gloss,
      frameIndex: this.frameIndex,
      floorY: SCENE.floorY,
      canvasOuter: [CANVAS.hw, CANVAS.hh, CANVAS.zBack, CANVAS.zFront],
      resolved,
    });
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
    return { viewProj, invViewProj, pos: eye };
  }

  private encodeShadows(enc: GPUCommandEncoder, resolved: ResolvedLights) {
    const q = this.device.queue;
    const [dirL, spotL] = resolved.lights;
    q.writeBuffer(this.shadowViewBuffer, 0 * SHADOW_SLOT, dirL.viewProj as Float32Array<ArrayBuffer>);
    q.writeBuffer(this.shadowViewBuffer, 1 * SHADOW_SLOT, spotL.viewProj as Float32Array<ArrayBuffer>);
    resolved.pointFaces.forEach((m, k) =>
      q.writeBuffer(this.shadowViewBuffer, (2 + k) * SHADOW_SLOT, m as Float32Array<ArrayBuffer>),
    );

    const draw = (view: GPUTextureView, slot: number) => {
      const pass = enc.beginRenderPass({
        label: `shadow.${slot}`,
        colorAttachments: [],
        depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      pass.setPipeline(this.shadowPipeline);
      pass.setBindGroup(0, this.shadowBindGroup, [slot * SHADOW_SLOT]);
      pass.setVertexBuffer(0, this.casterVB);
      pass.setIndexBuffer(this.casterIB, "uint32");
      pass.drawIndexed(this.casterCount);
      pass.end();
    };

    if (resolved.castsShadow[0]) draw(this.shadowMaps.dir!.createView(), 0);
    if (resolved.castsShadow[1]) draw(this.shadowMaps.spot!.createView(), 1);
    if (resolved.castsShadow[2]) {
      for (let k = 0; k < 6; k++) {
        draw(this.shadowMaps.point!.createView({ dimension: "2d", baseArrayLayer: k, arrayLayerCount: 1 }), 2 + k);
      }
    }
  }

  private encodeScene(enc: GPUCommandEncoder, state: SceneState, resolved: ResolvedLights) {
    let gizmo: Float32Array | null = null;
    if (state.render.showGizmos) {
      gizmo = buildGizmoLines(state, resolved);
      const n = Math.min(gizmo.length / 6, MAX_GIZMO_VERTS);
      this.gizmoCount = n;
      if (n > 0) this.device.queue.writeBuffer(this.gizmoVB, 0, gizmo as Float32Array<ArrayBuffer>, 0, n * 6);
    }

    const msaa = this.msaaTex;
    const pass = enc.beginRenderPass({
      label: "scene",
      colorAttachments: [
        {
          view: (msaa ?? this.hdrTex!).createView(),
          resolveTarget: msaa ? this.hdrTex!.createView() : undefined,
          clearValue: { r: 0.02, g: 0.02, b: 0.025, a: 1 },
          loadOp: "clear",
          storeOp: msaa ? "discard" : "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex!.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.setBindGroup(0, this.getMainBindGroup());

    pass.setPipeline(this.paintingPipeline);
    pass.setVertexBuffer(0, this.gridVB);
    pass.setIndexBuffer(this.gridIB, "uint32");
    pass.drawIndexed(this.gridCount);

    pass.setPipeline(this.staticPipeline);
    pass.setVertexBuffer(0, this.staticVB);
    pass.setIndexBuffer(this.staticIB, "uint32");
    pass.drawIndexed(this.staticCount);

    if (gizmo && this.gizmoCount > 0) {
      pass.setPipeline(this.gizmoPipeline);
      pass.setVertexBuffer(0, this.gizmoVB);
      pass.draw(this.gizmoCount);
    }
    pass.end();
  }

  /** 디노이저 / 재투영 파라미터 (슬롯마다 stepSize 만 다름) */
  private writeDenoiseParams(state: SceneState, pt: PTBuffers, cam: CameraSnapshot, prevCam: CameraSnapshot) {
    const f = new Float32Array(this.dnData);
    const u = new Uint32Array(this.dnData);
    const r = state.render;
    f.set(cam.invViewProj, 0);
    f.set(prevCam.viewProj, 16);
    f.set(prevCam.invViewProj, 32);
    f[48] = cam.pos[0];
    f[49] = cam.pos[1];
    f[50] = cam.pos[2];
    f[51] = (2 * Math.tan(effectiveFovY(state.camera.fov, pt.w / pt.h) / 2)) / pt.h;
    f[52] = prevCam.pos[0];
    f[53] = prevCam.pos[1];
    f[54] = prevCam.pos[2];
    f[55] = MAX_HISTORY;
    u[56] = pt.w;
    u[57] = pt.h;
    u[59] = r.denoiseView === "denoised" ? 0 : r.denoiseView === "raw" ? 1 : 2;
    f[60] = 4; // sigmaL
    f[61] = 128; // sigmaN
    f[62] = 1; // sigmaZ
    f[63] = r.denoiseStrength;
    f[64] = r.denoiseFadeSpp;
    for (let i = 0; i < DN_SLOTS; i++) {
      u[58] = i === 0 ? 1 : 1 << (i - 1);
      this.device.queue.writeBuffer(this.dnParamBuffer, i * DN_SLOT, this.dnData);
    }
  }

  private encodePathTrace(
    enc: GPUCommandEncoder,
    state: SceneState,
    pt: PTBuffers,
    cam: CameraSnapshot,
    cameraChanged: boolean,
  ) {
    const r = state.render;
    const prevCam = this.ptCamera ?? cam;
    let gbufTarget = -1;
    let reprojectFrom = -1;

    if (this.ptReset) {
      enc.clearBuffer(pt.accum[this.ptCur]);
      enc.clearBuffer(pt.moments[this.ptCur]);
      gbufTarget = this.ptCur;
      this.ptSample = 0;
      this.ptReset = false;
    } else if (cameraChanged) {
      const next = 1 - this.ptCur;
      gbufTarget = next;
      if (r.reprojection) {
        reprojectFrom = this.ptCur;
      } else {
        enc.clearBuffer(pt.accum[next]);
        enc.clearBuffer(pt.moments[next]);
      }
      this.ptCur = next;
      this.ptSample = 0;
    }
    if (gbufTarget >= 0) this.ptCamera = cam;

    const accumulating = this.ptSample < r.ptMaxSamples;
    this.device.queue.writeBuffer(
      this.rtParamBuffer,
      0,
      new Uint32Array([pt.w, pt.h, this.ptSample, r.ptMaxBounces, (Math.random() * 0xffffffff) >>> 0, 0, 0, 0]),
    );
    const useDenoise = r.denoise;
    if (useDenoise || reprojectFrom >= 0) this.writeDenoiseParams(state, pt, cam, prevCam);

    const cur = this.ptCur;
    const wg = [Math.ceil(pt.w / 8), Math.ceil(pt.h / 8)] as const;
    const pass = enc.beginComputePass({ label: "pathtrace" });
    const run = (pipeline: GPUComputePipeline, group: GPUBindGroup) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(wg[0], wg[1]);
    };
    const sceneEntries: [number, GPUBindingResource][] = [
      [0, { buffer: this.frameBuffer }],
      [1, this.linearSampler],
      [2, this.colorTex.createView()],
      [3, this.heightTex.createView()],
      [4, this.normalTex.createView()],
      [6, { buffer: this.rtParamBuffer }],
    ];

    // 1) G-buffer (시점이 바뀐 경우만)
    if (gbufTarget >= 0) {
      run(
        this.gbufPipeline,
        this.group(`gbuf${gbufTarget}`, this.gbufPipeline, [
          ...sceneEntries,
          [8, { buffer: pt.gbuf[gbufTarget] }],
          [9, { buffer: pt.albedo }],
        ]),
      );
    }
    // 2) 시간축 재투영 (이전 누적 → 현재 누적)
    if (reprojectFrom >= 0) {
      const p = reprojectFrom;
      run(
        this.reprojectPipeline,
        this.group(`reproject${p}`, this.reprojectPipeline, [
          [0, this.dnSlot(0)],
          [3, { buffer: pt.gbuf[cur] }],
          [7, { buffer: pt.gbuf[p] }],
          [8, { buffer: pt.accum[p] }],
          [9, { buffer: pt.moments[p] }],
          [10, { buffer: pt.accum[cur] }],
          [11, { buffer: pt.moments[cur] }],
        ]),
      );
    }
    // 3) 1 spp 추가
    if (accumulating) {
      run(
        this.ptPipeline,
        this.group(`pt${cur}`, this.ptPipeline, [
          ...sceneEntries,
          [5, { buffer: pt.accum[cur] }],
          [7, { buffer: pt.moments[cur] }],
        ]),
      );
      this.ptSample++;
    }
    // 4) 디노이즈: prepare → À-Trous × N → finalize
    if (useDenoise) {
      run(
        this.dnPreparePipeline,
        this.group(`prepare${cur}`, this.dnPreparePipeline, [
          [0, this.dnSlot(0)],
          [1, { buffer: pt.accum[cur] }],
          [2, { buffer: pt.moments[cur] }],
          [3, { buffer: pt.gbuf[cur] }],
          [4, { buffer: pt.albedo }],
          [6, { buffer: pt.dnA }],
        ]),
      );
      const iterations = Math.max(1, Math.min(5, Math.round(r.denoiseIterations)));
      for (let i = 0; i < iterations; i++) {
        const [src, dst] = i % 2 === 0 ? [pt.dnA, pt.dnB] : [pt.dnB, pt.dnA];
        run(
          this.dnAtrousPipeline,
          this.group(`atrous${cur}-${i}`, this.dnAtrousPipeline, [
            [0, this.dnSlot(i + 1)],
            [3, { buffer: pt.gbuf[cur] }],
            [5, { buffer: src }],
            [6, { buffer: dst }],
          ]),
        );
      }
      const result = iterations % 2 === 0 ? pt.dnA : pt.dnB;
      run(
        this.dnFinalizePipeline,
        this.group(`finalize${cur}-${iterations % 2}`, this.dnFinalizePipeline, [
          [0, this.dnSlot(0)],
          [1, { buffer: pt.accum[cur] }],
          [3, { buffer: pt.gbuf[cur] }],
          [4, { buffer: pt.albedo }],
          [5, { buffer: result }],
          [6, { buffer: pt.display }],
        ]),
      );
    }
    pass.end();
  }

  private encodeTonemap(enc: GPUCommandEncoder, state: SceneState, pathTrace: boolean) {
    const pt = this.pt;
    const ptW = pathTrace && pt ? pt.w : 1;
    const ptH = pathTrace && pt ? pt.h : 1;
    this.device.queue.writeBuffer(
      this.postBuffer,
      0,
      new Float32Array([
        state.render.exposure,
        pathTrace ? 1 : 0,
        ptW,
        ptH,
        this.canvas.width,
        this.canvas.height,
        0,
        0,
      ]),
    );
    // 패스트레이스: 디노이즈 결과(display) 또는 원본 누적(accum)을 표시
    let source: GPUBuffer;
    let key: string;
    if (pathTrace && pt) {
      source = state.render.denoise ? pt.display : pt.accum[this.ptCur];
      key = state.render.denoise ? "tm.display" : `tm.accum${this.ptCur}`;
    } else {
      source = this.ensureDummyStorage();
      key = "tm.raster";
    }
    const pass = enc.beginRenderPass({
      label: "tonemap",
      colorAttachments: [
        { view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(this.tonemapPipeline);
    pass.setBindGroup(
      0,
      this.group(key, this.tonemapPipeline, [
        [0, { buffer: this.postBuffer }],
        [1, this.hdrTex!.createView()],
        [2, { buffer: source }],
      ]),
    );
    pass.draw(3);
    pass.end();
  }

  private dummyStorage?: GPUBuffer;
  private ensureDummyStorage() {
    this.dummyStorage ??= this.device.createBuffer({ label: "dummy", size: 16, usage: GPUBufferUsage.STORAGE });
    return this.dummyStorage;
  }

  private reportStats(now: number, state: SceneState) {
    const elapsed = now - this.statsWindow.start;
    if (elapsed < 400) return;
    this.emitStats(state, (this.statsWindow.frames * 1000) / elapsed, false);
    this.statsWindow = { frames: 0, start: now };
    clearTimeout(this.idleTimer);
    // 한동안 렌더하지 않으면 idle 로 표시
    this.idleTimer = setTimeout(() => {
      if (!this.disposed) this.emitStats(this.store.get(), 0, true);
      this.statsWindow = { frames: 0, start: performance.now() };
    }, 600);
  }

  private idleTimer?: ReturnType<typeof setTimeout>;

  private emitStats(state: SceneState, fps: number, idle: boolean) {
    this.opts.onStats?.({
      fps,
      idle,
      mode: state.render.mode,
      quality: this.q.level,
      samples: this.ptSample,
      rtWidth: this.pt?.w ?? 0,
      rtHeight: this.pt?.h ?? 0,
    });
  }

  // ───────────────────────────── 외부 API ─────────────────────────────
  /** 화면 밖일 때 렌더 루프를 멈춘다 */
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      this.lastTime = performance.now();
      this.forceRender = true;
      this.raf = requestAnimationFrame(this.frame);
    } else {
      cancelAnimationFrame(this.raf);
    }
  }

  /**
   * 렌더링할 작품(컬러맵 + 하이트맵)을 교체한다.
   * 디바이스 · 파이프라인 · 그림자맵은 그대로 두고, 작품 텍스처와 그 파생물(스무딩 높이, 노멀/AO)만 다시 만든다.
   * 연속으로 호출하면 마지막 요청만 반영된다.
   */
  async setArtwork(colorUrl: string, heightUrl: string): Promise<void> {
    if (this.disposed) return;
    const token = ++this.artworkToken;
    const [colorBmp, heightBmp] = await this.fetchArtwork(colorUrl, heightUrl);
    if (this.disposed || token !== this.artworkToken) {
      colorBmp.close();
      heightBmp.close();
      return;
    }
    const old = [this.colorTex, this.srcHeightTex, this.heightTex, this.normalTex];
    this.uploadArtwork(colorBmp, heightBmp);
    this.preprocessHeight();
    this.rebuildNormals(this.store.get().render.heightScale);
    old.forEach((t) => t.destroy());
    // 이전 텍스처를 참조하던 바인드 그룹을 비우고 다음 프레임에 전부 다시 그린다
    this.mainBindGroup = undefined;
    this.computeGroups.clear();
    this.shadowsDirty = true;
    this.ptReset = true;
    this.forceRender = true;
  }
  private artworkToken = 0;

  /** 터치로 카메라를 조작할지 (모바일에서 스크롤과 충돌 방지) */
  setTouchEnabled(enabled: boolean) {
    this.controls.touchEnabled = enabled;
  }

  resetAccumulation() {
    this.ptReset = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.device?.destroy();
  }
}
