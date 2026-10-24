"use client";

import { useMemo, useRef, useState } from "react";

/*
 * Small SVG charts for lessons. One y-axis per chart, thin marks, a legend
 * whenever there are two or more series, direct labels at line ends, a
 * crosshair tooltip on hover, and a table view for anyone not reading colour.
 */

export interface Series {
  name: string;
  /** Index into the validated series palette, 1-4. */
  color: 1 | 2 | 3 | 4;
  points: [number, number][];
  dashed?: boolean;
}

export interface RefLine {
  y: number;
  label: string;
}

const W = 560;
const PAD = { l: 48, r: 92, t: 12, b: 34 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

export function LineChart({
  series,
  xLabel,
  yLabel,
  xFormat = (v) => String(Math.round(v)),
  yFormat = (v) => String(Math.round(v)),
  yMax,
  refLines = [],
  marker,
  height = 240,
  ariaLabel,
}: {
  series: Series[];
  xLabel: string;
  yLabel: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  yMax?: number;
  refLines?: RefLine[];
  /** A vertical line marking "you are here". */
  marker?: { x: number; label: string };
  height?: number;
  ariaLabel: string;
}) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const all = series.flatMap((s) => s.points);
  const xMin = Math.min(...all.map((p) => p[0]));
  const xMax = Math.max(...all.map((p) => p[0]));
  const finite = all.map((p) => p[1]).filter(Number.isFinite);
  const yTop = yMax ?? niceMax(Math.max(1, ...finite, ...refLines.map((r) => r.y)));
  const iw = W - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * iw;
  const sy = (y: number) => PAD.t + ih - (Math.min(y, yTop) / yTop) * ih;

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = "";
        let pen = false;
        for (const [x, y] of s.points) {
          if (!Number.isFinite(y)) {
            pen = false;
            continue;
          }
          d += `${pen ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
          pen = true;
        }
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, yTop, xMin, xMax, height],
  );

  // Nearest x among the first series' points, for the crosshair.
  const xs = series[0]?.points.map((p) => p[0]) ?? [];
  const nearest = hoverX === null ? null : xs.reduce((a, b) => (Math.abs(b - hoverX) < Math.abs(a - hoverX) ? b : a), xs[0]);
  const valueAt = (s: Series, x: number) => s.points.find((p) => p[0] === x)?.[1];

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) return setHoverX(null);
    setHoverX(xMin + ((px - PAD.l) / iw) * (xMax - xMin));
  };

  return (
    <div>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted mb-1.5" aria-hidden="true">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <svg width="16" height="8">
                <line x1="0" y1="4" x2="16" y2="4" stroke={`var(--series-${s.color})`} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className="w-full touch-none"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverX(null)}
      >
        {ticks(yTop).map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" strokeWidth="1" opacity={t === 0 ? 1 : 0.5} />
            <text x={PAD.l - 6} y={sy(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)" className="num">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {ticks(xMax - xMin).map((t) => (
          <text key={t} x={sx(xMin + t)} y={height - PAD.b + 16} textAnchor="middle" fontSize="11" fill="var(--muted)" className="num">
            {xFormat(xMin + t)}
          </text>
        ))}
        <text x={PAD.l + iw / 2} y={height - 3} textAnchor="middle" fontSize="11" fill="var(--muted)">
          {xLabel}
        </text>
        <text x={12} y={PAD.t + ih / 2} textAnchor="middle" fontSize="11" fill="var(--muted)" transform={`rotate(-90 12 ${PAD.t + ih / 2})`}>
          {yLabel}
        </text>
        {refLines.map((r) => (
          <g key={r.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(r.y)} y2={sy(r.y)} stroke="var(--muted)" strokeDasharray="4 4" />
            <text x={W - PAD.r + 6} y={sy(r.y) + 4} fontSize="11" fill="var(--muted)">
              {r.label}
            </text>
          </g>
        ))}
        {marker && (
          <g>
            <line x1={sx(marker.x)} x2={sx(marker.x)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--text)" strokeWidth="1" opacity="0.5" />
            <text x={sx(marker.x)} y={PAD.t + 10} textAnchor={sx(marker.x) > W - PAD.r - 60 ? "end" : "start"} dx={sx(marker.x) > W - PAD.r - 60 ? -4 : 4} fontSize="11" fill="var(--text)">
              {marker.label}
            </text>
          </g>
        )}
        {series.map((s, i) => (
          <path key={s.name} d={paths[i]} fill="none" stroke={`var(--series-${s.color})`} strokeWidth="2" strokeDasharray={s.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* Direct labels at the end of each line (up to four series). */}
        {series.length <= 4 &&
          series.map((s) => {
            const last = [...s.points].reverse().find((p) => Number.isFinite(p[1]));
            if (!last) return null;
            return (
              <text key={s.name} x={sx(last[0]) + 6} y={sy(last[1]) + 4} fontSize="11" fill="var(--text)">
                {s.name}
              </text>
            );
          })}
        {nearest !== null && (
          <g pointerEvents="none">
            <line x1={sx(nearest)} x2={sx(nearest)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--muted)" strokeWidth="1" />
            {series.map((s) => {
              const v = valueAt(s, nearest);
              return v !== undefined && Number.isFinite(v) ? (
                <circle key={s.name} cx={sx(nearest)} cy={sy(v)} r="4" fill={`var(--series-${s.color})`} stroke="var(--panel)" strokeWidth="2" />
              ) : null;
            })}
          </g>
        )}
      </svg>
      {nearest !== null && (
        <div className="text-[12px] num mt-1 flex flex-wrap gap-x-4" aria-live="polite">
          <span className="text-muted">
            {xLabel}: {xFormat(nearest)}
          </span>
          {series.map((s) => {
            const v = valueAt(s, nearest);
            return (
              <span key={s.name}>
                {s.name}: {v === undefined || !Number.isFinite(v) ? "off the chart" : yFormat(v)}
              </span>
            );
          })}
        </div>
      )}
      <button className="text-[12px] text-muted hover:text-text mt-1" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
        {showTable ? "Hide the numbers" : "Show the numbers"}
      </button>
      {showTable && (
        <div className="overflow-x-auto mt-1">
          <table className="text-[12px] num border-collapse">
            <thead>
              <tr>
                <th className="text-left pr-4 font-medium">{xLabel}</th>
                {series.map((s) => (
                  <th key={s.name} className="text-left pr-4 font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs
                .filter((_, i) => i % Math.max(1, Math.floor(xs.length / 12)) === 0)
                .map((x) => (
                  <tr key={x}>
                    <td className="pr-4 text-muted">{xFormat(x)}</td>
                    {series.map((s) => {
                      const v = valueAt(s, x);
                      return (
                        <td key={s.name} className="pr-4">
                          {v === undefined || !Number.isFinite(v) ? "-" : yFormat(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  /** Highlight this bar in the accent colour; others stay neutral. */
  highlight?: boolean;
  /** Mark this bar as over a limit: drawn in the warning tone, with a label. */
  over?: boolean;
}

/** Horizontal bars, so long labels fit on narrow screens. */
export function BarChart({
  bars,
  max,
  format = (v) => String(Math.round(v)),
  limit,
  ariaLabel,
}: {
  bars: Bar[];
  max?: number;
  format?: (v: number) => string;
  limit?: RefLine;
  ariaLabel: string;
}) {
  const top = max ?? niceMax(Math.max(1, ...bars.map((b) => b.value), limit?.y ?? 0));
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="relative">
        {limit && (
          <div className="absolute top-0 bottom-0 border-l border-dashed border-muted pointer-events-none" style={{ left: `calc(7.5rem + (100% - 7.5rem - 4.5rem) * ${Math.min(1, limit.y / top)})` }}>
            <span className="absolute -top-0.5 left-1 text-[11px] text-muted whitespace-nowrap">{limit.label}</span>
          </div>
        )}
        <ul className="space-y-1.5 pt-4">
          {bars.map((b) => (
            <li key={b.label} className="flex items-center gap-2 text-[12px]">
              <span className="w-[7rem] shrink-0 truncate text-muted" title={b.label}>
                {b.label}
              </span>
              <span className="flex-1 h-3.5 rounded-sm bg-panel-2 overflow-hidden">
                <span
                  className="block h-full rounded-sm transition-[width] duration-200"
                  style={{ width: pct(b.value), background: b.over ? "var(--warn)" : b.highlight ? "var(--series-1)" : "var(--series-2)" }}
                />
              </span>
              <span className="w-[4rem] shrink-0 text-right num">
                {format(b.value)}
                {b.over ? " !" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
