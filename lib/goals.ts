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
  /** A ladder of hints instead of one: a nudge, a direction, then nearly the answer. */
  hints?: string[];
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

export interface GoalProgress {
  fraction: number;
  done: boolean;
}

/** Tracks how long each goal's condition has held. Shared by the lab and the tests. */
export class GoalTracker {
  private start = new Map<string, number>();
  private mem = new Map<string, Record<string, unknown>>();
  private lastTime = 0;
  readonly done: Set<string>;

  constructor(
    private goals: Goal[],
    alreadyDone: Iterable<string> = [],
  ) {
    this.done = new Set(alreadyDone);
  }

  /** Feed one snapshot; returns progress for every goal not done before this call. */
  update(snap: Snapshot, graph: Graph): Map<string, GoalProgress> {
    const out = new Map<string, GoalProgress>();
    if (snap.time < this.lastTime) {
      // The simulation restarted.
      this.start.clear();
      this.mem.clear();
    }
    this.lastTime = snap.time;
    for (const g of this.goals) {
      if (this.done.has(g.id)) continue;
      let mem = this.mem.get(g.id);
      if (!mem) this.mem.set(g.id, (mem = {}));
      let ok = false;
      try {
        ok = g.check(snap, graph, mem);
      } catch {
        ok = false;
      }
      let fraction = 0;
      if (ok) {
        const s = this.start.get(g.id) ?? snap.time;
        this.start.set(g.id, s);
        fraction = g.holdMs ? Math.min(1, (snap.time - s) / g.holdMs) : 1;
      } else this.start.delete(g.id);
      const done = fraction >= 1;
      if (done) this.done.add(g.id);
      out.set(g.id, { fraction, done });
    }
    return out;
  }
}

/* Helpers for writing goals */

export const ofKind = (snap: Snapshot, kind: ComponentKind): NodeStats[] => Object.values(snap.nodes).filter((n) => n.kind === kind);

/** Combined view of what all clients experience. */
export function clientView(snap: Snapshot) {
  const cs = ofKind(snap, "client");
  const sending = cs.reduce((a, c) => a + (c.sendingRps ?? 0), 0);
  const attempts = cs.reduce((a, c) => a + (c.attemptsPerSec ?? 0), 0);
  const ok = cs.reduce((a, c) => a + c.okPerSec, 0);
  const err = cs.reduce((a, c) => a + c.errorsPerSec, 0);
  return {
    sending,
    attempts,
    amplification: sending > 0 ? attempts / sending : 1,
    ok,
    err,
    errorRate: ok + err ? err / (ok + err) : 0,
    p99: Math.max(0, ...cs.map((c) => c.p99)),
    active: ok + err > 0,
  };
}

export const countKind = (graph: Graph, kind: ComponentKind) => graph.nodes.filter((n) => n.kind === kind).length;

export function configOf<T>(graph: Graph, kind: ComponentKind): T[] {
  return graph.nodes.filter((n) => n.kind === kind).map((n) => n.config as T);
}

/** Ids of nodes that a node of `fromKind` sends to, e.g. the consumers of a queue. */
export function targetsOf(graph: Graph, fromKind: ComponentKind): string[] {
  const from = new Set(graph.nodes.filter((n) => n.kind === fromKind).map((n) => n.id));
  return graph.edges.filter((e) => from.has(e.source)).map((e) => e.target);
}
