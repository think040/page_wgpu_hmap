// 품질 프리셋. GPU 리소스 크기를 결정하는 항목(프로필)과
// 사용자가 이후에도 바꿀 수 있는 기본값(applyQualityDefaults)으로 나뉜다.

import type { QualityLevel, QualitySetting, SceneState, ShadowResolution } from "./state";

export interface QualityProfile {
  level: QualityLevel;
  maxDpr: number;
  msaa: 1 | 4;
  gridSegments: number; // 그림 면 그리드
  textureSize: number; // 컬러/하이트맵 로드 크기
  pcfSamples: number; // PCSS 샘플 수 (WGSL override 상수)
  ptMaxPixels: number; // 패스트레이서 내부 해상도 상한 (픽셀 수)
  maxShadowResolution: ShadowResolution;
  /** 패스트레이싱을 저품질로만 허용하고 경고를 띄운다 */
  ptWarning: boolean;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  high: {
    level: "high",
    maxDpr: 2,
    msaa: 4,
    gridSegments: 512,
    textureSize: 2048,
    pcfSamples: 16,
    ptMaxPixels: 1_300_000,
    maxShadowResolution: 4096,
    ptWarning: false,
  },
  medium: {
    level: "medium",
    maxDpr: 1.5,
    msaa: 4,
    gridSegments: 384,
    textureSize: 2048,
    pcfSamples: 12,
    ptMaxPixels: 500_000,
    maxShadowResolution: 2048,
    ptWarning: true,
  },
  low: {
    level: "low",
    maxDpr: 1.25,
    msaa: 1,
    gridSegments: 256,
    textureSize: 1024,
    pcfSamples: 8,
    ptMaxPixels: 160_000,
    maxShadowResolution: 1024,
    ptWarning: true,
  },
};

export const QUALITY_LABEL: Record<QualityLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** 터치 기기 / 화면 크기 / 메모리로 기기 등급을 추정 (클라이언트 전용) */
export function detectQuality(): QualityLevel {
  if (typeof window === "undefined") return "high";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const shortSide = Math.min(window.screen.width, window.screen.height);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (coarse && shortSide < 820) return "low";
  if (coarse || memory <= 4) return "medium";
  return "high";
}

export function resolveQuality(setting: QualitySetting, detected: QualityLevel): QualityLevel {
  return setting === "auto" ? detected : setting;
}

/** 프리셋을 고를 때 함께 적용하는 기본값 (이후 사용자가 개별 수정 가능) */
export function applyQualityDefaults(s: SceneState, level: QualityLevel): SceneState {
  const shadow = {
    high: [2048, 2048, 1024],
    medium: [1024, 1024, 512],
    low: [1024, 1024, 512],
  }[level] as [ShadowResolution, ShadowResolution, ShadowResolution];
  return {
    ...s,
    directional: { ...s.directional, shadowResolution: shadow[0] },
    spot: { ...s.spot, shadowResolution: shadow[1] },
    point: {
      ...s.point,
      shadowResolution: shadow[2],
      shadowType: level === "low" ? "none" : s.point.shadowType === "none" ? "soft" : s.point.shadowType,
    },
    render: {
      ...s.render,
      microSteps: { high: 32, medium: 24, low: 16 }[level],
      showGizmos: level !== "low",
      ptScale: { high: 0.5, medium: 0.5, low: 0.5 }[level], // 실제 픽셀 수는 프로필 ptMaxPixels 로 제한
      ptMaxBounces: { high: 3, medium: 2, low: 1 }[level],
      ptMaxSamples: { high: 2048, medium: 1024, low: 512 }[level],
      denoiseIterations: level === "low" ? 4 : 5,
    },
  };
}
