import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";
import { stable } from "@/engine/protocol/world";

/*
 * B8: CRDTs (conflict-free replicated data types).
 *
 * Three replicas each take updates locally, with no coordination, and gossip
 * their whole state to a random peer every so often. The learner writes two
 * data types, each with init, update functions, value and merge:
 *   counter: increments and decrements (a PN-counter)
 *   set:     add and remove, where a concurrent add wins (an OR-set)
 *
 * The lab runs a correct implementation alongside the learner's, fed the
 * same updates and the same merges in the same order. Any correct CRDT with
 * these meanings gives exactly the same value, so every replica's value is
 * compared with it after every step.
 */

const REPLICAS = ["r1", "r2", "r3"];
const GOSSIP_MS = 12;

interface CounterApi {
  init(replica: string, replicas: string[]): unknown;
  increment(s: unknown, replica: string): unknown;
  decrement(s: unknown, replica: string): unknown;
  value(s: unknown): number;
  merge(a: unknown, b: unknown): unknown;
}
interface SetApi {
  init(replica: string, replicas: string[]): unknown;
  add(s: unknown, item: string, tag: string): unknown;
  remove(s: unknown, item: string): unknown;
  value(s: unknown): string[];
  merge(a: unknown, b: unknown): unknown;
}

/* ---------------- the lab's reference implementations ---------------- */

type Pn = { p: Record<string, number>; n: Record<string, number> };
const refCounter = {
  init: (): Pn => ({ p: {}, n: {} }),
  increment: (s: Pn, r: string) => ({ ...s, p: { ...s.p, [r]: (s.p[r] ?? 0) + 1 } }),
  decrement: (s: Pn, r: string) => ({ ...s, n: { ...s.n, [r]: (s.n[r] ?? 0) + 1 } }),
  value: (s: Pn) => Object.values(s.p).reduce((a, b) => a + b, 0) - Object.values(s.n).reduce((a, b) => a + b, 0),
  merge(a: Pn, b: Pn): Pn {
    const max = (x: Record<string, number>, y: Record<string, number>) => {
      const o = { ...x };
      for (const [k, v] of Object.entries(y)) o[k] = Math.max(o[k] ?? 0, v);
      return o;
    };
    return { p: max(a.p, b.p), n: max(a.n, b.n) };
  },
};

type Or = { adds: Record<string, string>; removed: Record<string, true> };
const refSet = {
  init: (): Or => ({ adds: {}, removed: {} }),
  add: (s: Or, item: string, tag: string): Or => ({ ...s, adds: { ...s.adds, [tag]: item } }),
  remove(s: Or, item: string): Or {
    const removed = { ...s.removed };
    for (const [tag, it] of Object.entries(s.adds)) if (it === item) removed[tag] = true;
    return { ...s, removed };
  },
  value: (s: Or) => [...new Set(Object.entries(s.adds).filter(([t]) => !s.removed[t]).map(([, it]) => it))].sort(),
  merge: (a: Or, b: Or): Or => ({ adds: { ...a.adds, ...b.adds }, removed: { ...a.removed, ...b.removed } }),
};

/* ---------------- replicas (the lab's), calling the learner's data types ---------------- */

interface ReplicaState {
  counter: unknown;
  set: unknown;
  ref: { counter: Pn; set: Or };
  /** Last command seen from each client, so a repeated message isn't applied twice. */
  seen: Record<string, number>;
  tags: number;
  /** What the learner's value() said after the last step, for the invariants and the trace. */
  shown: { counter: number | null; set: string[] | null };
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function replica(counter: CounterApi, set: SetApi): Handlers {
  const show = (s: ReplicaState) => {
    s.shown = { counter: counter.value(copy(s.counter)), set: [...set.value(copy(s.set))].map(String).sort() };
  };
  return {
    init(ctx) {
      const s: ReplicaState = {
        counter: counter.init(ctx.self, REPLICAS),
        set: set.init(ctx.self, REPLICAS),
        ref: { counter: refCounter.init(), set: refSet.init() },
        seen: {},
        tags: 0,
        shown: { counter: null, set: null },
      };
      show(s);
      ctx.setTimer("gossip", GOSSIP_MS);
      return s;
    },
    onTimer(s: ReplicaState, _t, ctx) {
      const peers = REPLICAS.filter((r) => r !== ctx.self);
      const to = peers[Math.floor(ctx.random() * peers.length)];
      ctx.send(to, { type: "gossip", counter: s.counter, set: s.set, ref: s.ref });
      ctx.setTimer("gossip", GOSSIP_MS);
    },
    onMessage(s: ReplicaState, from, msg, ctx) {
      if (msg?.type === "op") {
        if ((s.seen[from] ?? 0) < msg.seq) {
          s.seen[from] = msg.seq;
          const op = msg.op as { op: string; item?: string };
          if (op.op === "inc") {
            s.counter = counter.increment(s.counter, ctx.self) ?? s.counter;
            s.ref.counter = refCounter.increment(s.ref.counter, ctx.self);
          } else if (op.op === "dec") {
            s.counter = counter.decrement(s.counter, ctx.self) ?? s.counter;
            s.ref.counter = refCounter.decrement(s.ref.counter, ctx.self);
          } else if (op.op === "add") {
            const tag = `${ctx.self}-${++s.tags}`;
            s.set = set.add(s.set, op.item!, tag) ?? s.set;
            s.ref.set = refSet.add(s.ref.set, op.item!, tag);
          } else if (op.op === "remove") {
            s.set = set.remove(s.set, op.item!) ?? s.set;
            s.ref.set = refSet.remove(s.ref.set, op.item!);
          }
          show(s);
        }
        ctx.send(from, { type: "done", seq: msg.seq });
      }
      if (msg?.type === "gossip") {
        s.counter = counter.merge(s.counter, copy(msg.counter));
        s.set = set.merge(s.set, copy(msg.set));
        s.ref = { counter: refCounter.merge(s.ref.counter, msg.ref.counter), set: refSet.merge(s.ref.set, msg.ref.set) };
        show(s);
      }
    },
  };
}

/* ---------------- the lab's clients: each talks to its own replica ---------------- */

interface ClientState {
  seq: number;
  op: unknown;
}

const home = (c: string) => `r${c.slice(1)}`;

const client: Handlers = {
  init: () => ({ seq: 0, op: null }) as ClientState,
  onCommand(s: ClientState, cmd, ctx) {
    s.seq++;
    s.op = cmd;
    ctx.send(home(ctx.self), { type: "op", seq: s.seq, op: cmd });
    ctx.setTimer("retry", 30, s.seq);
  },
  onMessage(s: ClientState, _from, msg, ctx) {
    if (msg?.type === "done" && msg.seq === s.seq && s.op) {
      s.op = null;
      ctx.reply("ok");
    }
  },
  onTimer(s: ClientState, t, ctx) {
    if (t.data !== s.seq || !s.op) return;
    ctx.send(home(ctx.self), { type: "op", seq: s.seq, op: s.op });
    ctx.setTimer("retry", 30, s.seq);
  },
};

/* ---------------- invariants ---------------- */

const rs = (w: World, id: string) => w.nodes[id].state as ReplicaState;

export function counterRight(w: World): string | null {
  for (const id of REPLICAS) {
    const s = rs(w, id);
    if (!s.ref) continue;
    const want = refCounter.value(s.ref.counter);
    if (s.shown?.counter !== want) {
      const incs = Object.values(s.ref.counter.p).reduce((a, b) => a + b, 0);
      const decs = Object.values(s.ref.counter.n).reduce((a, b) => a + b, 0);
      const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
      return `${id}'s counter says ${JSON.stringify(s.shown?.counter)}, but the updates it has heard about are ${n(incs, "increment")} and ${n(decs, "decrement")}, so it should say ${want}.`;
    }
  }
  return null;
}

export function setRight(w: World): string | null {
  for (const id of REPLICAS) {
    const s = rs(w, id);
    if (!s.ref) continue;
    const want = refSet.value(s.ref.set);
    const got = s.shown?.set;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      const extra = (got ?? []).filter((x) => !want.includes(x));
      const missing = want.filter((x) => !(got ?? []).includes(x));
      const why = extra.length
        ? ` It has ${extra.map((x) => `"${x}"`).join(", ")}, which every add it knows of was removed after.`
        : missing.length
          ? ` It's missing ${missing.map((x) => `"${x}"`).join(", ")}: an add the remove never saw has to win.`
          : "";
      return `${id}'s set is ${JSON.stringify(got)}, but from the adds and removes it has heard about it should be ${JSON.stringify(want)}.${why}`;
    }
  }
  return null;
}

function need(user: Record<string, unknown>, name: string): Record<string, unknown> {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with init, value, merge and its update functions.`);
  for (const f of ["init", "value", "merge"]) if (typeof (h as Record<string, unknown>)[f] !== "function") throw new Error(`\`${name}\` needs a ${f} function.`);
  return h as Record<string, unknown>;
}

const ops = (s: string) =>
  s.split(" ").map((w) => {
    if (w === "+") return { op: "inc" };
    if (w === "-") return { op: "dec" };
    return w.startsWith("!") ? { op: "remove", item: w.slice(1) } : { op: "add", item: w };
  });

export const B8: ProtocolSpec = {
  id: "b8-crdt",
  nodes: [
    { id: "r1", role: "replica", label: "Replica 1" },
    { id: "r2", role: "replica", label: "Replica 2" },
    { id: "r3", role: "replica", label: "Replica 3" },
    { id: "c1", role: "client", label: "Client 1" },
    { id: "c2", role: "client", label: "Client 2" },
    { id: "c3", role: "client", label: "Client 3" },
  ],
  labRoles: ["replica", "client"],
  roles: (user) => ({ client, replica: replica(need(user, "counter") as unknown as CounterApi, need(user, "set") as unknown as SetApi) }),
  // "+" and "-" change the counter; a word adds an item; "!word" removes it.
  workload: {
    c1: ops("+ + milk eggs - !milk + bread jam !jam +"),
    c2: ops("+ milk - !eggs + tea + !bread - jam"),
    c3: ops("- !milk eggs + + milk !tea + jam -"),
  },
  // Done once every client has finished and the replicas have all heard everything.
  done: (w) =>
    Object.values(w.workload).every((wl) => wl.current === null && wl.pending.length === 0) &&
    REPLICAS.every((id) => stable(rs(w, id).ref) === stable(rs(w, "r1").ref)),
  invariants: [
    { name: "The counter is right", check: counterRight, why: "Gossip arrives late, twice, and out of order, so merge must give the same answer however many times and in whatever order it's applied. Adding counts double-counts; taking the bigger total loses concurrent updates. Keep a count per replica and merge by taking the larger of each." },
    { name: "The set is right", check: setRight, why: "Merging by union brings removed items back from replicas that still have them. Give each add its tag, have remove mark the tags it saw as removed, and merge both the adds and the removals." },
  ],
  network: { delayMin: 1, delayMax: 8, drop: 0.15, duplicate: 0.15 },
  budget: { maxDepth: 12, maxStates: 80000, crashes: 0, timers: true },
};

export const B8_STARTER = `// CRDTs: data that replicas can change on their own and merge later.
//
// Three replicas take updates locally and, every few milliseconds, send their
// whole state to a random other replica, which merges it in. Messages are
// lost, repeated and reordered. You write two data types; the lab runs them.
//
// Each has init(replica, replicas), its updates, value(state) and merge(a, b).
// Updates may change state in place or return a new one; merge returns the
// merged state. State must be plain data (objects, arrays, numbers, strings).

export const counter = {
  init(replica, replicas) {
    return { count: 0 };
  },
  increment(s, replica) {
    s.count += 1;
  },
  decrement(s, replica) {
    s.count -= 1;
  },
  value(s) {
    return s.count;
  },
  // TODO: two replicas' states meet. Adding them counts everything they both
  // already knew twice, and gossip repeats itself all the time.
  merge(a, b) {
    return { count: a.count + b.count };
  },
};

// A set where, if one replica adds an item while another removes it, the add
// wins. Each add comes with a unique tag (like "r2-5") you can use.
export const set = {
  init(replica, replicas) {
    return { items: [] };
  },
  add(s, item, tag) {
    if (!s.items.includes(item)) s.items.push(item);
  },
  remove(s, item) {
    s.items = s.items.filter((x) => x !== item);
  },
  value(s) {
    return [...s.items].sort();
  },
  // TODO: a union brings back items that were removed here but are still
  // in the other replica's (older) state.
  merge(a, b) {
    return { items: [...new Set([...a.items, ...b.items])] };
  },
};
`;
