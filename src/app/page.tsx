import Hero from "@/components/hero/Hero";
import styles from "./page.module.css";

const DETAILS = [
  { pos: "22% 18%", caption: "꽃잎 — 나이프로 눌러 편 두꺼운 물감" },
  { pos: "70% 72%", caption: "줄기 — 긁어낸 홈과 얇은 선" },
  { pos: "48% 46%", caption: "바탕 — 붓자국이 남은 밑칠" },
];

const LIGHTS = [
  {
    name: "Directional",
    role: "레이킹 라이트",
    body: "태양처럼 무한히 먼 평행광. 화면에 거의 평행하게 눕히면 물감의 작은 돌기마다 긴 그림자가 생겨 질감이 가장 강하게 드러납니다.",
    control: "회전 (Rotation X / Y, 자동 회전)",
  },
  {
    name: "Spot",
    role: "갤러리 조명",
    body: "천장 레일에 달린 스포트라이트. 원뿔 각과 내부 각으로 빛 웅덩이의 경계를 조절하고, 캔버스가 벽에 드리우는 그림자를 만듭니다.",
    control: "이동 + 회전 (Position, Rotation, Spot Angle)",
  },
  {
    name: "Point",
    role: "보조광",
    body: "모든 방향으로 퍼지는 전구. 그림 중심을 도는 궤도로 움직이며, 6면 큐브 섀도우맵으로 사방의 그림자를 계산합니다.",
    control: "궤도 회전 (Azimuth / Elevation, 자동 궤도)",
  },
];

const TECH = [
  {
    tag: "Geometry",
    title: "하이트맵 변위 메시",
    body: "512×512 그리드를 버텍스 셰이더에서 하이트맵으로 밀어 올립니다. 8bit 하이트맵의 256단계 계단은 compute 셰이더의 가우시안 필터로 완화합니다.",
  },
  {
    tag: "Self-shadow",
    title: "하이트필드 레이마칭 그림자",
    body: "그림 면은 높이장이므로 픽셀마다 광원 방향으로 높이장을 직접 따라가며 가림을 판정합니다. 섀도우맵으로는 표현할 수 없는 1mm 이하의 붓자국 그림자를 화면 밖까지 정확히 계산합니다.",
  },
  {
    tag: "Shadow map",
    title: "PCSS 소프트 섀도우",
    body: "캔버스가 벽에 드리우는 큰 그림자는 조명별 섀도우맵(방향광: 직교, 스팟: 원근, 포인트: 6면)으로 처리하고, 차폐물과의 거리에 비례해 반그림자를 넓힙니다.",
  },
  {
    tag: "Ambient",
    title: "Horizon-based AO",
    body: "하이트맵에서 8방향의 지평선 고도각을 미리 계산해 오목한 홈과 물감 사이 골짜기를 어둡게 만듭니다.",
  },
  {
    tag: "Ray tracing",
    title: "Compute 패스트레이싱",
    body: "WebGPU에는 하드웨어 레이트레이싱 API가 없으므로 compute 셰이더에서 평면·박스·하이트필드를 직접 교차 계산합니다. 프레임마다 1 spp씩 누적하며 간접광과 면광원 그림자까지 수렴합니다.",
  },
  {
    tag: "Pipeline",
    title: "WGSL 모듈 분리",
    body: "모든 셰이더는 .wgsl 파일로 분리되어 문자열로 import 됩니다. 행렬 연산은 wgpu-matrix(0~1 깊이 범위)를 사용합니다.",
  },
];

export default function Home() {
  return (
    <>
      <header className={styles.header}>
        <a href="#top" className={styles.logo}>
          Atelier <em>Impasto</em>
        </a>
        <nav className={styles.nav} aria-label="섹션">
          <a href="#work">작품</a>
          <a href="#light">빛</a>
          <a href="#tech">기술</a>
          <a href="#contact">문의</a>
        </nav>
      </header>

      <main>
        <Hero />

        <section id="work" className={styles.section}>
          <div className={styles.inner}>
            <p className={styles.kicker}>01 — Work</p>
            <div className={styles.workGrid}>
              <div>
                <h2 className={styles.h2}>봄 들판의 결</h2>
                <dl className={styles.meta}>
                  <div>
                    <dt>재료</dt>
                    <dd>캔버스에 유채, 팔레트 나이프</dd>
                  </div>
                  <div>
                    <dt>크기</dt>
                    <dd>90 × 90 × 3.5 cm (렌더링 기준)</dd>
                  </div>
                  <div>
                    <dt>표면</dt>
                    <dd>최대 두께 약 5 mm 임파스토</dd>
                  </div>
                </dl>
              </div>
              <div className={styles.prose}>
                <p>
                  흐린 라벤더빛 바탕 위로 가는 줄기들이 위로 뻗고, 그 끝에 분홍·노랑·보라의 꽃잎이 나이프로 눌러 찍혀 있습니다.
                  색은 옅지만 물감은 두껍습니다. 정면에서 고르게 비추면 평평한 수채화처럼 보이다가, 빛을 옆으로 눕히는 순간
                  꽃잎 하나하나가 두께를 가진 조각처럼 일어섭니다.
                </p>
                <p>
                  이 페이지의 히어로는 작품 사진(컬러맵)과 표면 높이를 담은 하이트맵을 결합해 그 순간을 실시간으로 재현합니다.
                  오른쪽 인스펙터에서 조명을 돌려 보세요.
                </p>
              </div>
            </div>

            <ul className={styles.details}>
              {DETAILS.map((d) => (
                <li key={d.caption}>
                  <span className={styles.crop} style={{ backgroundPosition: d.pos }} />
                  <span className={styles.caption}>{d.caption}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="light" className={`${styles.section} ${styles.alt}`}>
          <div className={styles.inner}>
            <p className={styles.kicker}>02 — Light</p>
            <h2 className={styles.h2}>빛으로 읽는 질감</h2>
            <p className={styles.sectionLede}>
              임파스토는 빛의 각도에 따라 전혀 다른 그림이 됩니다. 세 종류의 조명을 Unity의 Light 컴포넌트처럼 독립적으로
              켜고 끄며, 색·색온도·세기·그림자 종류·해상도·Bias를 각각 조절할 수 있습니다.
            </p>
            <div className={styles.cards3}>
              {LIGHTS.map((l) => (
                <article key={l.name} className={styles.lightCard}>
                  <header>
                    <h3>{l.name}</h3>
                    <span>{l.role}</span>
                  </header>
                  <p>{l.body}</p>
                  <p className={styles.control}>{l.control}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="tech" className={styles.section}>
          <div className={styles.inner}>
            <p className={styles.kicker}>03 — Rendering</p>
            <h2 className={styles.h2}>그림자를 두 단계로 나눈 이유</h2>
            <p className={styles.sectionLede}>
              캔버스가 벽에 드리우는 센티미터 단위의 그림자와 붓자국이 옆 붓자국에 드리우는 1밀리미터 안팎의 그림자는
              크기가 수십 배 차이 납니다. 하나의 섀도우맵으로는 둘 다 담을 수 없어, 큰 그림자는 섀도우맵으로, 작은 그림자는
              하이트필드 레이마칭으로 계산해 곱합니다. 화면 공간(Screen-space) 방식은 시점에 따라 그림자가 사라져 사용하지
              않았습니다.
            </p>
            <div className={styles.techGrid}>
              {TECH.map((t) => (
                <article key={t.title} className={styles.techCard}>
                  <span className={styles.tag}>{t.tag}</span>
                  <h3>{t.title}</h3>
                  <p>{t.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className={`${styles.section} ${styles.alt}`}>
          <div className={`${styles.inner} ${styles.contact}`}>
            <div>
              <p className={styles.kicker}>04 — Visit</p>
              <h2 className={styles.h2}>직접 보면 더 두껍습니다</h2>
              <p className={styles.sectionLede}>
                전시와 작품 문의는 메일로 받습니다. 아래 정보는 예시이며 실제 연락처로 교체해 사용하세요.
              </p>
            </div>
            <dl className={styles.contactList}>
              <div>
                <dt>Mail</dt>
                <dd>
                  <a href="mailto:hello@example.com">hello@example.com</a>
                </dd>
              </div>
              <div>
                <dt>Hours</dt>
                <dd>화–일 11:00 – 19:00</dd>
              </div>
              <div>
                <dt>Browser</dt>
                <dd>WebGPU 지원 브라우저 (Chrome / Edge 113+, Safari 26+)</dd>
              </div>
            </dl>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Atelier Impasto — WebGPU heightmap rendering study</span>
        <a href="#top">맨 위로 ↑</a>
      </footer>
    </>
  );
}
