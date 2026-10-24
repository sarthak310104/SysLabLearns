"use client";

interface Series {
  values: number[];
  color: string;
}

/** A tiny live chart. Series share one y-scale starting at zero. */
export function Sparkline({ series, height = 44, label }: { series: Series[]; height?: number; label: string }) {
  const width = 240;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const pts = (vals: number[]) =>
    vals
      .map((v, i) => `${((i + (n - vals.length)) / (n - 1)) * width},${height - (v / max) * (height - 2) - 1}`)
      .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} role="img" aria-label={label}>
      <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} stroke="var(--line)" />
      {series.map((s, i) =>
        s.values.length > 1 ? (
          <polyline key={i} points={pts(s.values)} fill="none" stroke={s.color} strokeWidth="1.5" strokeLinejoin="round" />
        ) : null,
      )}
    </svg>
  );
}
