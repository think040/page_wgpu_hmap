"use client";

// 관리자용 인스펙터: height-map / color-map 두 장을 올려 작품 목록에 새 item 을 추가한다.
// 지금은 Hero 위에 임시로 띄우지만, 사용자 인스펙터와 의존 관계가 없으므로
// 관리자 페이지를 만들면 이 컴포넌트를 그 페이지로 옮겨 렌더하기만 하면 된다.

import { useEffect, useId, useState } from "react";
import { getArtworkLibrary } from "@/scene/artworks";
import { useArtworks } from "@/scene/useArtworks";
import { Section } from "@/components/hero/fields";
import base from "@/components/hero/inspector.module.css";
import styles from "./admin.module.css";

interface Picked {
  file: File;
  url: string;
  width: number;
  height: number;
}

async function inspectImage(file: File): Promise<Picked> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name}: 이미지 파일이 아닙니다.`);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: 이 브라우저에서 디코드할 수 없는 이미지입니다.`);
  }
  const picked = { file, url: URL.createObjectURL(file), width: bmp.width, height: bmp.height };
  bmp.close();
  return picked;
}

function FilePick({
  label,
  hint,
  value,
  onPick,
}: {
  label: string;
  hint: string;
  value: Picked | null;
  onPick: (file: File) => void;
}) {
  const id = useId();
  return (
    <div className={styles.pick}>
      <label htmlFor={id} className={styles.drop} data-filled={!!value}>
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- 로컬 blob 미리보기
          <img src={value.url} alt={`${label} 미리보기`} className={styles.preview} />
        ) : (
          <span className={styles.placeholder}>+</span>
        )}
      </label>
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp"
        className={styles.hiddenInput}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <div className={styles.pickMeta}>
        <strong>{label}</strong>
        <span>{value ? `${value.file.name} · ${value.width}×${value.height}` : hint}</span>
      </div>
    </div>
  );
}

export function AdminInspector({ onClose }: { onClose: () => void }) {
  const { items } = useArtworks();
  const [name, setName] = useState("");
  const [heightPick, setHeightPick] = useState<Picked | null>(null);
  const [colorPick, setColorPick] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 미리보기 URL 해제
  useEffect(() => () => void (heightPick && URL.revokeObjectURL(heightPick.url)), [heightPick]);
  useEffect(() => () => void (colorPick && URL.revokeObjectURL(colorPick.url)), [colorPick]);

  const pick = (set: (p: Picked) => void) => (file: File) => {
    setError(null);
    inspectImage(file).then(set, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const warnings: string[] = [];
  if (heightPick && colorPick && (heightPick.width !== colorPick.width || heightPick.height !== colorPick.height))
    warnings.push("두 이미지의 해상도가 다릅니다. 같은 크기를 권장합니다.");
  for (const p of [heightPick, colorPick])
    if (p && p.width !== p.height) {
      warnings.push("그림 판이 정사각형이라 정사각형이 아닌 이미지는 늘어나 보입니다.");
      break;
    }

  const canAdd = !!heightPick && !!colorPick && !busy;

  const add = async () => {
    if (!heightPick || !colorPick) return;
    setBusy(true);
    setError(null);
    try {
      await getArtworkLibrary().add({ name, color: colorPick.file, height: heightPick.file });
      setName("");
      setHeightPick(null);
      setColorPick(null);
    } catch (e) {
      setError(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`"${label}" 을(를) 목록에서 삭제할까요?`)) return;
    try {
      await getArtworkLibrary().remove(id);
    } catch (e) {
      setError(`삭제하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <aside className={`${base.panel} ${styles.panel}`} aria-label="관리자 작품 등록">
      <div className={base.titleBar}>
        <span className={base.title}>Admin · Artworks</span>
        <button type="button" className={base.close} onClick={onClose} aria-label="관리자 패널 닫기">
          ×
        </button>
      </div>

      <div className={base.scroll}>
        <Section title="새 작품 등록">
          <label className={base.row}>
            <span className={base.label}>Name</span>
            <input
              className={styles.text}
              type="text"
              value={name}
              maxLength={60}
              placeholder="작품 이름"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <FilePick label="Height Map" hint="밝을수록 높음 (흑백 권장)" value={heightPick} onPick={pick(setHeightPick)} />
          <FilePick label="Color Map" hint="그림 색상 이미지" value={colorPick} onPick={pick(setColorPick)} />
          {warnings.map((w) => (
            <p key={w} className={base.warning}>
              {w}
            </p>
          ))}
          {error && (
            <p className={base.warning} role="alert">
              {error}
            </p>
          )}
          <div className={base.buttonRow}>
            <button type="button" className={`${base.button} ${styles.primary}`} disabled={!canAdd} onClick={add}>
              {busy ? "저장 중…" : "목록에 추가"}
            </button>
          </div>
          <p className={base.note}>PNG · JPG · WebP 등 이미지 파일. 지금은 이 브라우저(IndexedDB)에만 저장됩니다.</p>
        </Section>

        <Section title={`등록된 작품 (${items.length})`}>
          <ul className={styles.list}>
            {items.map((a) => (
              <li key={a.id} className={styles.item}>
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬/정적 썸네일 */}
                <img src={a.colorUrl} alt="" className={styles.thumb} />
                <span className={styles.itemName}>{a.name}</span>
                {a.builtin ? (
                  <span className={styles.tag}>기본</span>
                ) : (
                  <button type="button" className={styles.remove} onClick={() => remove(a.id, a.name)} aria-label={`${a.name} 삭제`}>
                    삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </aside>
  );
}
