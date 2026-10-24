"use client";

import { useMemo, useState } from "react";
import type { Frame } from "@/engine/protocol/check";
import type { ProtocolSpec } from "@/engine/protocol/types";
import { msgLabel, roleColors, stepMessage } from "./util";

const ROW = 26;
const LANE = 92;
const HEAD = 34;
const SHOW_LAST = 250;

/**
 * A failing run as a sequence diagram: one lane per node, one row per step,
 * newest at the bottom. Click a row to see the state it left behind.
 */
export function TraceView({ spec, frames, onWatch, stuck = false }: { spec: ProtocolSpec; frames: Frame[]; onWatch?: (index: number) => void; stuck?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState(frames.length - 1);
  const lanes = spec.nodes.map((n) => n.id);
  const x = (id: string) => LANE / 2 + lanes.indexOf(id) * LANE;
  const colors = useMemo(() => roleColors(spec), [spec]);
  const first = showAll ? 1 : Math.max(1, frames.length - SHOW_LAST);
  const rows = frames.slice(first);
  const width = lanes.length * LANE;
  const height = HEAD + rows.length * ROW + 8;

  // Redeliveries in a model-checker trace are how it shows duplicates.
  const deliveredBefore = useMemo(() => {
    const seen = new Set<number>();
    return frames.map((f) => {
      const s = f.step;
      if (!s || s.type !== "deliver") return false;
      const again = seen.has(s.seq);
      seen.add(s.seq);
      return again;
    });
  }, [frames]);

  const frame = frames[sel];
  const prev = frames[sel - 1];
  const msg = frame ? stepMessage(prev?.world, frame) : null;
  const touched = frame?.step && "node" in frame.step ? frame.step.node : msg?.to;

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted border-b border-line">
        <span>
          {stuck ? `${frames.length - 1} steps, and then nothing else can happen while clients still wait.` : `${frames.length - 1} steps. The last one breaks the rule.`}
        </span>
        <span className="flex-1" />
        {first > 1 && (
          <button className="ctl" onClick={() => setShowAll(true)}>
            Show all {frames.length - 1}
          </button>
        )}
        {onWatch && (
          <button className="ctl" onClick={() => onWatch(sel)}>
            Watch from step {sel}
          </button>
        )}
      </div>
      <div className="overflow-auto max-h-[420px] bg-bg">
        <svg width={width} height={height} className="block" role="img" aria-label="Sequence diagram of the failing run">
          {lanes.map((id) => (
            <g key={id}>
              <line x1={x(id)} y1={HEAD - 6} x2={x(id)} y2={height} stroke="var(--line)" strokeWidth={1} />
              <rect x={x(id) - 34} y={4} width={68} height={22} rx={5} fill="var(--panel)" stroke={colors[spec.nodes.find((n) => n.id === id)!.role]} />
              <text x={x(id)} y={19} textAnchor="middle" fontSize={12} fill="var(--text)" className="num">
                {id}
              </text>
            </g>
          ))}
          {rows.map((f, i) => {
            const index = first + i;
            const y = HEAD + i * ROW + ROW / 2;
            const s = f.step!;
            const isSel = index === sel;
            const isLast = index === frames.length - 1;
            const m = stepMessage(frames[index - 1]?.world, f);
            let mark: React.ReactNode = null;
            if (m && lanes.includes(m.from) && lanes.includes(m.to)) {
              const x1 = x(m.from);
              const x2 = x(m.to);
              const dir = x2 >= x1 ? 1 : -1;
              const again = deliveredBefore[index];
              const color = isLast ? "var(--crit)" : s.type === "drop" ? "var(--muted)" : "var(--accent)";
              mark = (
                <>
                  <line x1={x1} y1={y} x2={x2 - dir * 6} y2={y} stroke={color} strokeWidth={1.5} strokeDasharray={again || s.type === "drop" ? "4 3" : undefined} />
                  <path d={`M${x2} ${y} l${-dir * 7} -4 v8 z`} fill={color} />
                  <text x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                    {again ? "again: " : s.type === "drop" ? "lost: " : ""}
                    {msgLabel(m.msg).slice(0, Math.max(26, Math.abs(x2 - x1) / 5.5))}
                  </text>
                </>
              );
            } else if (s.type === "timer") {
              const t = frames[index - 1]?.world.timers.find((tt) => tt.seq === s.seq);
              if (t) {
                mark = (
                  <>
                    <circle cx={x(t.node)} cy={y} r={5} fill="none" stroke="var(--series-2)" strokeWidth={1.5} />
                    <text x={x(t.node) + 9} y={y + 4} fontSize={10.5} fill="var(--muted)">
                      timer {t.name}
                    </text>
                  </>
                );
              }
            } else if (s.type === "crash" || s.type === "restart") {
              mark = (
                <text x={x(s.node)} y={y + 5} textAnchor="middle" fontSize={14} fill="var(--crit)" fontWeight={600}>
                  {s.type === "crash" ? "✕" : "↻"}
                </text>
              );
            } else if (s.type === "heal") {
              mark = <line x1={8} x2={width - 8} y1={y} y2={y} stroke="var(--signal)" strokeDasharray="2 4" />;
            }
            return (
              <g key={index} onClick={() => setSel(index)} className="cursor-pointer">
                <rect x={0} y={y - ROW / 2} width={width} height={ROW} fill={isSel ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent"} />
                {mark}
              </g>
            );
          })}
        </svg>
      </div>
      {frame && (
        <div className="px-3 py-2 border-t border-line text-[13px] max-h-[240px] overflow-y-auto">
          <p>
            <span className="text-muted">Step {sel}: </span>
            {frame.desc}
          </p>
          {touched && frame.world.nodes[touched] && (
            <>
              <p className="text-[12px] text-muted mt-2">{touched} afterwards:</p>
              <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-muted">{JSON.stringify(frame.world.nodes[touched].state, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
