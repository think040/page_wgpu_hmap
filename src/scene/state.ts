// 씬 전체 설정 상태. UI(React)와 렌더러가 같은 Store를 공유한다.
// 렌더러는 매 프레임 store.get()을 읽고, 상태 객체의 identity가 바뀌면
// 그림자맵 재생성 / 패스트레이싱 누적 초기화를 수행한다.

export type Vec3 = [number, number, number];
export type ShadowType = "none" | "hard" | "soft";
export type ShadowResolution = 512 | 1024 | 2048 | 4096;

/** Unity Light 컴포넌트의 공통 항목 */
export interface LightCommon {
  enabled: boolean;
  color: string; // #rrggbb (sRGB)
  useTemperature: boolean;
  temperature: number; // Kelvin
  intensity: number;
  shadowType: ShadowType;
  shadowStrength: number; // 0..1
  shadowResolution: ShadowResolution;
  bias: number; // 섀도우맵 텍셀 단위
  normalBias: number; // 섀도우맵 텍셀 단위
  nearPlane: number;
  softness: number; // 0..1 (광원 크기 → 반그림자 폭)
}

/** 오일러 회전(도). x = pitch(아래가 +), y = yaw(+x 방향이 +) */
export interface Rotation {
  x: number;
  y: number;
}

export interface DirectionalLightState extends LightCommon {
  kind: "directional";
  rotation: Rotation;
  autoRotate: number; // yaw 자동 회전 속도 (도/초)
}

export interface SpotLightState extends LightCommon {
  kind: "spot";
  position: Vec3;
  rotation: Rotation;
  range: number;
  spotAngle: number; // 외곽 전체 각 (도)
  innerSpotAngle: number; // 내부 전체 각 (도)
}

export interface PointLightState extends LightCommon {
  kind: "point";
  orbit: { azimuth: number; elevation: number; radius: number }; // 그림 중심 기준 궤도
  autoOrbit: number; // 방위각 자동 회전 속도 (도/초)
  range: number;
}

export interface CameraState {
  target: Vec3;
  yaw: number; // 도
  pitch: number; // 도
  distance: number;
  fov: number; // 수직 FOV (도)
}

export type RenderMode = "raster" | "pathtrace";
export type QualityLevel = "low" | "medium" | "high";
export type QualitySetting = "auto" | QualityLevel;
export type DenoiseView = "denoised" | "raw" | "split";

export interface RenderSettings {
  mode: RenderMode;
  quality: QualitySetting;
  // 패스트레이서 디노이저 (À-Trous + 시간축 재투영)
  denoise: boolean;
  denoiseStrength: number; // 0..1
  denoiseIterations: number; // 1..5 (커널 폭 1,2,4,8,16)
  denoiseFadeSpp: number; // 이 샘플 수에 가까워질수록 원본 수렴값으로 전환
  denoiseView: DenoiseView;
  reprojection: boolean;
  heightScale: number; // mm, 하이트맵 1.0 에 대응하는 물감 두께
  microShadow: boolean; // 하이트필드 레이마칭 자기그림자
  microSteps: number;
  aoStrength: number;
  ambient: number;
  exposure: number;
  gloss: number; // 0..1
  showGizmos: boolean;
  ptMaxBounces: number;
  ptScale: number; // 패스트레이싱 해상도 배율
  ptMaxSamples: number;
}

export interface SceneState {
  camera: CameraState;
  directional: DirectionalLightState;
  spot: SpotLightState;
  point: PointLightState;
  render: RenderSettings;
}

export type LightKey = "directional" | "spot" | "point";

export const PAINTING_CENTER: Vec3 = [0, 0, 0.05];

/** from → to 를 향하는 회전(도)을 구한다. dirFromRotation 의 역함수 */
export function aimRotation(from: Vec3, to: Vec3): Rotation {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const x = d[0] / len, y = d[1] / len, z = d[2] / len;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -y)));
  const yaw = Math.atan2(x, -z);
  return { x: (pitch * 180) / Math.PI, y: (yaw * 180) / Math.PI };
}

export function defaultCamera(): CameraState {
  return { target: [0, 0, 0.05], yaw: 14, pitch: 4, distance: 1.75, fov: 38 };
}

export function createDefaultState(): SceneState {
  const spotPos: Vec3 = [1.05, 1.25, 1.55];
  return {
    camera: defaultCamera(),
    directional: {
      kind: "directional",
      enabled: true,
      color: "#fff1dc",
      useTemperature: false,
      temperature: 5200,
      intensity: 1.6,
      shadowType: "soft",
      shadowStrength: 1,
      shadowResolution: 2048,
      bias: 1,
      normalBias: 1.5,
      nearPlane: 0.1,
      softness: 0.2,
      // 왼쪽 위에서 비스듬히 스치는 레이킹 라이트 → 질감 강조
      rotation: { x: 28, y: 68 },
      autoRotate: 0,
    },
    spot: {
      kind: "spot",
      enabled: true,
      color: "#ffffff",
      useTemperature: true,
      temperature: 3600,
      intensity: 2.4,
      shadowType: "soft",
      shadowStrength: 1,
      shadowResolution: 2048,
      bias: 1,
      normalBias: 1.5,
      nearPlane: 0.05,
      softness: 0.35,
      position: spotPos,
      rotation: aimRotation(spotPos, PAINTING_CENTER),
      range: 6,
      spotAngle: 42,
      innerSpotAngle: 24,
    },
    point: {
      kind: "point",
      enabled: true,
      color: "#cfe0ff",
      useTemperature: false,
      temperature: 7500,
      intensity: 0.35,
      shadowType: "soft",
      shadowStrength: 0.9,
      shadowResolution: 1024,
      bias: 1,
      normalBias: 1.5,
      nearPlane: 0.05,
      softness: 0.4,
      orbit: { azimuth: -40, elevation: 10, radius: 1.4 },
      autoOrbit: 0,
      range: 5,
    },
    render: {
      mode: "raster",
      quality: "auto",
      denoise: true,
      denoiseStrength: 1,
      denoiseIterations: 5,
      denoiseFadeSpp: 256,
      denoiseView: "denoised",
      reprojection: true,
      heightScale: 5,
      microShadow: true,
      microSteps: 32,
      aoStrength: 0.8,
      ambient: 0.08,
      exposure: 1.0,
      gloss: 0.45,
      showGizmos: true,
      ptMaxBounces: 3,
      ptScale: 0.5,
      ptMaxSamples: 2048,
    },
  };
}

type Listener = () => void;

export class Store<T> {
  private state: T;
  private listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set = (updater: (prev: T) => T): void => {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export type SceneStore = Store<SceneState>;

export function patchLight<K extends LightKey>(
  store: SceneStore,
  key: K,
  patch: Partial<SceneState[K]>,
): void {
  store.set((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
}

export function patchRender(store: SceneStore, patch: Partial<RenderSettings>): void {
  store.set((s) => ({ ...s, render: { ...s.render, ...patch } }));
}

export function patchCamera(store: SceneStore, patch: Partial<CameraState>): void {
  store.set((s) => ({ ...s, camera: { ...s.camera, ...patch } }));
}
