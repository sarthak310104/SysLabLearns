"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Frame } from "@/engine/protocol/check";
import type { ProtocolSpec, Step } from "@/engine/protocol/types";
import { fmtMs, msgLabel, placeNodes, roleColors, sentTimes, stepMessage, VIEW_H, VIEW_W, violationOf } from "./util";

export interface TraceRequest {
  seed: number;
  perfect: boolean;
  steps: Step[];
}

interface Props {
  spec: ProtocolSpec;
  frames: Frame[] | null;
  steps: Step[];
  /** Where these frames came from: a run you started, or a failure found by a check. */
  source: { kind: "run"; seed: number; perfect: boolean } | { kind: "failure"; title: string };
  loading: boolean;
  error: string | null;
  onTrace: (req: TraceRequest, jumpTo?: number) => void;
  /** Frame to show first after new frames arrive. */
  startAt?: number;
}

const SPEEDS = [0.5, 1, 2, 4];

export function RunView({ spec, frames, steps, source, loading, error, onTrace, startAt = 0 }: Props) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [seed, setSeed] = useState(source.kind === "run" ? source.seed : 1);
  const [perfect, setPerfect] = useState(source.kind === "run" ? source.perfect : false);
  const [anim, setAnim] = useState(0); // 0..1 progress from frame idx toward idx+1
  const placed = useMemo(() => placeNodes(spec), [spec]);
  const pos = useMemo(() => Object.fromEntries(placed.map((p) => [p.id, p])), [placed]);
  const colors = useMemo(() => roleColors(spec), [spec]);
  const sent = useMemo(() => (frames ? sentTimes(frames) : new Map<number, number>()), [frames]);

  useEffect(() => {
    setIdx(Math.min(startAt, Math.max(0, (frames?.length ?? 1) - 1)));
    setAnim(0);
  }, [frames, startAt]);

  // Playback: glide the clock from one frame to the next, then advance.
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !frames) return;
    if (idx >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const a = frames[idx].world.clock;
    const b = frames[idx + 1].world.clock;
    const timed = frames[idx].world.mode === "timed";
    const duration = Math.min(700, Math.max(90, (timed ? (b - a) * 40 : 450) / speed));
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setAnim(p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else {
        setAnim(0);
        setIdx((i) => i + 1);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, idx, frames, speed]);

  if (error) {
    return (
      <div className="p-5">
        <p className="text-crit font-medium">Your code couldn&apos;t run</p>
        <pre className="mt-2 whitespace-pre-wrap text-[13px] text-muted font-mono">{error}</pre>
      </div>
    );
  }
  if (!frames) {
    return <div className="p-5 text-muted">{loading ? "Running your code..." : "Press Run to start."}</div>;
  }

  const frame = frames[idx];
  const w = frame.world;
  const timed = w.mode === "timed";
  const nextFrame = frames[idx + 1];
  const clock = timed && nextFrame && playing ? w.clock + (nextFrame.world.clock - w.clock) * anim : w.clock;
  const violation = violationOf(spec, w);
  const firstBad = frames.findIndex((f) => violationOf(spec, f.world));
  const delivered = stepMessage(frames[idx - 1]?.world, frame);
  const selRec = selected ? w.nodes[selected] : null;
  const ops = w.history.filter((e) => e.kind === "ok");
  const finished = idx === frames.length - 1;

  const inject = (step: Step) => {
    if (source.kind !== "run") return;
    onTrace({ seed, perfect, steps: [...steps.slice(0, idx), step] }, idx + 1);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line text-[13px]">
        {source.kind === "run" ? (
          <>
            <label className="flex items-center gap-1 text-muted">
              Seed
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value) || 1)}
                className="w-16 rounded border border-line bg-panel-2 px-1.5 py-0.5 num text-text"
              />
            </label>
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={perfect} onChange={(e) => setPerfect(e.target.checked)} className="accent-[var(--accent)]" />
              Perfect network
            </label>
            <button className="btn-accent px-2.5 py-1 rounded" onClick={() => onTrace({ seed, perfect, steps: [] })} disabled={loading}>
              {loading ? "Running..." : "Run again"}
            </button>
          </>
        ) : (
          <span className="text-muted">
            Replaying: <span className="text-text">{source.title}</span>
          </span>
        )}
        <span className="flex-1" />
        <button className="ctl" onClick={() => setIdx(0)} aria-label="Back to start" disabled={idx === 0}>
          ⏮
        </button>
        <button className="ctl" onClick={() => setIdx((i) => Math.max(0, i - 1))} aria-label="Step back" disabled={idx === 0}>
          ◀
        </button>
        <button className="ctl w-16" onClick={() => setPlaying((p) => !p)} disabled={finished}>
          {playing ? "Pause" : "Play"}
        </button>
        <button className="ctl" onClick={() => setIdx((i) => Math.min(frames.length - 1, i + 1))} aria-label="Step forward" disabled={finished}>
          ▶
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-line bg-panel-2 px-1 py-0.5" aria-label="Speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>

      {/* Scrubber */}
      <div className="px-3 pt-2 flex items-center gap-3 text-[12px] text-muted">
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          className="flex-1 accent-[var(--accent)]"
          aria-label="Step"
        />
        <span className="num whitespace-nowrap text-right">
          step {idx} / {frames.length - 1}
          {timed && ` · ${fmtMs(clock)}`}
        </span>
      </div>
      {firstBad >= 0 && firstBad !== idx && (
        <button className="mx-3 mt-1 text-left text-[12px] text-crit hover:underline" onClick={() => setIdx(firstBad)}>
          Something breaks at step {firstBad}. Jump there.
        </button>
      )}

      {/* Network picture */}
      <div className="px-3 pt-2">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-auto rounded-md border border-line bg-bg" role="img" aria-label="Nodes and messages in flight">
          {placed.map((a, i) =>
            placed.slice(i + 1).map((b) => <line key={a.id + b.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--grid)" strokeWidth={1} />),
          )}
          {delivered && pos[delivered.from] && pos[delivered.to] && (
            <line
              x1={pos[delivered.from].x}
              y1={pos[delivered.from].y}
              x2={pos[delivered.to].x}
              y2={pos[delivered.to].y}
              stroke="var(--accent)"
              strokeWidth={2}
              opacity={0.8}
              className="neon-line"
            />
          )}
          {w.msgs.map((m) => {
            const a = pos[m.from];
            const b = pos[m.to];
            if (!a || !b) return null;
            let p = 0.5;
            if (timed) {
              const s = sent.get(m.seq) ?? w.clock;
              p = m.due > s ? Math.min(0.97, Math.max(0.03, (clock - s) / (m.due - s))) : 0.5;
            }
            return (
              <g key={m.seq}>
                <circle cx={a.x + (b.x - a.x) * p} cy={a.y + (b.y - a.y) * p} r={5} fill="var(--signal)" className="msg-dot">
                  <title>
                    {m.from} to {m.to}: {msgLabel(m.msg)}
                  </title>
                </circle>
              </g>
            );
          })}
          {placed.map((p) => {
            const rec = w.nodes[p.id];
            const isSel = selected === p.id;
            return (
              <g key={p.id} onClick={() => setSelected(isSel ? null : p.id)} className="cursor-pointer" role="button" aria-label={`${p.label}${rec.crashed ? ", crashed" : ""}`}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={26}
                  fill="var(--panel)"
                  stroke={rec.crashed ? "var(--crit)" : colors[p.role]}
                  strokeWidth={isSel ? 3.5 : 2}
                  strokeDasharray={rec.crashed ? "4 3" : undefined}
                />
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={13} fill={rec.crashed ? "var(--crit)" : "var(--text)"} className="num">
                  {p.id}
                </text>
                <text x={p.x} y={p.y + 44} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {rec.crashed ? "crashed" : p.role}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* What just happened */}
      <div className="px-3 py-2 text-[13px]">
        <p>
          <span className="text-muted">Step {idx}: </span>
          {frame.desc}
        </p>
        {!timed && <p className="text-[12px] text-muted mt-0.5">This run comes from the model checker, where any message can arrive at any time, more than once, or never.</p>}
        {violation && (
          <p className="mt-1 text-crit">
            <span className="font-medium">{violation.name}.</span> {violation.message}
          </p>
        )}
        {finished && !violation && (
          <p className="mt-1 text-muted">{w.history.length && ops.length === w.history.filter((e) => e.kind === "invoke").length ? "Every command finished." : "The run stopped here."}</p>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 min-h-0 overflow-y-auto border-t border-line grid sm:grid-cols-2 gap-0">
        <div className="p-3 sm:border-r border-line min-w-0">
          {selected && selRec ? (
            <>
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{pos[selected]?.label ?? selected}</h3>
                <span className="flex-1" />
                {source.kind === "run" && spec.crashable?.includes(selected) && (!selRec.crashed || spec.restart) && (
                  <button className="ctl text-[12px]" onClick={() => inject({ type: selRec.crashed ? "restart" : "crash", node: selected })} disabled={loading}>
                    {selRec.crashed ? "Restart it here" : "Crash it here"}
                  </button>
                )}
              </div>
              <pre className="mt-2 text-[12px] font-mono whitespace-pre-wrap break-words text-muted">{JSON.stringify(selRec.state, null, 2)}</pre>
              {w.logs.filter((l) => l.node === selected).length > 0 && (
                <ul className="mt-2 text-[12px] space-y-0.5">
                  {w.logs
                    .filter((l) => l.node === selected)
                    .slice(-8)
                    .map((l, i) => (
                      <li key={i}>
                        <span className="num text-muted">{fmtMs(l.t)}</span> {l.text}
                      </li>
                    ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-[13px] text-muted">Click a node to see its state{spec.crashable?.length && source.kind === "run" ? " or crash it at this step" : ""}.</p>
          )}
        </div>
        <div className="p-3 min-w-0">
          <h3 className="font-medium">Results so far</h3>
          {ops.length === 0 ? (
            <p className="text-[13px] text-muted mt-1">Nothing has finished yet.</p>
          ) : (
            <ul className="mt-1 text-[12px] font-mono space-y-0.5">
              {ops.slice(-12).map((e, i) => (
                <li key={i} className="truncate">
                  <span className="text-muted">{e.client}</span> {msgLabel(e.cmd)} <span className="text-signal">→ {JSON.stringify(e.value)}</span>
                </li>
              ))}
            </ul>
          )}
          {timed && (w.lost > 0 || w.faults.dups > 0) && (
            <p className="text-[12px] text-muted mt-2">
              Lost so far: <span className="num">{w.lost}</span>. Duplicated: <span className="num">{w.faults.dups}</span>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
