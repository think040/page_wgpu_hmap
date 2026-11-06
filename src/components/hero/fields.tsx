"use client";

import type { ReactNode } from "react";
import styles from "./inspector.module.css";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span>{title}</span>
        {aside}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function decimals(step: number) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const d = decimals(step);
  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <input
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={styles.numberWrap}>
        <input
          className={styles.number}
          type="number"
          step={step}
          value={Number(value.toFixed(d))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
        {unit && <span className={styles.unit}>{unit}</span>}
      </span>
    </label>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.toggleCell}>
        <input type="checkbox" className={styles.checkbox} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </span>
    </label>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <select
        className={styles.select}
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  preview,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  preview?: string;
}) {
  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.colorCell}>
        <input type="color" className={styles.color} value={value} onChange={(e) => onChange(e.target.value)} />
        {preview && <span className={styles.swatch} style={{ background: preview }} title="최종 광원 색" />}
        <code className={styles.hex}>{value}</code>
      </span>
    </label>
  );
}

export function Vec3Field({
  label,
  value,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  step?: number;
  onChange: (v: [number, number, number]) => void;
}) {
  const d = decimals(step);
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.vec}>
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <label key={axis} className={styles.vecItem}>
            <span className={styles.axis} data-axis={axis}>
              {axis}
            </span>
            <input
              className={styles.number}
              type="number"
              step={step}
              value={Number(value[i].toFixed(d))}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                const next = [...value] as [number, number, number];
                next[i] = v;
                onChange(next);
              }}
            />
          </label>
        ))}
      </span>
    </div>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className={styles.buttonRow}>{children}</div>;
}
