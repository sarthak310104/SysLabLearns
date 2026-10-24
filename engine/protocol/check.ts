import type { ProtocolSpec, Step, World } from "./types";
import { canonical, describeStep, nodeKey, Runtime } from "./world";

export interface Failure {
  name: string;
  message: string;
  /** The steps from the starting world that lead to the failure. */
  steps: Step[];
  mode: World["mode"];
  seed: number;
  /** Explore-mode failures start from the smaller checker workload. */
  checkerWorkload: boolean;
}

/* ------------------------------------------------------------------ */
/* Random simulation                                                   */
/* ------------------------------------------------------------------ */

export interface SimulateOptions {
  runs: number;
  /** Events per run while faults are on. */
  maxSteps: number;
  /** Events allowed after faults stop, to finish the work. */
  healSteps: number;
  seed: number;
  /** Chance per event that a crashable node crashes (up to the budget). */
  crashChance: number;
  /** Events before a crashed node restarts, if the lab allows restarts. */
  restartAfter: number;
  onProgress?: (done: number) => void;
}

export interface SimulateResult {
  ok: boolean;
  runs: number;
  failure: Failure | null;
}

/** Many seeded runs with messages lost, duplicated and delayed at random. */
export function simulate(rt: Runtime, opts: SimulateOptions): SimulateResult {
  const spec = rt.spec;
  for (let r = 0; r < opts.runs; r++) {
    const seed = opts.seed + r * 7919;
    let w = rt.init("timed", seed);
    const steps: Step[] = [];
    let chaos = seed ^ 0x5bd1e995;
    const roll = () => {
      chaos = (Math.imul(chaos ^ (chaos >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0;
      return ((chaos >>> 0) % 100000) / 100000;
    };
    const downSince = new Map<string, number>();
    const fail = (name: string, message: string): SimulateResult => ({
      ok: false,
      runs: r + 1,
      failure: { name, message, steps, mode: "timed", seed, checkerWorkload: false },
    });
    const take = (step: Step) => {
      steps.push(step);
      w = rt.apply(w, step);
    };

    let finished = false;
    for (let i = 0; i < opts.maxSteps; i++) {
      // Crashes and restarts happen between events.
      const crashable = spec.crashable ?? [];
      if (crashable.length && w.faults.crashes < spec.budget.crashes && roll() < opts.crashChance) {
        const up = crashable.filter((id) => !w.nodes[id].crashed);
        if (up.length) {
          const id = up[Math.floor(roll() * up.length)];
          take({ type: "crash", node: id });
          downSince.set(id, i);
        }
      }
      if (spec.restart) {
        for (const [id, since] of downSince) {
          if (i - since >= opts.restartAfter) {
            take({ type: "restart", node: id });
            downSince.delete(id);
          }
        }
      }
      const next = rt.nextTimed(w);
      if (!next) break;
      take(next);
      const v = rt.violation(w);
      if (v) return fail(v.name, v.message);
      if (rt.done(w)) {
        finished = true;
        break;
      }
    }

    if (!finished) {
      // Stop the faults and give the system a fair chance to finish.
      take({ type: "heal" });
      if (spec.restart) for (const id of [...downSince.keys()]) take({ type: "restart", node: id });
      for (let i = 0; i < opts.healSteps && !rt.done(w); i++) {
        const next = rt.nextTimed(w);
        if (!next) break;
        take(next);
        const v = rt.violation(w);
        if (v) return fail(v.name, v.message);
      }
      if (!rt.done(w)) {
        const waiting = Object.entries(w.workload)
          .filter(([, wl]) => wl.current !== null || wl.pending.length)
          .map(([id, wl]) => `${id} (waiting on ${JSON.stringify(wl.current)})`);
        return fail(
          "Work never finishes",
          `Even after the network stopped losing messages, some commands never completed: ${waiting.join(", ")}. A lost message or crash must be leaving something stuck.`,
        );
      }
    }
    opts.onProgress?.(r + 1);
  }
  return { ok: true, runs: opts.runs, failure: null };
}

/* ------------------------------------------------------------------ */
/* Model checking: breadth-first search over every ordering            */
/* ------------------------------------------------------------------ */

/**
 * Cheap test for a step that changed nothing: same node state, nothing new
 * sent, scheduled or recorded. Most re-deliveries in a search are like this.
 */
function unchanged(before: World, after: World, step: Step): boolean {
  if (step.type !== "deliver") return false;
  if (after.msgs.length !== before.msgs.length || after.timers.length !== before.timers.length) return false;
  if (after.history.length !== before.history.length || after.error !== before.error || after.rng !== before.rng) return false;
  const m = before.msgs.find((x) => x.seq === step.seq);
  if (!m) return false;
  return nodeKey(after.nodes[m.to]) === nodeKey(before.nodes[m.to]);
}

/** 53-bit hash of a string: compact keys for the visited set. */
function hash(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface CheckOptions {
  maxStates?: number;
  maxDepth?: number;
  /** Give up after this much wall-clock time. */
  timeLimitMs?: number;
  onProgress?: (states: number, depth: number) => void;
}

export interface CheckResult {
  ok: boolean;
  /** States looked at. */
  states: number;
  /** Deepest level fully searched. */
  depth: number;
  /** True if every state within the depth bound was searched. */
  complete: boolean;
  /** Some explored state had every client finished. */
  reachedDone: boolean;
  failure: Failure | null;
}

/**
 * Explore every reachable state, shortest paths first, so a violation comes
 * with the shortest sequence of events that causes it.
 */
export function modelCheck(rt: Runtime, opts: CheckOptions = {}): CheckResult {
  const spec: ProtocolSpec = rt.spec;
  const maxStates = opts.maxStates ?? spec.budget.maxStates;
  const maxDepth = opts.maxDepth ?? spec.budget.maxDepth;
  const deadline = Date.now() + (opts.timeLimitMs ?? 20000);
  const useChecker = Boolean(spec.checkerWorkload);
  const start = rt.init("explore", 1, spec.checkerWorkload ?? spec.workload);

  const parent = new Map<number, { from: number | null; step: Step | null }>();
  const startKey = hash(canonical(start));
  parent.set(startKey, { from: null, step: null });

  const trace = (key: number): Step[] => {
    const steps: Step[] = [];
    let k: number | null = key;
    while (k !== null) {
      const p: { from: number | null; step: Step | null } = parent.get(k)!;
      if (p.step) steps.push(p.step);
      k = p.from;
    }
    return steps.reverse();
  };

  let frontier: { w: World; key: number }[] = [{ w: start, key: startKey }];
  let states = 1;
  let depth = 0;
  let reachedDone = rt.done(start);
  const v0 = rt.violation(start);
  if (v0) return { ok: false, states, depth, complete: true, reachedDone, failure: { ...v0, steps: [], mode: "explore", seed: 1, checkerWorkload: useChecker } };

  while (frontier.length && depth < maxDepth) {
    const next: { w: World; key: number }[] = [];
    for (const { w, key } of frontier) {
      for (const step of rt.enabled(w)) {
        const child = rt.apply(w, step);
        if (unchanged(w, child, step)) continue; // e.g. a message delivered again, to no effect
        const ck = hash(canonical(child));
        if (parent.has(ck)) continue;
        parent.set(ck, { from: key, step });
        states++;
        const v = rt.violation(child);
        if (v) {
          return { ok: false, states, depth: depth + 1, complete: false, reachedDone, failure: { ...v, steps: trace(ck), mode: "explore", seed: 1, checkerWorkload: useChecker } };
        }
        if (!reachedDone && rt.done(child)) reachedDone = true;
        next.push({ w: child, key: ck });
        if (states >= maxStates || Date.now() > deadline) {
          return { ok: true, states, depth, complete: false, reachedDone, failure: null };
        }
      }
    }
    depth++;
    frontier = next;
    opts.onProgress?.(states, depth);
  }
  return { ok: true, states, depth, complete: frontier.length === 0 || depth >= maxDepth, reachedDone, failure: null };
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

export interface Frame {
  world: World;
  /** What happened to get here (empty for the starting world). */
  desc: string;
  step: Step | null;
}

/** Rebuild every world along a failing run, for the replay view. */
export function replay(rt: Runtime, f: Failure): Frame[] {
  let w = rt.init(f.mode, f.seed, f.checkerWorkload ? rt.spec.checkerWorkload : rt.spec.workload);
  const frames: Frame[] = [{ world: w, desc: "Start", step: null }];
  for (const step of f.steps) {
    const desc = describeStep(w, step);
    w = rt.apply(w, step);
    frames.push({ world: w, desc, step });
  }
  return frames;
}
