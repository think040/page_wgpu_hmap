# Atelier Impasto — WebGPU heightmap painting

Next.js 16 + TypeScript + WebGPU + wgpu-matrix 로 만든 홈페이지. 히어로 섹션에서 벽에 걸린 임파스토 유화를
하이트맵(`public/art/height.webp`)과 컬러맵(`public/art/color.webp`)으로 렌더링한다.

```bash
npm run dev     # http://localhost:3000
npm run build
```

## 구조

| 경로 | 내용 |
|---|---|
| `src/gpu/renderer.ts` | WebGPU 초기화, 패스 구성(섀도우 → 씬(MSAA, HDR) → 톤맵 / 패스트레이싱) |
| `src/gpu/geometry.ts` | 벽·바닥·두께 있는 캔버스(베벨 포함)·그림 면 그리드 |
| `src/gpu/lights.ts` | Unity식 조명 파라미터 → GPU 데이터, 섀도우 행렬, 유니폼 패킹, 기즈모 |
| `src/gpu/controls.ts` | 오빗 카메라 (회전/이동/줌, 키보드, 터치) |
| `src/gpu/shaders/*.wgsl` | 분리된 WGSL 셰이더 (`next.config.ts` 에서 문자열로 import) |
| `src/scene/state.ts` | UI ↔ 렌더러 공유 상태 스토어 |
| `src/components/hero/` | 히어로 + Unity Inspector 풍 조명/카메라 패널 |

## 그림자

- **큰 그림자** (캔버스 → 벽): 조명별 섀도우맵 — Directional(직교), Spot(원근), Point(6면 배열) + PCSS
- **물감 자기그림자**: 하이트필드 레이마칭 (`scene.wgsl` 의 `microShadow`)
- **AO**: 하이트맵 Horizon AO (compute 전처리)
- **Path Trace 모드**: compute 셰이더 소프트웨어 패스트레이서 (`pathtrace.wgsl`), 프레임당 1spp 누적

## Path Trace 디노이저 (`denoise.wgsl`)

`ptGBuffer`(노멀·거리·알베도) → `reproject`(카메라만 움직였을 때 이전 누적 재사용, 최대 16spp) →
`ptMain`(+1spp, 휘도 모멘트) → `prepare`(알베도 분리 + 분산) → `atrous` × N(1,2,4,8,16) → `finalize`(알베도 재곱, spp 에 따라 원본으로 페이드).
노출·디노이저 설정 변경은 누적을 초기화하지 않는다.

## 품질 프리셋 / 모바일 (`src/scene/quality.ts`)

Auto(기기 판정) 기본, Render 탭에서 수동 변경 시 렌더러 재시작. Low 는 MSAA 1x, 텍스처 1024², 메시 256², PCSS 8샘플,
Point 그림자 꺼짐, Path Trace 저품질 + 경고. 장면이 정적이므로 변화가 있을 때만 렌더한다.
터치 기기에서는 "3D 조작" 버튼을 켰을 때만 터치로 카메라를 조작한다 (기본은 페이지 스크롤 우선).

`common.wgsl` 의 `Frame`/`Light` 구조체와 `lights.ts` 의 `packFrame` 오프셋은 반드시 함께 수정할 것.
