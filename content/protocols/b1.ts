import type { Handlers, NodeId, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B1: logical clocks.
 *
 * Three processes do local work and message each other at random. The lab
 * secretly tracks the true happens-before relation and checks the learner's
 * timestamps against it:
 *   - Lamport clocks: if a happened before b, L(a) < L(b).
 *   - Vector clocks:  V(a) < V(b) exactly when a happened before b.
 */

type Vec = Record<NodeId, number>;

interface ClockApi {
  init(self: NodeId, everyone: NodeId[]): unknown;
  localEvent(state: any): unknown;
  send(state: any): unknown;
  receive(state: any, stamp: any): unknown;
}

interface Event {
  id: string;
  kind: "local" | "send" | "receive";
  lamport: unknown;
  vector: unknown;
  /** The true causal history, known only to the lab. */
  truth: Vec;
}

interface ProcState {
  lamport: unknown;
  vector: unknown;
  truth: Vec;
  events: Event[];
  actions: number;
}

const PROCS = ["p1", "p2", "p3"];
const ACTIONS = 8;

function api(user: Record<string, unknown>, name: string): ClockApi {
  const a = user[name] as ClockApi | undefined;
  if (!a || typeof a !== "object") throw new Error(`Your code needs to export \`${name}\`, an object with init, localEvent, send and receive.`);
  for (const f of ["init", "localEvent", "send", "receive"] as const) {
    if (typeof a[f] !== "function") throw new Error(`\`${name}.${f}\` is missing.`);
  }
  return a;
}

const tick = (v: Vec, me: NodeId): Vec => ({ ...v, [me]: (v[me] ?? 0) + 1 });
const merge = (a: Vec, b: Vec): Vec => {
  const out: Vec = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
};
/** a happened before b, by the true clocks. */
const before = (a: Vec, b: Vec) => {
  let strictly = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] ?? 0) > (b[k] ?? 0)) return false;
    if ((a[k] ?? 0) < (b[k] ?? 0)) strictly = true;
  }
  return strictly;
};

function process(user: Record<string, unknown>): Handlers {
  const lam = api(user, "lamport");
  const vec = api(user, "vector");
  const record = (s: ProcState, me: NodeId, kind: Event["kind"], lamport: unknown, vector: unknown) => {
    s.events.push({ id: `${me}.${s.events.length + 1}`, kind, lamport, vector, truth: s.truth });
  };
  return {
    init(ctx) {
      const state: ProcState = {
        lamport: lam.init(ctx.self, PROCS),
        vector: vec.init(ctx.self, PROCS),
        truth: {},
        events: [],
        actions: 0,
      };
      ctx.setTimer("act", 1 + ctx.random() * 9);
      return state;
    },
    onTimer(s: ProcState, _t, ctx) {
      if (s.actions >= ACTIONS) return;
      s.actions++;
      s.truth = tick(s.truth, ctx.self);
      if (ctx.random() < 0.4) {
        record(s, ctx.self, "local", lam.localEvent(s.lamport), vec.localEvent(s.vector));
      } else {
        const peers = ctx.nodes("process");
        const to = peers[Math.floor(ctx.random() * peers.length)];
        const l = lam.send(s.lamport);
        const v = vec.send(s.vector);
        record(s, ctx.self, "send", l, v);
        ctx.send(to, { lamport: l, vector: v, truth: s.truth });
      }
      if (s.actions < ACTIONS) ctx.setTimer("act", 1 + ctx.random() * 9);
    },
    onMessage(s: ProcState, _from, msg, ctx) {
      s.truth = tick(merge(s.truth, msg.truth), ctx.self);
      record(s, ctx.self, "receive", lam.receive(s.lamport, msg.lamport), vec.receive(s.vector, msg.vector));
    },
  };
}

function allEvents(w: World): Event[] {
  return PROCS.flatMap((p) => (w.nodes[p].state as ProcState).events ?? []);
}

const show = (x: unknown) => JSON.stringify(x);

export function lamportRespectsCausality(w: World): string | null {
  const evs = allEvents(w);
  for (const a of evs) {
    if (typeof a.lamport !== "number") return `Event ${a.id} got the Lamport timestamp ${show(a.lamport)}, which isn't a number.`;
  }
  for (const a of evs)
    for (const b of evs) {
      if (a !== b && before(a.truth, b.truth) && !((a.lamport as number) < (b.lamport as number))) {
        return `Event ${a.id} (${a.kind}) happened before ${b.id} (${b.kind}), but their Lamport timestamps are ${show(a.lamport)} and ${show(b.lamport)}.`;
      }
    }
  return null;
}

function vecLess(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return before(a as Vec, b as Vec);
}

export function vectorsCaptureCausality(w: World): string | null {
  const evs = allEvents(w);
  for (const a of evs)
    for (const b of evs) {
      if (a === b) continue;
      const truly = before(a.truth, b.truth);
      const claimed = vecLess(a.vector, b.vector);
      if (truly && !claimed) return `${a.id} happened before ${b.id}, but their vectors ${show(a.vector)} and ${show(b.vector)} don't show it.`;
      if (!truly && claimed) return `${a.id} and ${b.id} are ${before(b.truth, a.truth) ? "in the other order" : "concurrent"}, but the vectors ${show(a.vector)} < ${show(b.vector)} claim ${a.id} came first.`;
    }
  return null;
}

export const B1: ProtocolSpec = {
  id: "b1-clocks",
  nodes: PROCS.map((p, i) => ({ id: p, role: "process", label: `Process ${i + 1}` })),
  roles: (user) => ({ process: process(user) }),
  invariants: [
    { name: "Lamport clocks respect causality", check: lamportRespectsCausality, why: "An event got a timestamp no bigger than something that happened before it. Usually the receive didn't jump past the stamp the message carried." },
    { name: "Vector clocks capture causality exactly", check: vectorsCaptureCausality, why: "Comparing two of your stamps gave the wrong answer about which came first. Check that each process bumps only its own slot, that receive merges before it ticks, and that you return a copy rather than the vector itself." },
  ],
  network: { delayMin: 1, delayMax: 25, drop: 0, duplicate: 0 },
  budget: { maxDepth: 12, maxStates: 50000, crashes: 0 },
  done: (w) => w.msgs.length === 0 && PROCS.every((p) => (w.nodes[p].state as ProcState).actions >= ACTIONS),
};

export const B1_STARTER = `// Logical clocks. The lab runs three processes that do local work and send
// each other messages. It calls your functions at every event and checks the
// timestamps against what really happened.
//
// Each object keeps whatever state you like (returned by init). The other
// functions may change that state and return the timestamp for the event.

export const lamport = {
  init(self, everyone) {
    return { time: 0 };
  },
  // Something happened on this process. Return its timestamp.
  localEvent(state) {
    state.time += 1;
    return state.time;
  },
  // This process is sending a message. Return the timestamp to send with it.
  send(state) {
    state.time += 1;
    return state.time;
  },
  // A message arrived carrying the sender's timestamp. Return the receive event's timestamp.
  receive(state, stamp) {
    state.time += 1; // TODO: this ignores the sender's clock
    return state.time;
  },
};

export const vector = {
  init(self, everyone) {
    // TODO: one counter per process, e.g. { p1: 0, p2: 0, p3: 0 }
    return {};
  },
  localEvent(state) {
    return {};
  },
  send(state) {
    return {};
  },
  receive(state, stamp) {
    return {};
  },
};
`;
