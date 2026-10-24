import type { ComponentKind, Graph, NodeStats, Snapshot } from "@/engine/model/types";

/**
 * A goal is a condition on the live system that must hold for `holdMs`
 * of simulated time. `mem` lets a goal remember things across snapshots,
 * such as "a server has been crashed at some point".
 */
export interface Goal {
  id: string;
  text: string;
  hint?: string;
  holdMs: number;
  check: (snap: Snapshot, graph: Graph, mem: Record<string, unknown>) => boolean;
}

export interface Preset {
  id: string;
  title: string;
  graph: Graph;
  /** Components you can add from the palette. Empty = structure is fixed. */
  palette: ComponentKind[];
  goals: Goal[];
}

/* Helpers for writing goals */

export const ofKind = (snap: Snapshot, kind: ComponentKind): NodeStats[] =>
  Object.values(snap.nodes).filter((n) => n.kind === kind);

/** Combined view of what all clients experience. */
export function clientView(snap: Snapshot) {
  const cs = ofKind(snap, "client");
  const sending = cs.reduce((a, c) => a + (c.sendingRps ?? 0), 0);
  const ok = cs.reduce((a, c) => a + c.okPerSec, 0);
  const err = cs.reduce((a, c) => a + c.errorsPerSec, 0);
  return {
    sending,
    ok,
    err,
    errorRate: ok + err ? err / (ok + err) : 0,
    p99: Math.max(0, ...cs.map((c) => c.p99)),
    active: ok + err > 0,
  };
}

export const countKind = (graph: Graph, kind: ComponentKind) => graph.nodes.filter((n) => n.kind === kind).length;
