import { vec3 } from "wgpu-matrix";
import { patchCamera, type CameraState, type SceneStore, type Vec3 } from "@/scene/state";

const DEG = Math.PI / 180;

export const CAMERA_LIMITS = {
  yaw: [-85, 85] as const,
  pitch: [-60, 75] as const,
  distance: [0.12, 6] as const,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 설정 FOV 를 화면의 짧은 변 기준으로 적용 (세로 모바일 화면에서도 그림이 가로로 잘리지 않게) */
export function effectiveFovY(fovDeg: number, aspect: number): number {
  const f = fovDeg * DEG;
  return aspect >= 1 ? f : 2 * Math.atan(Math.tan(f / 2) / aspect);
}

export function cameraEye(c: CameraState): Vec3 {
  const y = c.yaw * DEG;
  const p = c.pitch * DEG;
  return [
    c.target[0] + c.distance * Math.cos(p) * Math.sin(y),
    c.target[1] + c.distance * Math.sin(p),
    c.target[2] + c.distance * Math.cos(p) * Math.cos(y),
  ];
}

function cameraBasis(c: CameraState) {
  const eye = cameraEye(c);
  const fwd = vec3.normalize(vec3.subtract(c.target, eye));
  const right = vec3.normalize(vec3.cross(fwd, [0, 1, 0]));
  const up = vec3.cross(right, fwd);
  return { fwd, right, up };
}

/**
 * 오빗 카메라 조작
 *  - 좌클릭 드래그: 회전 / 우클릭·중클릭·Shift+드래그: 이동(팬)
 *  - 캔버스 포커스 시: 휠 줌, WASD 이동, Q/E 상하, 방향키 회전
 *  - 터치: 한 손가락 회전, 두 손가락 핀치 줌 + 팬
 */
export class OrbitControls {
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: "rotate" | "pan" = "rotate";
  private pinch = { dist: 0, cx: 0, cy: 0 };
  private keys = new Set<string>();
  private abort = new AbortController();
  /** 터치 기기에서 페이지 스크롤과 충돌하지 않도록, 켜진 경우에만 터치로 카메라 조작 */
  touchEnabled = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: SceneStore,
  ) {
    const o = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", this.onDown, o);
    canvas.addEventListener("pointermove", this.onMove, o);
    canvas.addEventListener("pointerup", this.onUp, o);
    canvas.addEventListener("pointercancel", this.onUp, o);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), o);
    canvas.addEventListener("wheel", this.onWheel, { signal: this.abort.signal, passive: false });
    canvas.addEventListener("keydown", this.onKeyDown, o);
    canvas.addEventListener("keyup", (e) => this.keys.delete(e.code), o);
    canvas.addEventListener("blur", () => this.keys.clear(), o);
  }

  dispose() {
    this.abort.abort();
  }

  private get cam() {
    return this.store.get().camera;
  }

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === "touch" && !this.touchEnabled) return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.mode = e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "rotate";
    if (this.pointers.size === 2) this.pinch = this.pinchState();
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      const next = this.pinchState();
      if (this.pinch.dist > 0 && next.dist > 0) {
        const c = this.cam;
        patchCamera(this.store, {
          distance: clamp((c.distance * this.pinch.dist) / next.dist, ...CAMERA_LIMITS.distance),
        });
        this.pan(next.cx - this.pinch.cx, next.cy - this.pinch.cy);
      }
      this.pinch = next;
      return;
    }

    if (this.mode === "pan") {
      this.pan(dx, dy);
    } else {
      const c = this.cam;
      patchCamera(this.store, {
        yaw: clamp(c.yaw - dx * 0.25, ...CAMERA_LIMITS.yaw),
        pitch: clamp(c.pitch + dy * 0.25, ...CAMERA_LIMITS.pitch),
      });
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch.dist = 0;
  };

  private pinchState() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return { dist: 0, cx: 0, cy: 0 };
    const [a, b] = pts;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private onWheel = (e: WheelEvent) => {
    // 페이지 스크롤을 막지 않도록, 캔버스가 포커스된 경우에만 줌
    if (document.activeElement !== this.canvas) return;
    e.preventDefault();
    const c = this.cam;
    patchCamera(this.store, {
      distance: clamp(c.distance * Math.exp(e.deltaY * 0.0012), ...CAMERA_LIMITS.distance),
    });
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      this.canvas.blur();
      return;
    }
    const handled = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (handled.includes(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
    }
  };

  /** 화면 픽셀 이동량만큼 타깃을 카메라 평면에서 이동 */
  pan(dx: number, dy: number) {
    const c = this.cam;
    const h = Math.max(this.canvas.clientHeight, 1);
    const aspect = Math.max(this.canvas.clientWidth, 1) / h;
    const scale = (2 * c.distance * Math.tan(effectiveFovY(c.fov, aspect) / 2)) / h;
    const { right, up } = cameraBasis(c);
    const t = vec3.add(c.target, vec3.add(vec3.scale(right, -dx * scale), vec3.scale(up, dy * scale)));
    patchCamera(this.store, { target: [t[0], t[1], t[2]] });
  }

  /** 키보드 연속 입력 처리 (매 프레임) */
  update(dt: number) {
    if (this.keys.size === 0) return;
    const c = this.cam;
    const k = (code: string) => (this.keys.has(code) ? 1 : 0);
    const speed = Math.max(c.distance, 0.3) * 0.8 * dt;
    const { fwd, right } = cameraBasis(c);
    const flatFwd = vec3.normalize([fwd[0], 0, fwd[2]]);
    const mf = k("KeyW") - k("KeyS");
    const mr = k("KeyD") - k("KeyA");
    const mu = k("KeyE") - k("KeyQ");
    const move = vec3.add(
      vec3.add(vec3.scale(flatFwd, mf * speed), vec3.scale(right, mr * speed)),
      [0, mu * speed, 0],
    );
    const t = vec3.add(c.target, move);
    const rotSpeed = 60 * dt;
    patchCamera(this.store, {
      target: [t[0], t[1], t[2]],
      yaw: clamp(c.yaw + (k("ArrowLeft") - k("ArrowRight")) * rotSpeed, ...CAMERA_LIMITS.yaw),
      pitch: clamp(c.pitch + (k("ArrowUp") - k("ArrowDown")) * rotSpeed, ...CAMERA_LIMITS.pitch),
    });
  }
}
