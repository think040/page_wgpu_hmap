"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PaintingRenderer, type RendererStats } from "@/gpu/renderer";
import { Store, createDefaultState, type QualityLevel } from "@/scene/state";
import { QUALITY_LABEL, QUALITY_PROFILES, applyQualityDefaults, detectQuality, resolveQuality } from "@/scene/quality";
import { getArtworkLibrary } from "@/scene/artworks";
import { useArtworks } from "@/scene/useArtworks";
// TODO(관리자 페이지): 관리자 페이지를 만들면 AdminInspector 를 그쪽으로 옮기고 아래 임시 토글을 제거한다.
import { AdminInspector } from "@/components/admin/AdminInspector";
import { Inspector } from "./Inspector";
import styles from "./hero.module.css";

const artworkKey = (a: { colorUrl: string; heightUrl: string }) => `${a.colorUrl}|${a.heightUrl}`;

type Status =
  | { kind: "loading"; progress: number; label: string }
  | { kind: "ready" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

// ── 클라이언트 전용 환경 값 (SSR 스냅샷은 null / false) ──
let detectedCache: QualityLevel | null = null;
const getDetected = () => (detectedCache ??= detectQuality());
const noopSubscribe = () => () => {};

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export default function Hero() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PaintingRenderer | null>(null);
  const [store] = useState(() => new Store(createDefaultState()));
  const [status, setStatus] = useState<Status>({ kind: "loading", progress: 0, label: "WebGPU 초기화" });
  const [stats, setStats] = useState<RendererStats | null>(null);
  const [gpuWarning, setGpuWarning] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState<boolean | null>(null);
  const [touch3D, setTouch3D] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [artworkSwitching, setArtworkSwitching] = useState(false);
  useArtworks(); // 저장된 작품 목록을 미리 불러온다

  const detected = useSyncExternalStore(noopSubscribe, getDetected, () => null);
  const qualitySetting = useSyncExternalStore(store.subscribe, () => store.get().render.quality, () => "auto" as const);
  const level = detected ? resolveQuality(qualitySetting, detected) : null;
  const coarse = useMedia("(pointer: coarse)");
  const small = useMedia("(max-width: 760px)");
  const open = panelOpen ?? !small;
  const touchEnabled = !coarse || touch3D;

  // 최초 자동 판정 시 해당 프리셋의 기본값(그림자 해상도 등)을 적용
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (!detected || defaultsApplied.current) return;
    defaultsApplied.current = true;
    store.set((s) => applyQualityDefaults(s, resolveQuality(s.render.quality, detected)));
  }, [detected, store]);

  // 품질 등급이 바뀌면 렌더러를 새로 만든다 (텍스처 크기 · MSAA · 메시가 달라짐)
  const touchRef = useRef(touchEnabled);
  useEffect(() => {
    touchRef.current = touchEnabled;
    rendererRef.current?.setTouchEnabled(touchEnabled);
  }, [touchEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !level) return;
    let disposed = false;
    let renderer: PaintingRenderer | null = null;
    let unsubscribeArtwork: (() => void) | null = null;

    // 처음엔 기본 작품, 품질 변경으로 재생성될 때는 현재 선택된 작품으로 시작
    const library = getArtworkLibrary();
    const initial = library.selected();
    let applied = artworkKey(initial);

    // 선택된 작품이 바뀌면 렌더러의 텍스처만 교체
    const applySelected = () => {
      const r = renderer;
      const a = library.selected();
      const key = artworkKey(a);
      if (!r || disposed || key === applied) return;
      applied = key;
      setArtworkSwitching(true);
      r.setArtwork(a.colorUrl, a.heightUrl)
        .catch((e: unknown) => {
          if (!disposed) setGpuWarning(`작품을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          if (!disposed && applied === key) setArtworkSwitching(false);
        });
    };

    PaintingRenderer.create(canvas, store, {
      colorUrl: initial.colorUrl,
      heightUrl: initial.heightUrl,
      quality: QUALITY_PROFILES[level],
      onProgress: (progress, label) => !disposed && setStatus({ kind: "loading", progress, label }),
      onStats: (s) => !disposed && setStats(s),
      onError: (message) => !disposed && setGpuWarning(message),
    })
      .then((r) => {
        if (disposed) {
          r.dispose();
          return;
        }
        renderer = r;
        rendererRef.current = r;
        r.setTouchEnabled(touchRef.current);
        setStatus({ kind: "ready" });
        unsubscribeArtwork = library.subscribe(applySelected);
        applySelected(); // 로딩 중에 선택이 바뀌었으면 반영
      })
      .catch((e: unknown) => {
        if (disposed) return;
        if (!("gpu" in navigator)) setStatus({ kind: "unsupported" });
        else setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });

    // 히어로가 화면 밖이면 GPU 렌더 루프 정지
    const io = new IntersectionObserver(([entry]) => renderer?.setActive(entry.isIntersecting), { threshold: 0.01 });
    io.observe(canvas);

    return () => {
      disposed = true;
      unsubscribeArtwork?.();
      setArtworkSwitching(false);
      io.disconnect();
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [store, level]);

  const ready = status.kind === "ready" && level !== null && detected !== null;
  const loading = status.kind === "loading";
  const failed = status.kind === "unsupported" || status.kind === "error";

  return (
    <section className={styles.hero} id="top">
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-touch={touchEnabled ? "on" : "off"}
        tabIndex={0}
        aria-label="WebGPU로 렌더링한 벽에 걸린 임파스토 유화. 드래그로 카메라를 조작할 수 있습니다."
      />

      <div className={styles.copy}>
        <p className={styles.eyebrow}>WebGPU · Heightmap · Ray-marched Shadows</p>
        <h1 className={styles.title}>
          빛이 스치면
          <br />
          물감이 깨어난다
        </h1>
        <p className={styles.lede}>
          팔레트 나이프로 쌓아 올린 물감의 높낮이를 하이트맵으로 재구성하고, 비스듬히 스치는 빛으로 그 결을 읽습니다.
        </p>
      </div>

      {ready && stats && (
        <div className={styles.hud} aria-live="off">
          <span>{stats.mode === "raster" ? "Rasterize" : "Path Trace"}</span>
          <span>{QUALITY_LABEL[stats.quality]}</span>
          <span>{stats.idle ? "idle" : `${stats.fps.toFixed(0)} fps`}</span>
          {stats.mode === "pathtrace" && <span>{stats.samples} spp</span>}
        </div>
      )}

      {ready && !coarse && (
        <p className={styles.hint}>드래그 회전 · 우클릭/Shift 드래그 이동 · 캔버스 클릭 후 휠 줌 · WASD / QE 이동</p>
      )}

      {ready && (coarse || small) && !(open && small) && (
        <div className={styles.mobileBar}>
          {coarse && (
            <button
              type="button"
              className={styles.pill}
              data-active={touch3D}
              aria-pressed={touch3D}
              onClick={() => setTouch3D((v) => !v)}
            >
              {touch3D ? "3D 조작 켜짐 · 스크롤 잠김" : "3D 조작 켜기"}
            </button>
          )}
          {!open && (
            <button type="button" className={styles.pill} onClick={() => setPanelOpen(true)}>
              설정
            </button>
          )}
        </div>
      )}

      {ready && !open && !coarse && !small && (
        <button type="button" className={styles.panelToggle} onClick={() => setPanelOpen(true)}>
          조명 · 카메라 설정
        </button>
      )}
      {ready && open && (
        <Inspector
          store={store}
          stats={stats}
          profile={QUALITY_PROFILES[level]}
          detected={detected}
          artworkSwitching={artworkSwitching}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* 임시: 관리자 페이지가 생기기 전까지 히어로에서 관리자 인스펙터를 연다 */}
      {ready && !adminOpen && (
        <button type="button" className={styles.adminToggle} onClick={() => setAdminOpen(true)}>
          관리자 · 작품 등록
        </button>
      )}
      {ready && adminOpen && <AdminInspector onClose={() => setAdminOpen(false)} />}

      {loading && (
        <div className={styles.loader} role="status">
          <span>{status.label}</span>
          <span className={styles.bar}>
            <span style={{ transform: `scaleX(${status.progress})` }} />
          </span>
        </div>
      )}

      {failed && (
        <div className={styles.fallback}>
          <div className={styles.fallbackCard}>
            <strong>{status.kind === "unsupported" ? "WebGPU를 사용할 수 없습니다" : "렌더러를 시작하지 못했습니다"}</strong>
            <p>
              {status.kind === "unsupported"
                ? "Chrome / Edge 113+, Safari 26+, Firefox 141+(Windows), Android Chrome 121+ 등 WebGPU 지원 브라우저에서 열어 주세요. 아래는 원본 작품 이미지입니다."
                : status.message}
            </p>
          </div>
        </div>
      )}

      {gpuWarning && ready && (
        <p className={styles.warning} role="alert">
          GPU 경고: {gpuWarning}
        </p>
      )}
    </section>
  );
}
