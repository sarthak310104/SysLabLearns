"use client";

import { useEffect, useMemo, useState } from "react";
import type { ComponentKind, Graph, Snapshot } from "@/engine/model/types";
import { explainSystem } from "@/lib/explain";
import { findings, HEALTH_COLOR, verdictOf, type Verdict } from "@/lib/health";

const VERDICT: Record<Verdict, { title: string; color: string; blurb: string }> = {
  idle: { title: "Not running", color: "var(--line)", blurb: "Press Send traffic to run your design." },
  healthy: { title: "Healthy", color: "var(--h-good)", blurb: "Every component has room to spare and requests are succeeding." },
  improve: { title: "Could be better", color: "var(--h-strained)", blurb: "It works, but something is close to its limit." },
  failing: { title: "Failing", color: "var(--h-failing)", blurb: "Requests are being lost or turned away." },
};

const LEGEND: [string, string][] = [
  ["var(--h-ideal)", "Plenty of room"],
  ["var(--h-good)", "Busy, healthy"],
  ["var(--h-strained)", "Could be better"],
  ["var(--h-failing)", "Overloaded or failing"],
];

/**
 * A floating verdict over the canvas: is this design working, and if not,
 * what to look at first. Same colors as the links and components.
 */
export function HealthPanel({
  snapshot,
  labels,
  kinds,
  onSelect,
  defaultOpen = true,
  canAdd,
  graph,
}: {
  graph?: Graph;
  canAdd?: ComponentKind[];
  defaultOpen?: boolean;
  snapshot: Snapshot | null;
  labels: Record<string, string>;
  kinds: Record<string, ComponentKind>;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [explain, setExplain] = useState(false);
  // On a phone the panel would cover the diagram, so it starts closed there.
  useEffect(() => {
    if (defaultOpen && window.innerWidth < 1024) setOpen(false);
  }, [defaultOpen]);
  // Recompute at most a few times a second; snapshots arrive ten times a second.
  const tick = snapshot ? Math.floor(snapshot.time / 400) : -1;
  const { verdict, fs } = useMemo(() => {
    if (!snapshot) return { verdict: "idle" as Verdict, fs: [] };
    const fs = findings(snapshot.nodes, labels, kinds, snapshot.cutEdges.length, canAdd);
    return { verdict: verdictOf(snapshot.nodes, fs), fs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, labels, kinds, canAdd]);
  const v = VERDICT[verdict];

  return (
    <div className="absolute top-3 right-3 z-10 w-[280px] max-w-[calc(100%-1.5rem)] max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-lg border border-line bg-panel/95 backdrop-blur text-[12px] shadow-lg">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: v.color, boxShadow: verdict === "idle" ? undefined : `0 0 8px ${v.color}` }} />
        <span className="font-semibold text-[13px]">{v.title}</span>
        {fs.length > 0 && <span className="text-muted">· {fs.length} to look at</span>}
        <span className="ml-auto text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-line">
          <p className="text-muted mt-2">{v.blurb}</p>
          {fs.length > 0 && (
            <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
              {fs.slice(0, 6).map((f, i) => (
                <li key={i}>
                  <button className="flex gap-2 text-left hover:text-text text-text/90" onClick={() => f.nodeId && onSelect(f.nodeId)}>
                    <span className="mt-1 h-2 w-2 rounded-full shrink-0" style={{ background: HEALTH_COLOR[f.health] }} aria-hidden="true" />
                    <span>{f.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {graph && (
            <div className="mt-2">
              <button className="text-accent text-[12px]" onClick={() => setExplain((e) => !e)} aria-expanded={explain}>
                {explain ? "Hide the explanation" : "Explain what's happening"}
              </button>
              {explain && (
                <div className="mt-1.5 space-y-1.5 text-text/90 max-h-56 overflow-y-auto">
                  {explainSystem(graph, snapshot).map((t, i) => (
                    <p key={i}>{t}</p>
                  ))}
                  <p className="text-muted">Click any component for what's happening inside it.</p>
                </div>
              )}
            </div>
          )}
          <div className="mt-3 pt-2 border-t border-line grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Color key">
            {LEGEND.map(([c, label]) => (
              <span key={label} className="flex items-center gap-1.5 text-muted">
                <span className="h-1 w-4 rounded-full" style={{ background: c }} />
                {label}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-muted">Thicker lines carry more traffic. Red links also march.</p>
        </div>
      )}
    </div>
  );
}
