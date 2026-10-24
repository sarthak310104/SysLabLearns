import type { Ctx, Handlers, InFlight, NodeId, NodeRec, ProtocolSpec, Step, Timer, World } from "./types";

/* ------------------------------------------------------------------ */
/* Deterministic randomness, stored in the world itself                */
/* ------------------------------------------------------------------ */

function nextRandom(w: World): number {
  w.rng = (w.rng + 0x6d2b79f5) >>> 0;
  let t = w.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Worlds are plain JSON data, and a JSON round trip copies them faster than structuredClone. */
export function clone<T>(x: T): T {
  return x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
}

/** Learner state must be plain data; this copy also turns Maps, functions and cycles into a clear error. */
function plain<T>(x: T, where: string): T {
  if (x === undefined) return x;
  try {
    const json = JSON.stringify(x);
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`${where}: state must be plain data (objects, arrays, strings, numbers, booleans).`);
  }
}

const MAX_LOGS = 80;

/**
 * Runs handlers against a world. One per run: it holds the compiled roles.
 */
export class Runtime {
  constructor(
    public spec: ProtocolSpec,
    private roles: Record<string, Handlers>,
  ) {}

  /** A fresh world: every node initialised, every client handed its first command. */
  init(mode: World["mode"], seed: number, workload = this.spec.workload): World {
    const w: World = {
      mode,
      nodes: {},
      msgs: [],
      timers: [],
      clock: 0,
      seq: 1,
      rng: seed >>> 0 || 1,
      workload: {},
      history: [],
      faults: { drops: 0, dups: 0, crashes: 0 },
      error: null,
      healing: false,
      logs: [],
      lost: 0,
    };
    for (const n of this.spec.nodes) w.nodes[n.id] = { role: n.role, state: {}, crashed: false };
    for (const n of this.spec.nodes) this.call(w, n.id, "init");
    for (const [client, cmds] of Object.entries(workload ?? {})) {
      w.workload[client] = { pending: clone(cmds), current: null };
      this.issueNext(w, client);
    }
    return w;
  }

  /** Has every client finished its commands? */
  done(w: World): boolean {
    if (this.spec.done) return this.spec.done(w);
    return Object.values(w.workload).every((wl) => wl.current === null && wl.pending.length === 0);
  }

  /* ---------------- handler calls ---------------- */

  private ctx(w: World, self: NodeId): Ctx {
    const spec = this.spec;
    return {
      self,
      nodes: (role?: string) => spec.nodes.filter((n) => n.id !== self && (!role || n.role === role)).map((n) => n.id),
      send: (to, msg) => this.send(w, self, to, msg),
      setTimer: (name, ms, data) => {
        if (typeof name !== "string") throw new Error("setTimer needs a name");
        w.timers.push({ seq: w.seq++, node: self, name, data: data === undefined ? null : clone(data), due: w.clock + Math.max(0, Number(ms) || 0) });
      },
      random: () => nextRandom(w),
      log: (text) => {
        if (w.mode === "explore") return; // logs aren't part of the state, so a search skips them
        w.logs = [...w.logs, { t: w.clock, node: self, text: String(text) }].slice(-MAX_LOGS);
      },
      reply: (value) => {
        const wl = w.workload[self];
        if (!wl || wl.current === null) return; // nothing to reply to: ignore duplicates
        w.history.push({ client: self, kind: "ok", cmd: wl.current, value: clone(value), t: w.clock });
        wl.current = null;
      },
    };
  }

  /** Call a handler; its return value (if any) replaces the node's state. */
  private call(w: World, node: NodeId, fn: keyof Handlers, ...args: unknown[]): void {
    // Worlds share unchanged parts with their parent, so copy before changing anything.
    const old = w.nodes[node];
    const rec: NodeRec = { ...old, state: fn === "init" ? old.state : clone(old.state) };
    w.nodes[node] = rec;
    const h = this.roles[rec.role];
    const f = h?.[fn] as ((...a: unknown[]) => unknown) | undefined;
    if (!f) return;
    try {
      const ctx = this.ctx(w, node);
      const out = fn === "init" ? f.call(h, ctx) : f.call(h, rec.state, ...args, ctx);
      if (fn === "init") rec.state = out === undefined ? {} : out;
      else if (out !== undefined) rec.state = out;
      // Keep state as plain data: this also catches functions or cycles early.
      rec.state = plain(rec.state, `${node} (${rec.role})`);
    } catch (e) {
      w.error ??= `${node} (${rec.role}) ${fn} threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (rec.role && w.workload[node]) this.issueNext(w, node);
  }

  private issueNext(w: World, client: NodeId): void {
    const wl = w.workload[client];
    if (!wl || wl.current !== null || !wl.pending.length || w.nodes[client].crashed) return;
    wl.current = wl.pending.shift()!;
    w.history.push({ client, kind: "invoke", cmd: wl.current, t: w.clock });
    this.call(w, client, "onCommand", clone(wl.current));
  }

  /* ---------------- the network ---------------- */

  private send(w: World, from: NodeId, to: NodeId, msg: unknown): void {
    if (!w.nodes[to]) throw new Error(`send: there's no node called "${to}"`);
    const body = clone(msg);
    if (w.mode === "explore") {
      // The network is a set: a message can be delivered any number of times,
      // in any order, or never. That covers loss and duplication at once.
      const fresh: InFlight = { seq: w.seq, from, to, msg: body, due: 0 };
      const key = stableKey(fresh);
      if (!w.msgs.some((m) => stableKey(m) === key)) {
        w.seq++;
        w.msgs.push(fresh);
      }
      return;
    }
    const net = this.spec.network;
    const delay = () => net.delayMin + nextRandom(w) * (net.delayMax - net.delayMin);
    if (!w.healing && nextRandom(w) < net.drop) {
      w.lost++;
      return;
    }
    w.msgs.push({ seq: w.seq++, from, to, msg: body, due: w.clock + delay() });
    if (!w.healing && nextRandom(w) < net.duplicate) w.msgs.push({ seq: w.seq++, from, to, msg: clone(body), due: w.clock + delay() });
  }

  /* ---------------- steps ---------------- */

  /**
   * A new world that shares everything with its parent. Containers are copied
   * so they can change; anything a step modifies is copied before modifying.
   */
  private fork(world: World): World {
    return {
      ...world,
      nodes: { ...world.nodes },
      msgs: [...world.msgs],
      timers: [...world.timers],
      workload: clone(world.workload),
      history: [...world.history],
      faults: { ...world.faults },
    };
  }

  /** Apply one step to a copy of the world. The original is never changed. */
  apply(world: World, step: Step): World {
    const w = this.fork(world);
    switch (step.type) {
      case "deliver": {
        const i = w.msgs.findIndex((m) => m.seq === step.seq);
        if (i < 0) break;
        // In explore mode the message stays in the network: it may arrive again.
        const m = w.mode === "explore" ? w.msgs[i] : w.msgs.splice(i, 1)[0];
        if (w.mode === "timed") w.clock = Math.max(w.clock, m.due);
        if (!w.nodes[m.to].crashed) this.call(w, m.to, "onMessage", m.from, clone(m.msg));
        break;
      }
      case "drop": {
        const i = w.msgs.findIndex((m) => m.seq === step.seq);
        if (i >= 0) w.msgs.splice(i, 1);
        w.faults.drops++;
        break;
      }
      case "duplicate": {
        const m = w.msgs.find((x) => x.seq === step.seq);
        if (m) w.msgs.push({ ...clone(m), seq: w.seq++ });
        w.faults.dups++;
        break;
      }
      case "timer": {
        const i = w.timers.findIndex((t) => t.seq === step.seq);
        if (i < 0) break;
        const [t] = w.timers.splice(i, 1);
        w.clock = Math.max(w.clock, t.due);
        if (!w.nodes[t.node].crashed) this.call(w, t.node, "onTimer", { name: t.name, data: clone(t.data) });
        break;
      }
      case "crash": {
        w.nodes[step.node] = { ...w.nodes[step.node], crashed: true };
        w.timers = w.timers.filter((t) => t.node !== step.node);
        w.faults.crashes++;
        break;
      }
      case "restart": {
        w.nodes[step.node] = { ...w.nodes[step.node], crashed: false, state: {} };
        this.call(w, step.node, "init");
        if (w.workload[step.node]) this.issueNext(w, step.node);
        break;
      }
      case "heal":
        w.healing = true;
        break;
    }
    return w;
  }

  /** The earliest pending timer of each node: in any ordering, a node's timers fire in due order. */
  firstTimers(w: World): Timer[] {
    const first = new Map<NodeId, Timer>();
    for (const t of w.timers) {
      const cur = first.get(t.node);
      if (!cur || t.due < cur.due || (t.due === cur.due && t.seq < cur.seq)) first.set(t.node, t);
    }
    return [...first.values()];
  }

  /** Timed mode: the next event in time order. */
  nextTimed(w: World): Step | null {
    let best: { due: number; seq: number; step: Step } | null = null;
    const consider = (due: number, seq: number, step: Step) => {
      if (!best || due < best.due || (due === best.due && seq < best.seq)) best = { due, seq, step };
    };
    for (const m of w.msgs) consider(m.due, m.seq, { type: "deliver", seq: m.seq });
    for (const t of this.firstTimers(w)) consider(t.due, t.seq, { type: "timer", seq: t.seq });
    return (best as { step: Step } | null)?.step ?? null;
  }

  /**
   * Explore mode: everything that could happen next. Any message in the
   * network can be delivered (again); loss and duplication need no extra steps.
   */
  enabled(w: World, budget = this.spec.budget): Step[] {
    const steps: Step[] = [];
    for (const m of w.msgs) steps.push({ type: "deliver", seq: m.seq });
    if (budget.timers !== false) for (const t of this.firstTimers(w)) steps.push({ type: "timer", seq: t.seq });
    if (w.faults.crashes < budget.crashes) {
      for (const id of this.spec.crashable ?? []) if (!w.nodes[id].crashed) steps.push({ type: "crash", node: id });
    }
    if (this.spec.restart) for (const id of this.spec.crashable ?? []) if (w.nodes[id].crashed) steps.push({ type: "restart", node: id });
    return steps;
  }

  /** Only these invariants are checked (all of them if unset): labs check in stages. */
  only: string[] | null = null;

  /** First broken invariant, or null. A handler that threw always counts. */
  violation(w: World): { name: string; message: string } | null {
    if (w.error) return { name: "Your code threw an error", message: w.error };
    for (const inv of this.spec.invariants) {
      if (this.only && !this.only.includes(inv.name)) continue;
      let msg: string | null = null;
      try {
        msg = inv.check(w);
      } catch (e) {
        msg = `checking "${inv.name}" failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (msg) return { name: inv.name, message: msg };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Canonical form of a world, for spotting states already explored     */
/* ------------------------------------------------------------------ */

/** Sorts object keys as JSON.stringify walks the value, so equal states give equal strings. */
function sortKeys(_key: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as object);
    if (keys.length < 2) return v;
    keys.sort();
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = (v as Record<string, unknown>)[k];
    return o;
  }
  return v;
}

/** Canonical JSON: the same value always gives the same string, whatever order its keys were added in. */
export function stable(x: unknown): string {
  return JSON.stringify(x, sortKeys) ?? "null";
}

/**
 * Worlds share unchanged objects, so each object's canonical string can be
 * computed once and reused by every world that contains it.
 */
const pieceCache = new WeakMap<object, string>();
function cached(o: object, make: () => string): string {
  let s = pieceCache.get(o);
  if (s === undefined) {
    s = make();
    pieceCache.set(o, s);
  }
  return s;
}

function stableKey(m: InFlight): string {
  return cached(m, () => stable([m.from, m.to, m.msg]));
}

/**
 * Two worlds that only differ in message ids, absolute times or logs are the
 * same state: the future can unfold identically from both.
 */
/** Canonical string for one node's state, cached on the (never-changed-again) record. */
export function nodeKey(r: NodeRec): string {
  return cached(r, () => stable(r.state));
}

export function canonical(w: World): string {
  const nodes = Object.keys(w.nodes)
    .sort()
    .map((id) => {
      const r = w.nodes[id];
      return `${id}${r.crashed ? "!" : ""}=${nodeKey(r)}`;
    })
    .join(";");
  const msgs = w.msgs.map(stableKey).sort().join("|");
  const timers = [...w.timers]
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : a.due - b.due || a.seq - b.seq))
    .map((t) => `${t.node}/${t.name}/${cached(t, () => stable(t.data))}/${t.due - w.clock}`)
    .join("|");
  const history = w.history.map((e) => cached(e, () => stable([e.client, e.kind, e.cmd, e.value]))).join("|");
  return `${nodes}#${msgs}#${timers}#${history}#${stable(w.workload)}#${w.faults.drops},${w.faults.dups},${w.faults.crashes}#${w.rng}#${w.error ?? ""}`;
}

/** Human-readable description of a step, for traces. */
export function describeStep(w: World, step: Step): string {
  const show = (m: unknown) => {
    const s = JSON.stringify(m);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  switch (step.type) {
    case "deliver":
    case "drop":
    case "duplicate": {
      const m = w.msgs.find((x) => x.seq === step.seq);
      if (!m) return step.type;
      const verb = step.type === "deliver" ? "delivers" : step.type === "drop" ? "loses" : "duplicates";
      return `Network ${verb} ${m.from} to ${m.to}: ${show(m.msg)}`;
    }
    case "timer": {
      const t = w.timers.find((x) => x.seq === step.seq);
      return t ? `Timer "${t.name}" fires on ${t.node}` : "Timer fires";
    }
    case "crash":
      return `${step.node} crashes`;
    case "restart":
      return `${step.node} restarts with empty state`;
    case "heal":
      return "The network stops losing and duplicating messages";
  }
}
