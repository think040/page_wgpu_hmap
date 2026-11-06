"use client";

import { useState, useSyncExternalStore } from "react";
import {
  PAINTING_CENTER,
  aimRotation,
  defaultCamera,
  patchCamera,
  patchLight,
  patchRender,
  type LightCommon,
  type LightKey,
  type SceneStore,
  type ShadowResolution,
  type ShadowType,
  type DenoiseView,
  type QualityLevel,
  type QualitySetting,
} from "@/scene/state";
import { QUALITY_LABEL, applyQualityDefaults, resolveQuality, type QualityProfile } from "@/scene/quality";
import { cssColorOfLight } from "@/gpu/lights";
import type { RendererStats } from "@/gpu/renderer";
import { ButtonRow, ColorField, Section, Select, Slider, Toggle, Vec3Field } from "./fields";
import styles from "./inspector.module.css";

type Tab = "camera" | LightKey | "render";

const TABS: { id: Tab; label: string }[] = [
  { id: "camera", label: "Camera" },
  { id: "directional", label: "Directional" },
  { id: "spot", label: "Spot" },
  { id: "point", label: "Point" },
  { id: "render", label: "Render" },
];

const SHADOW_TYPES: { value: ShadowType; label: string }[] = [
  { value: "none", label: "No Shadows" },
  { value: "hard", label: "Hard Shadows" },
  { value: "soft", label: "Soft Shadows" },
];

const RESOLUTIONS: { value: ShadowResolution; label: string }[] = [
  { value: 512, label: "Low (512)" },
  { value: 1024, label: "Medium (1024)" },
  { value: 2048, label: "High (2048)" },
  { value: 4096, label: "Very High (4096)" },
];

const LIGHT_TYPE_LABEL: Record<LightKey, string> = {
  directional: "Directional",
  spot: "Spot",
  point: "Point",
};

/** Unity Light 컴포넌트 공통 항목 */
function LightFields<K extends LightKey>({
  light,
  kind,
  maxIntensity,
  maxResolution,
  onPatch,
}: {
  light: LightCommon;
  kind: K;
  maxIntensity: number;
  maxResolution: ShadowResolution;
  onPatch: (p: Partial<LightCommon>) => void;
}) {
  return (
    <Section title="Light">
      <div className={styles.row}>
        <span className={styles.label}>Type</span>
        <span className={styles.readonly}>{LIGHT_TYPE_LABEL[kind]}</span>
      </div>
      <ColorField label="Color" value={light.color} preview={cssColorOfLight(light)} onChange={(color) => onPatch({ color })} />
      <Toggle label="Use Color Temperature" checked={light.useTemperature} onChange={(useTemperature) => onPatch({ useTemperature })} />
      {light.useTemperature && (
        <Slider
          label="Temperature"
          value={light.temperature}
          min={1500}
          max={12000}
          step={50}
          unit="K"
          onChange={(temperature) => onPatch({ temperature })}
        />
      )}
      <Slider label="Intensity" value={light.intensity} min={0} max={maxIntensity} step={0.05} onChange={(intensity) => onPatch({ intensity })} />
      <Select label="Shadow Type" value={light.shadowType} options={SHADOW_TYPES} onChange={(shadowType) => onPatch({ shadowType })} />
      {light.shadowType !== "none" && (
        <div className={styles.indent}>
          <Slider
            label="Strength"
            value={light.shadowStrength}
            min={0}
            max={1}
            step={0.01}
            onChange={(shadowStrength) => onPatch({ shadowStrength })}
          />
          <Select
            label="Resolution"
            value={light.shadowResolution}
            options={RESOLUTIONS.filter((r) => r.value <= maxResolution)}
            onChange={(shadowResolution) => onPatch({ shadowResolution })}
          />
          <Slider label="Bias" value={light.bias} min={0} max={5} step={0.05} onChange={(bias) => onPatch({ bias })} />
          <Slider label="Normal Bias" value={light.normalBias} min={0} max={5} step={0.05} onChange={(normalBias) => onPatch({ normalBias })} />
          {kind !== "directional" && (
            <Slider label="Near Plane" value={light.nearPlane} min={0.01} max={1} step={0.01} onChange={(nearPlane) => onPatch({ nearPlane })} />
          )}
          <Slider
            label={kind === "directional" ? "Softness (각도)" : "Softness (반경)"}
            value={light.softness}
            min={0}
            max={1}
            step={0.01}
            onChange={(softness) => onPatch({ softness })}
          />
        </div>
      )}
    </Section>
  );
}

function EnableHeader({ title, checked, onChange }: { title: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.componentHeader}>
      <input type="checkbox" className={styles.checkbox} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{title}</span>
    </label>
  );
}

const DENOISE_VIEWS: { value: DenoiseView; label: string }[] = [
  { value: "denoised", label: "Denoised" },
  { value: "raw", label: "Raw (필터 없음)" },
  { value: "split", label: "Split (왼쪽 필터 / 오른쪽 원본)" },
];

export function Inspector({
  store,
  stats,
  profile,
  detected,
  onClose,
}: {
  store: SceneStore;
  stats: RendererStats | null;
  profile: QualityProfile;
  detected: QualityLevel;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [tab, setTab] = useState<Tab>("directional");
  const { camera, directional, spot, point, render } = state;
  const lowEnd = profile.level === "low";

  const setQuality = (quality: QualitySetting) =>
    store.set((s) => applyQualityDefaults({ ...s, render: { ...s.render, quality } }, resolveQuality(quality, detected)));

  return (
    <aside className={styles.panel} aria-label="조명 및 카메라 설정">
      <div className={styles.titleBar}>
        <span className={styles.title}>Inspector</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="패널 닫기">
          ×
        </button>
      </div>
      <nav className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.tab}
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className={styles.scroll}>
        {tab === "camera" && (
          <>
            <Section title="Transform">
              <Vec3Field label="Target" value={camera.target} onChange={(target) => patchCamera(store, { target })} />
              <Slider label="Yaw" value={camera.yaw} min={-85} max={85} step={0.5} unit="°" onChange={(yaw) => patchCamera(store, { yaw })} />
              <Slider label="Pitch" value={camera.pitch} min={-60} max={75} step={0.5} unit="°" onChange={(pitch) => patchCamera(store, { pitch })} />
              <Slider
                label="Distance"
                value={camera.distance}
                min={0.12}
                max={6}
                step={0.01}
                unit="m"
                onChange={(distance) => patchCamera(store, { distance })}
              />
            </Section>
            <Section title="Camera">
              <Slider label="Field of View" value={camera.fov} min={15} max={80} step={0.5} unit="°" onChange={(fov) => patchCamera(store, { fov })} />
              <ButtonRow>
                <button type="button" className={styles.button} onClick={() => patchCamera(store, defaultCamera())}>
                  기본 시점
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => patchCamera(store, { target: [0.12, 0.08, 0.05], yaw: 0, pitch: 0, distance: 0.32 })}
                >
                  디테일 근접
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => patchCamera(store, { target: [0, 0, 0.03], yaw: 72, pitch: 6, distance: 0.9 })}
                >
                  측면(두께)
                </button>
              </ButtonRow>
            </Section>
            <Section title="조작">
              <ul className={styles.help}>
                <li><kbd>좌클릭 드래그</kbd> 회전</li>
                <li><kbd>우클릭 / Shift 드래그</kbd> 이동</li>
                <li><kbd>휠</kbd> 줌 (캔버스 클릭 후)</li>
                <li><kbd>W A S D</kbd> 이동 · <kbd>Q E</kbd> 상하</li>
                <li><kbd>방향키</kbd> 회전 · <kbd>Esc</kbd> 조작 해제</li>
              </ul>
            </Section>
          </>
        )}

        {tab === "directional" && (
          <>
            <EnableHeader title="Directional Light" checked={directional.enabled} onChange={(enabled) => patchLight(store, "directional", { enabled })} />
            <Section title="Transform">
              <Slider
                label="Rotation X"
                value={directional.rotation.x}
                min={-10}
                max={90}
                step={0.5}
                unit="°"
                onChange={(x) => patchLight(store, "directional", { rotation: { ...directional.rotation, x } })}
              />
              <Slider
                label="Rotation Y"
                value={directional.rotation.y}
                min={-180}
                max={180}
                step={0.5}
                unit="°"
                onChange={(y) => patchLight(store, "directional", { rotation: { ...directional.rotation, y } })}
              />
              <Slider
                label="Auto Rotate"
                value={directional.autoRotate}
                min={-60}
                max={60}
                step={1}
                unit="°/s"
                onChange={(autoRotate) => patchLight(store, "directional", { autoRotate })}
              />
            </Section>
            <LightFields kind="directional" light={directional} maxIntensity={6} maxResolution={profile.maxShadowResolution} onPatch={(p) => patchLight(store, "directional", p)} />
          </>
        )}

        {tab === "spot" && (
          <>
            <EnableHeader title="Spot Light" checked={spot.enabled} onChange={(enabled) => patchLight(store, "spot", { enabled })} />
            <Section title="Transform">
              <Vec3Field label="Position" value={spot.position} onChange={(position) => patchLight(store, "spot", { position })} />
              <Slider
                label="Rotation X"
                value={spot.rotation.x}
                min={-90}
                max={90}
                step={0.5}
                unit="°"
                onChange={(x) => patchLight(store, "spot", { rotation: { ...spot.rotation, x } })}
              />
              <Slider
                label="Rotation Y"
                value={spot.rotation.y}
                min={-180}
                max={180}
                step={0.5}
                unit="°"
                onChange={(y) => patchLight(store, "spot", { rotation: { ...spot.rotation, y } })}
              />
              <ButtonRow>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => patchLight(store, "spot", { rotation: aimRotation(spot.position, PAINTING_CENTER) })}
                >
                  그림 중심을 향하게
                </button>
              </ButtonRow>
            </Section>
            <Section title="Shape">
              <Slider label="Range" value={spot.range} min={0.5} max={12} step={0.1} unit="m" onChange={(range) => patchLight(store, "spot", { range })} />
              <Slider
                label="Spot Angle"
                value={spot.spotAngle}
                min={1}
                max={160}
                step={0.5}
                unit="°"
                onChange={(spotAngle) =>
                  patchLight(store, "spot", { spotAngle, innerSpotAngle: Math.min(spot.innerSpotAngle, spotAngle) })
                }
              />
              <Slider
                label="Inner Spot Angle"
                value={spot.innerSpotAngle}
                min={0}
                max={spot.spotAngle}
                step={0.5}
                unit="°"
                onChange={(innerSpotAngle) => patchLight(store, "spot", { innerSpotAngle })}
              />
            </Section>
            <LightFields kind="spot" light={spot} maxIntensity={20} maxResolution={profile.maxShadowResolution} onPatch={(p) => patchLight(store, "spot", p)} />
          </>
        )}

        {tab === "point" && (
          <>
            <EnableHeader title="Point Light" checked={point.enabled} onChange={(enabled) => patchLight(store, "point", { enabled })} />
            <Section title="Orbit (그림 중심 기준 회전)">
              <Slider
                label="Azimuth"
                value={point.orbit.azimuth}
                min={-180}
                max={180}
                step={0.5}
                unit="°"
                onChange={(azimuth) => patchLight(store, "point", { orbit: { ...point.orbit, azimuth } })}
              />
              <Slider
                label="Elevation"
                value={point.orbit.elevation}
                min={-60}
                max={85}
                step={0.5}
                unit="°"
                onChange={(elevation) => patchLight(store, "point", { orbit: { ...point.orbit, elevation } })}
              />
              <Slider
                label="Radius"
                value={point.orbit.radius}
                min={0.15}
                max={3}
                step={0.01}
                unit="m"
                onChange={(radius) => patchLight(store, "point", { orbit: { ...point.orbit, radius } })}
              />
              <Slider
                label="Auto Orbit"
                value={point.autoOrbit}
                min={-90}
                max={90}
                step={1}
                unit="°/s"
                onChange={(autoOrbit) => patchLight(store, "point", { autoOrbit })}
              />
            </Section>
            <Section title="Shape">
              <Slider label="Range" value={point.range} min={0.3} max={12} step={0.1} unit="m" onChange={(range) => patchLight(store, "point", { range })} />
            </Section>
            <LightFields kind="point" light={point} maxIntensity={20} maxResolution={profile.maxShadowResolution} onPatch={(p) => patchLight(store, "point", p)} />
          </>
        )}

        {tab === "render" && (
          <>
            <Section title="Quality">
              <Select<QualitySetting>
                label="Preset"
                value={render.quality}
                options={[
                  { value: "auto", label: `Auto (${QUALITY_LABEL[detected]})` },
                  { value: "low", label: "Low (모바일)" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High (데스크톱)" },
                ]}
                onChange={setQuality}
              />
              <p className={styles.note}>
                현재 {QUALITY_LABEL[profile.level]}: MSAA {profile.msaa}x · 텍스처 {profile.textureSize}² · 메시 {profile.gridSegments}² ·
                PCSS {profile.pcfSamples} 샘플. 프리셋을 바꾸면 렌더러가 다시 시작됩니다.
              </p>
            </Section>
            <Section title="Renderer">
              <div className={styles.segmented} role="radiogroup" aria-label="렌더링 방식">
                <button
                  type="button"
                  role="radio"
                  aria-checked={render.mode === "raster"}
                  data-active={render.mode === "raster"}
                  onClick={() => patchRender(store, { mode: "raster" })}
                >
                  Rasterize
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={render.mode === "pathtrace"}
                  data-active={render.mode === "pathtrace"}
                  onClick={() => patchRender(store, { mode: "pathtrace" })}
                >
                  Path Trace (Compute)
                </button>
              </div>
              {profile.ptWarning && (
                <p className={styles.warning}>
                  ⚠ 저사양·모바일 기기에서는 Path Trace가 저품질(내부 해상도 {Math.round(render.ptScale * 100)}%, 반사{" "}
                  {render.ptMaxBounces}회, 최대 {Math.round(profile.ptMaxPixels / 1000)}K 픽셀)로 동작하며 발열과 배터리 소모가 큽니다.
                </p>
              )}
              <p className={styles.note}>
                {render.mode === "raster"
                  ? "실시간: 섀도우맵(PCSS) + 하이트필드 레이마칭 자기그림자 + Horizon AO"
                  : "Compute 셰이더 소프트웨어 패스트레이싱. 시점·조명을 바꾸면 누적이 초기화됩니다."}
              </p>
            </Section>

            {render.mode === "pathtrace" && (
              <Section
                title="Path Tracer"
                aside={
                  <span className={styles.badge}>
                    {stats?.samples ?? 0} / {render.ptMaxSamples} spp
                  </span>
                }
              >
                <Slider
                  label="Max Bounces"
                  value={render.ptMaxBounces}
                  min={1}
                  max={6}
                  step={1}
                  onChange={(ptMaxBounces) => patchRender(store, { ptMaxBounces })}
                />
                <Slider
                  label="Resolution Scale"
                  value={render.ptScale}
                  min={0.25}
                  max={1}
                  step={0.05}
                  onChange={(ptScale) => patchRender(store, { ptScale })}
                />
                <Select
                  label="Max Samples"
                  value={render.ptMaxSamples}
                  options={[256, 512, 1024, 2048, 4096, 8192].map((v) => ({ value: v, label: String(v) }))}
                  onChange={(ptMaxSamples) => patchRender(store, { ptMaxSamples })}
                />
                {stats && (
                  <p className={styles.note}>
                    내부 해상도 {stats.rtWidth}×{stats.rtHeight}
                  </p>
                )}
              </Section>
            )}

            {render.mode === "pathtrace" && (
              <Section
                title="Denoiser (À-Trous + Temporal)"
                aside={
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={render.denoise}
                    aria-label="디노이저 사용"
                    onChange={(e) => patchRender(store, { denoise: e.target.checked })}
                  />
                }
              >
                <Toggle
                  label="Temporal Reprojection"
                  checked={render.reprojection}
                  onChange={(reprojection) => patchRender(store, { reprojection })}
                />
                {render.denoise && (
                  <>
                    <Select<DenoiseView>
                      label="View"
                      value={render.denoiseView}
                      options={DENOISE_VIEWS}
                      onChange={(denoiseView) => patchRender(store, { denoiseView })}
                    />
                    <Slider
                      label="Strength"
                      value={render.denoiseStrength}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(denoiseStrength) => patchRender(store, { denoiseStrength })}
                    />
                    <Slider
                      label="Iterations"
                      value={render.denoiseIterations}
                      min={1}
                      max={5}
                      step={1}
                      onChange={(denoiseIterations) => patchRender(store, { denoiseIterations })}
                    />
                    <Slider
                      label="Fade-out spp"
                      value={render.denoiseFadeSpp}
                      min={16}
                      max={2048}
                      step={16}
                      onChange={(denoiseFadeSpp) => patchRender(store, { denoiseFadeSpp })}
                    />
                  </>
                )}
                <p className={styles.note}>
                  알베도를 분리해 조명 성분만 노멀·깊이·분산 기준으로 필터링합니다. 샘플이 쌓일수록 원본 수렴값으로 전환되고,
                  카메라만 움직이면 이전 누적을 재투영해 이어 씁니다.
                </p>
              </Section>
            )}

            <Section title="Paint Surface">
              <Slider
                label="Height Scale"
                value={render.heightScale}
                min={0}
                max={12}
                step={0.1}
                unit="mm"
                onChange={(heightScale) => patchRender(store, { heightScale })}
              />
              <Slider label="Gloss" value={render.gloss} min={0} max={1} step={0.01} onChange={(gloss) => patchRender(store, { gloss })} />
              {render.mode === "raster" && (
                <>
                  <Slider
                    label="AO Strength"
                    value={render.aoStrength}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(aoStrength) => patchRender(store, { aoStrength })}
                  />
                  <Toggle
                    label="Heightfield Self-Shadow"
                    checked={render.microShadow}
                    onChange={(microShadow) => patchRender(store, { microShadow })}
                  />
                  {render.microShadow && (
                    <Slider
                      label="Ray-march Steps"
                      value={render.microSteps}
                      min={8}
                      max={64}
                      step={1}
                      onChange={(microSteps) => patchRender(store, { microSteps })}
                    />
                  )}
                </>
              )}
            </Section>

            <Section title="Environment">
              <Slider label="Ambient" value={render.ambient} min={0} max={0.6} step={0.01} onChange={(ambient) => patchRender(store, { ambient })} />
              <Slider label="Exposure" value={render.exposure} min={0.2} max={3} step={0.01} onChange={(exposure) => patchRender(store, { exposure })} />
              {render.mode === "raster" && !lowEnd && (
                <Toggle label="Light Gizmos" checked={render.showGizmos} onChange={(showGizmos) => patchRender(store, { showGizmos })} />
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
