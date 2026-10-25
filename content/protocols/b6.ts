import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B6: a sharded key-value store.
 *
 * Keys are split into 4 shards (a key's shard is its last digit). A shard
 * controller (the lab's) publishes numbered configurations saying which
 * group owns each shard, and moves shards around as the run goes on. Each
 * group here is a single server, written by the learner. When a shard moves,
 * its data and its duplicate table must move with it, and the new owner must
 * not serve the shard until they arrive.
 */

export const NSHARDS = 4;
export const GROUPS = ["g1", "g2", "g3"];

/** The configurations the controller moves through, and when (simulated ms). */
export const CONFIGS: { at: number; shards: string[] }[] = [
  { at: 0, shards: ["g1", "g1", "g1", "g1"] },
  { at: 60, shards: ["g1", "g1", "g2", "g2"] },
  { at: 120, shards: ["g1", "g3", "g2", "g1"] },
  { at: 180, shards: ["g2", "g3", "g3", "g1"] },
  { at: 240, shards: ["g3", "g2", "g1", "g2"] },
  { at: 300, shards: ["g1", "g1", "g2", "g3"] },
];

interface AppendCmd {
  op: "append";
  key: string;
  value: string;
}

/** Each key belongs to one client, so its value after the i-th acknowledged append is known exactly. */
export function appliedOncePerKey(w: World): string | null {
  const done = new Map<string, string[]>();
  for (const e of w.history) {
    if (e.kind !== "ok") continue;
    const cmd = e.cmd as AppendCmd;
    const vals = done.get(cmd.key) ?? [];
    vals.push(cmd.value);
    done.set(cmd.key, vals);
    const expected = vals.join("");
    if (e.value !== expected) {
      const got = typeof e.value === "string" ? e.value : "";
      const hint = got.length < expected.length ? " Earlier appends to this key are missing: they were made in a group that no longer has them." : got.length > expected.length ? " Something was applied twice." : "";
      return `${e.client} appended "${cmd.value}" to ${cmd.key} and got back ${JSON.stringify(e.value)}, but it should be "${expected}".${hint}`;
    }
  }
  return null;
}

/* ---------------- the lab's shard controller ---------------- */

interface CtrlState {
  current: number;
}

const controller: Handlers = {
  init(ctx) {
    for (let i = 1; i < CONFIGS.length; i++) ctx.setTimer("next", CONFIGS[i].at, i + 1);
    return { current: 1 } as CtrlState;
  },
  onTimer(s: CtrlState, t, ctx) {
    s.current = Math.max(s.current, Number(t.data));
    ctx.log(`Configuration ${s.current}: ${CONFIGS[s.current - 1].shards.join(" ")}`);
  },
  onMessage(s: CtrlState, from, msg, ctx) {
    if (msg?.type !== "query") return;
    // num -1 (or anything past the latest) means "the latest"; otherwise that exact configuration.
    const n = msg.num === -1 || msg.num > s.current ? s.current : Math.max(1, msg.num);
    ctx.send(from, { type: "config", config: { num: n, shards: CONFIGS[n - 1].shards } });
  },
};

/* ---------------- the lab's clients ---------------- */

interface ClientState {
  seq: number;
  cmd: AppendCmd | null;
  config: { num: number; shards: string[] } | null;
}

export const shardOf = (key: string) => Number(key.slice(-1)) % NSHARDS;

const client: Handlers = {
  init: () => ({ seq: 0, cmd: null, config: null }) as ClientState,
  onCommand(s: ClientState, cmd, ctx) {
    s.seq++;
    s.cmd = cmd;
    trySend(s, ctx);
    ctx.setTimer("retry", 40, s.seq);
  },
  onMessage(s: ClientState, _from, msg, ctx) {
    if (msg?.type === "config") {
      if (!s.config || msg.config.num > s.config.num) s.config = msg.config;
      if (s.cmd) trySend(s, ctx);
      return;
    }
    if (msg?.type !== "reply" || msg.seq !== s.seq || !s.cmd) return;
    if (msg.err) {
      ctx.send("ctrl", { type: "query", num: -1 });
      return;
    }
    s.cmd = null;
    ctx.reply(msg.result);
  },
  onTimer(s: ClientState, t, ctx) {
    if (t.data !== s.seq || !s.cmd) return;
    ctx.send("ctrl", { type: "query", num: -1 });
    trySend(s, ctx);
    ctx.setTimer("retry", 40, s.seq);
  },
};

function trySend(s: ClientState, ctx: Parameters<NonNullable<Handlers["onCommand"]>>[2]) {
  if (!s.cmd) return;
  if (!s.config) {
    ctx.send("ctrl", { type: "query", num: -1 });
    return;
  }
  const owner = s.config.shards[shardOf(s.cmd.key)];
  ctx.send(owner, { type: "request", client: ctx.self, seq: s.seq, key: s.cmd.key, value: s.cmd.value });
}

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with the ${name}'s handlers.`);
  return h as Handlers;
}

/** Appends spread over all four shards, one key per client and shard. */
const appends = (c: string, values: string) => values.split("").map((value, i) => ({ op: "append", key: `${c}${i % NSHARDS}`, value }));

export const B6: ProtocolSpec = {
  id: "b6-shardkv",
  nodes: [
    { id: "ctrl", role: "controller", label: "Shard controller" },
    { id: "g1", role: "server", label: "Group 1" },
    { id: "g2", role: "server", label: "Group 2" },
    { id: "g3", role: "server", label: "Group 3" },
    { id: "a", role: "client", label: "Client a" },
    { id: "b", role: "client", label: "Client b" },
  ],
  labRoles: ["controller", "client"],
  roles: (user) => ({ controller, client, server: need(user, "server") }),
  workload: { a: appends("a", "abcdefghijklmnopqrstuvwx"), b: appends("b", "ABCDEFGHIJKLMNOPQRSTUVWX") },
  invariants: [
    {
      name: "Every append happens exactly once",
      check: appliedOncePerKey,
      why: "When a shard moves, its data and its duplicate table have to move with it, and the new owner must not answer for the shard until they've arrived. A late or repeated copy must never overwrite newer data.",
    },
  ],
  network: { delayMin: 1, delayMax: 6, drop: 0.1, duplicate: 0.1 },
  budget: { maxDepth: 16, maxStates: 100000, crashes: 0, timers: true },
};

export const B6_STARTER = `// A sharded key-value store.
//
// Keys live in 4 shards (a key's shard is its last digit: "a2" is in shard 2).
// The shard controller "ctrl" publishes numbered configurations, like
//   { num: 3, shards: ["g1", "g3", "g2", "g1"] }   (shard i is owned by shards[i])
// and moves to a new one every so often. Ask it with { type: "query", num }:
// it answers { type: "config", config } with that configuration, or the latest
// one if num is -1 or hasn't happened yet.
//
// Clients send { type: "request", client, seq, key, value } to the group they
// think owns the key's shard. Answer { type: "reply", seq, result } with the
// key's whole value after appending, or { type: "reply", seq, err: "wrong group" }
// if you don't serve that shard right now (the client will ask ctrl and retry).
//
// This version handles configurations one at a time, but when it gains a shard
// it starts it empty, and it throws away shards it loses.

const NSHARDS = 4;
const POLL = 15;
const shardOf = (key) => Number(key.slice(-1)) % NSHARDS;

export const server = {
  init(ctx) {
    ctx.setTimer("poll", POLL);
    return {
      config: { num: 0, shards: [null, null, null, null] },
      shards: {}, // shard -> { data: { key: value }, last: { client: { seq, result } } }
    };
  },

  onTimer(s, t, ctx) {
    if (t.name === "poll") {
      // Configurations must be processed in order, one at a time.
      ctx.send("ctrl", { type: "query", num: s.config.num + 1 });
      ctx.setTimer("poll", POLL);
    }
  },

  onMessage(s, from, msg, ctx) {
    if (msg.type === "config" && msg.config.num === s.config.num + 1) {
      const next = msg.config;
      for (let shard = 0; shard < NSHARDS; shard++) {
        const before = s.config.shards[shard];
        const after = next.shards[shard];
        if (before === ctx.self && after !== ctx.self) {
          // TODO: this shard's data now belongs to another group. Hand it over
          // (and keep sending until they confirm), instead of throwing it away.
          delete s.shards[shard];
        }
        if (after === ctx.self && before !== ctx.self) {
          // TODO: unless nobody owned it before (configuration 1), this shard's
          // data is with another group. Wait for it, and don't serve the shard
          // until it arrives.
          s.shards[shard] = { data: {}, last: {} };
        }
      }
      s.config = next;
    }

    if (msg.type === "request") {
      const shard = shardOf(msg.key);
      const sh = s.shards[shard];
      if (s.config.shards[shard] !== ctx.self || !sh) {
        ctx.send(from, { type: "reply", seq: msg.seq, err: "wrong group" });
        return;
      }
      const prev = sh.last[msg.client];
      if (prev && prev.seq === msg.seq) {
        ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
        return;
      }
      if (prev && prev.seq > msg.seq) return;
      sh.data[msg.key] = (sh.data[msg.key] ?? "") + msg.value;
      sh.last[msg.client] = { seq: msg.seq, result: sh.data[msg.key] };
      ctx.send(from, { type: "reply", seq: msg.seq, result: sh.data[msg.key] });
    }
  },
};
`;
