"use client";

import { useId } from "react";

/** Frame for an interactive diagram inside a lesson: a title, the diagram, one line of takeaway. */
export function Explorable({ title, children, caption }: { title: string; children: React.ReactNode; caption?: React.ReactNode }) {
  return (
    <figure className="my-7 rounded-lg border border-line bg-panel px-4 sm:px-5 py-4 not-prose">
      <figcaption className="font-semibold text-[15px] mb-3">{title}</figcaption>
      {children}
      {caption && <p className="text-[13px] text-muted mt-3">{caption}</p>}
    </figure>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-3 text-[13px] mb-1">
        <label htmlFor={id}>{label}</label>
        <span className="num text-muted">{format ? format(value) : value}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </div>
  );
}

export function Segmented<T extends string | number>({
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
    <div className="min-w-0">
      <div className="text-[13px] mb-1">{label}</div>
      <div className="inline-flex flex-wrap rounded-md border border-line overflow-hidden" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={`px-2.5 py-1 text-[13px] ${value === o.value ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Controls sit in a row above the chart. */
export function ControlRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 mb-4">{children}</div>;
}

/** A big number with a plain-words label: for results that are one value, not a chart. */
export function Readout({ label, value, tone }: { label: string; value: string; tone?: "warn" | "crit" | "ok" }) {
  const color = tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--text)";
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="num text-[1.35rem] leading-tight" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
