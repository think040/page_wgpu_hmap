// 씬 지오메트리: 벽 / 바닥 / 화실 캔버스(나무틀을 감싼 두께 있는 천) / 그림 면 그리드
// 좌표계: 미터, 오른손 좌표계, 벽은 z=0 평면이고 +z 쪽(방)을 바라본다.

export const SCENE = {
  paintW: 0.9, // 캔버스 외곽 폭
  paintH: 0.9,
  depth: 0.035, // 캔버스 두께(나무틀)
  wallGap: 0.012, // 벽과 캔버스 뒷면 사이 간격
  bevel: 0.004, // 앞면 모서리 라운드 반경
  floorY: -1.45,
  wallHalfW: 4,
  wallTop: 2.6,
  floorDepth: 5,
} as const;

export const CANVAS = (() => {
  const hw = SCENE.paintW / 2;
  const hh = SCENE.paintH / 2;
  const zBack = SCENE.wallGap;
  const zFront = SCENE.wallGap + SCENE.depth;
  const a = hw - SCENE.bevel; // 그림 면(인셋) 반폭
  const b = hh - SCENE.bevel;
  return {
    hw,
    hh,
    zBack,
    zFront,
    paintMin: [-a, -b] as [number, number],
    paintSize: [2 * a, 2 * b] as [number, number],
  };
})();

/** 정점 포맷: position(3) normal(3) uv(2) material(1) = 36 bytes */
export const STATIC_STRIDE = 9 * 4;

export const MATERIAL = { wall: 0, floor: 1, side: 2, back: 3, paint: 4 } as const;

class MeshBuilder {
  verts: number[] = [];
  idx: number[] = [];

  vertex(p: number[], n: number[], uv: number[], mat: number): number {
    this.verts.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], mat);
    return this.verts.length / 9 - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  build() {
    return { vertices: new Float32Array(this.verts), indices: new Uint32Array(this.idx) };
  }
}

/** 모서리 바깥 면(옆면/베벨)은 그림의 가장자리 색을 끌어다 쓴다 (gallery wrap) */
function edgeUV(x: number, y: number): number[] {
  const [mx, my] = CANVAS.paintMin;
  const [sx, sy] = CANVAS.paintSize;
  const u = Math.min(1, Math.max(0, (x - mx) / sx));
  const v = Math.min(1, Math.max(0, 1 - (y - my) / sy));
  return [u, v];
}

function addCanvasBody(m: MeshBuilder, withFrontProxy: boolean) {
  const { zFront, zBack, hw, hh } = CANVAS;
  const r = SCENE.bevel;
  const a = hw - r;
  const b = hh - r;

  // 단면 프로파일: 앞면 가장자리 → 1/4 원 베벨 → 옆면 → 뒷면
  const K = 5;
  const prof: { o: number; z: number; s: number; c: number }[] = [];
  for (let k = 0; k <= K; k++) {
    const t = (k / K) * (Math.PI / 2);
    prof.push({ o: r * Math.sin(t), z: zFront - r + r * Math.cos(t), s: Math.sin(t), c: Math.cos(t) });
  }
  prof.push({ o: r, z: zBack, s: 1, c: 0 });

  // 네 변: [시작 코너, 끝 코너, 바깥 방향]
  const sides: { c0: [number, number]; c1: [number, number]; n: [number, number] }[] = [
    { c0: [-1, -1], c1: [1, -1], n: [0, -1] }, // 아래
    { c0: [1, -1], c1: [1, 1], n: [1, 0] }, // 오른쪽
    { c0: [1, 1], c1: [-1, 1], n: [0, 1] }, // 위
    { c0: [-1, 1], c1: [-1, -1], n: [-1, 0] }, // 왼쪽
  ];

  for (const side of sides) {
    const rows: number[][] = [];
    for (const p of prof) {
      const row: number[] = [];
      for (const c of [side.c0, side.c1]) {
        const x = c[0] * (a + p.o);
        const y = c[1] * (b + p.o);
        const n = [side.n[0] * p.s, side.n[1] * p.s, p.c];
        row.push(m.vertex([x, y, p.z], n, edgeUV(x, y), MATERIAL.side));
      }
      rows.push(row);
    }
    for (let k = 0; k < rows.length - 1; k++) {
      m.quad(rows[k][0], rows[k][1], rows[k + 1][1], rows[k + 1][0]);
    }
  }

  // 뒷면 (리넨)
  const bn = [0, 0, -1];
  const v0 = m.vertex([-hw, -hh, zBack], bn, [0, 1], MATERIAL.back);
  const v1 = m.vertex([hw, -hh, zBack], bn, [1, 1], MATERIAL.back);
  const v2 = m.vertex([hw, hh, zBack], bn, [1, 0], MATERIAL.back);
  const v3 = m.vertex([-hw, hh, zBack], bn, [0, 0], MATERIAL.back);
  m.quad(v0, v1, v2, v3);

  if (withFrontProxy) {
    // 그림자맵 전용: 변위 없는 평평한 앞면
    const fn = [0, 0, 1];
    const f0 = m.vertex([-a, -b, zFront], fn, [0, 1], MATERIAL.paint);
    const f1 = m.vertex([a, -b, zFront], fn, [1, 1], MATERIAL.paint);
    const f2 = m.vertex([a, b, zFront], fn, [1, 0], MATERIAL.paint);
    const f3 = m.vertex([-a, b, zFront], fn, [0, 0], MATERIAL.paint);
    m.quad(f0, f1, f2, f3);
  }
}

/** 메인 패스용 정적 메시 (벽, 바닥, 캔버스 옆면/뒷면) */
export function buildStaticMesh() {
  const m = new MeshBuilder();
  const { wallHalfW: W, wallTop, floorY, floorDepth } = SCENE;

  const wn = [0, 0, 1];
  const w0 = m.vertex([-W, floorY, 0], wn, [-W, floorY], MATERIAL.wall);
  const w1 = m.vertex([W, floorY, 0], wn, [W, floorY], MATERIAL.wall);
  const w2 = m.vertex([W, wallTop, 0], wn, [W, wallTop], MATERIAL.wall);
  const w3 = m.vertex([-W, wallTop, 0], wn, [-W, wallTop], MATERIAL.wall);
  m.quad(w0, w1, w2, w3);

  const fn = [0, 1, 0];
  const f0 = m.vertex([-W, floorY, floorDepth], fn, [-W, floorDepth], MATERIAL.floor);
  const f1 = m.vertex([W, floorY, floorDepth], fn, [W, floorDepth], MATERIAL.floor);
  const f2 = m.vertex([W, floorY, 0], fn, [W, 0], MATERIAL.floor);
  const f3 = m.vertex([-W, floorY, 0], fn, [-W, 0], MATERIAL.floor);
  m.quad(f0, f1, f2, f3);

  addCanvasBody(m, false);
  return m.build();
}

/** 그림자 캐스터 메시 (캔버스 몸체 + 평평한 앞면 프록시) */
export function buildCasterMesh() {
  const m = new MeshBuilder();
  addCanvasBody(m, true);
  return m.build();
}

/** 그림 면 그리드: uv 만 담고 위치는 버텍스 셰이더에서 하이트맵으로 계산 */
export function buildPaintingGrid(segments: number) {
  const n = segments + 1;
  const uvs = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 2;
      uvs[i] = x / segments;
      uvs[i + 1] = y / segments;
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const i0 = y * n + x;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      indices[k++] = i0;
      indices[k++] = i2;
      indices[k++] = i1;
      indices[k++] = i1;
      indices[k++] = i2;
      indices[k++] = i3;
    }
  }
  return { uvs, indices };
}
