/**
 * Reference solutions, kept only in the tests so the app never shows them.
 * Each lab also has deliberately broken variants: the checker must catch them.
 */

export const B2_SOLUTION = `
export const client = {
  init: () => ({ seq: 0, cmd: null }),
  onCommand(s, cmd, ctx) {
    s.seq++;
    s.cmd = cmd;
    ctx.send(ctx.nodes("server")[0], { type: "request", seq: s.seq, cmd });
    ctx.setTimer("retry", 30, s.seq);
  },
  onMessage(s, from, msg, ctx) {
    if (msg.type === "reply" && msg.seq === s.seq && s.cmd) {
      s.cmd = null;
      ctx.reply(msg.result);
    }
  },
  onTimer(s, t, ctx) {
    if (t.data === s.seq && s.cmd) {
      ctx.send(ctx.nodes("server")[0], { type: "request", seq: s.seq, cmd: s.cmd });
      ctx.setTimer("retry", 30, s.seq);
    }
  },
};

export const server = {
  init: () => ({ data: {}, last: {} }),
  onMessage(s, from, msg, ctx) {
    if (msg.type !== "request") return;
    const prev = s.last[from];
    if (prev && prev.seq === msg.seq) {
      ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
      return;
    }
    if (prev && prev.seq > msg.seq) return;
    const { key, value } = msg.cmd;
    s.data[key] = (s.data[key] ?? "") + value;
    s.last[from] = { seq: msg.seq, result: s.data[key] };
    ctx.send(from, { type: "reply", seq: msg.seq, result: s.data[key] });
  },
};
`;

/** Retries, but the server applies every request it sees: duplicates get applied twice. */
export const B2_NO_DEDUP = B2_SOLUTION.replace(
  `    if (prev && prev.seq === msg.seq) {
      ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
      return;
    }
    if (prev && prev.seq > msg.seq) return;`,
  "",
);

/** Remembers requests, but keyed only by sequence number: two clients collide. */
export const B2_SHARED_DEDUP = B2_SOLUTION.replace(/s\.last\[from\]/g, "s.last.any").replace("const prev = s.last[from];", "const prev = s.last.any;");

export const B1_SOLUTION = `
export const lamport = {
  init: () => ({ time: 0 }),
  localEvent(s) { s.time += 1; return s.time; },
  send(s) { s.time += 1; return s.time; },
  receive(s, stamp) { s.time = Math.max(s.time, stamp) + 1; return s.time; },
};
export const vector = {
  init(self, everyone) {
    const v = {};
    for (const p of everyone) v[p] = 0;
    return { self, v };
  },
  localEvent(s) { s.v[s.self] += 1; return { ...s.v }; },
  send(s) { s.v[s.self] += 1; return { ...s.v }; },
  receive(s, stamp) {
    for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);
    s.v[s.self] += 1;
    return { ...s.v };
  },
};
`;

/** Lamport right, but vector receive forgets to tick its own entry. */
export const B1_VECTOR_NO_TICK = B1_SOLUTION.replace(
  "for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);\n    s.v[s.self] += 1;",
  "for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);",
);

export const B4_SOLUTION = `
const majority = 2;
export const proposer = {
  init: () => ({ value: null, round: 0, ballot: 0, promises: {}, accepted: [], decided: false }),
  onCommand(s, cmd, ctx) { s.value = cmd.value; start(s, ctx); },
  onMessage(s, from, msg, ctx) {
    if (s.decided || msg.ballot !== s.ballot) return;
    if (msg.type === "promise" && !(from in s.promises)) {
      s.promises[from] = { ballot: msg.acceptedBallot, value: msg.acceptedValue };
      if (Object.keys(s.promises).length === majority) {
        let best = null;
        for (const p of Object.values(s.promises)) if (p.ballot > 0 && (!best || p.ballot > best.ballot)) best = p;
        const v = best ? best.value : s.value;
        s.proposing = v;
        for (const a of ctx.nodes("acceptor")) ctx.send(a, { type: "accept", ballot: s.ballot, value: v });
      }
    }
    if (msg.type === "accepted" && !s.accepted.includes(from)) {
      s.accepted.push(from);
      if (s.accepted.length === majority) { s.decided = true; ctx.reply(msg.value); }
    }
  },
  onTimer(s, t, ctx) { if (!s.decided && t.data === s.ballot) start(s, ctx); },
};
function start(s, ctx) {
  s.round += 1;
  s.ballot = s.round * 10 + Number(ctx.self.slice(1));
  s.promises = {};
  s.accepted = [];
  for (const a of ctx.nodes("acceptor")) ctx.send(a, { type: "prepare", ballot: s.ballot });
  ctx.setTimer("retry", 40 + ctx.random() * 40, s.ballot);
}
export const acceptor = {
  init: () => ({ promised: 0, acceptedBallot: 0, acceptedValue: null }),
  onMessage(s, from, msg, ctx) {
    if (msg.type === "prepare" && msg.ballot >= s.promised) {
      s.promised = msg.ballot;
      ctx.send(from, { type: "promise", ballot: msg.ballot, acceptedBallot: s.acceptedBallot, acceptedValue: s.acceptedValue });
    }
    if (msg.type === "accept" && msg.ballot >= s.promised) {
      s.promised = msg.ballot;
      s.acceptedBallot = msg.ballot;
      s.acceptedValue = msg.value;
      ctx.send(from, { type: "accepted", ballot: msg.ballot, value: msg.value });
    }
  },
};
`;

/** Counts acceptances correctly, but always proposes its own value. */
export const B4_IGNORES_ACCEPTED = B4_SOLUTION.replace("const v = best ? best.value : s.value;", "const v = s.value;");

/** Picks the right value, but counts a repeated "accepted" message twice. */
export const B4_COUNTS_DUPLICATES = B4_SOLUTION.replace(`if (msg.type === "accepted" && !s.accepted.includes(from)) {`, `if (msg.type === "accepted") {`);

export const B3_SOLUTION = `
export const server = {
  init(ctx) {
    ctx.setTimer("ping", 10);
    return {
      view: { num: 0, primary: null, backup: null },
      readyView: 0,
      data: {},
      last: {},
      synced: false,
      syncedView: 0,
      syncedFrom: null,
      syncing: false,
      pending: null,
    };
  },

  onTimer(s, t, ctx) {
    ctx.send("vs", { type: "ping", viewNum: s.readyView });
    if (s.syncing) sendSync(s, ctx);
    else if (s.pending) forward(s, ctx);
    ctx.setTimer("ping", 10);
  },

  onMessage(s, from, msg, ctx) {
    if (msg.type === "view" && msg.view.num > s.view.num) {
      const firstView = s.view.num === 0 && msg.view.num === 1;
      s.view = msg.view;
      if (s.view.primary === ctx.self) {
        if (firstView) s.synced = true;
        if (!s.synced) return;
        if (s.view.backup) { s.syncing = true; sendSync(s, ctx); }
        else { s.syncing = false; s.readyView = s.view.num; finishPending(s, ctx); }
      } else {
        s.syncing = false;
        s.pending = null;
        s.readyView = s.view.num;
      }
      return;
    }

    if (msg.type === "sync") {
      if (msg.view > s.syncedView) {
        s.data = msg.data;
        s.last = msg.last;
        s.synced = true;
        s.syncedView = msg.view;
        s.syncedFrom = from;
      }
      if (msg.view === s.syncedView) ctx.send(from, { type: "syncOk", view: msg.view });
      return;
    }

    if (msg.type === "syncOk") {
      if (s.syncing && msg.view === s.view.num && from === s.view.backup) {
        s.syncing = false;
        s.readyView = s.view.num;
        if (s.pending) forward(s, ctx);
      }
      return;
    }

    if (msg.type === "forward") {
      if (msg.view !== s.syncedView || from !== s.syncedFrom) return;
      const result = apply(s, msg.client, msg.seq, msg.cmd);
      ctx.send(from, { type: "forwardOk", view: msg.view, client: msg.client, seq: msg.seq, result });
      return;
    }

    if (msg.type === "forwardOk") {
      const p = s.pending;
      if (!p || msg.view !== s.view.num || p.client !== msg.client || p.seq !== msg.seq) return;
      finishPending(s, ctx);
      return;
    }

    if (msg.type === "request") {
      if (s.view.primary !== ctx.self || !s.synced) {
        ctx.send(from, { type: "reply", seq: msg.seq, error: "not primary" });
        return;
      }
      const prev = s.last[msg.client];
      if (prev && prev.seq === msg.seq) { ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result }); return; }
      if (prev && prev.seq > msg.seq) return;
      if (s.syncing || s.readyView !== s.view.num || s.pending) return; // busy: the client will retry
      s.pending = { client: msg.client, seq: msg.seq, cmd: msg.cmd };
      if (s.view.backup) forward(s, ctx);
      else finishPending(s, ctx);
    }
  },
};

function apply(s, client, seq, cmd) {
  const prev = s.last[client];
  if (prev && prev.seq >= seq) return prev.result;
  s.data[cmd.key] = (s.data[cmd.key] ?? "") + cmd.value;
  s.last[client] = { seq, result: s.data[cmd.key] };
  return s.data[cmd.key];
}

function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: s.data, last: s.last });
}

function forward(s, ctx) {
  const p = s.pending;
  ctx.send(s.view.backup, { type: "forward", view: s.view.num, client: p.client, seq: p.seq, cmd: p.cmd });
}

function finishPending(s, ctx) {
  const p = s.pending;
  if (!p) return;
  s.pending = null;
  const result = apply(s, p.client, p.seq, p.cmd);
  ctx.send(p.client, { type: "reply", seq: p.seq, result });
}
`;

/** Forwards and dedups, but a new backup starts empty: no state transfer. */
export const B3_NO_SYNC = B3_SOLUTION.replace(
  `if (s.view.backup) { s.syncing = true; sendSync(s, ctx); }`,
  `if (s.view.backup) { ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: {}, last: {} }); s.syncing = true; }`,
).replace(`function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: s.data, last: s.last });`, `function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: {}, last: {} });`);

export const B0_SOLUTION = `
export const server = {
  init: () => ({ counts: {} }),
  onMessage(state, from, msg, ctx) {
    if (msg.type !== "request") return;
    state.counts[from] = (state.counts[from] ?? 0) + 1;
    ctx.send(from, { type: "reply", seq: msg.seq, result: state.counts[from] + ": " + msg.text.toUpperCase() });
  },
};
`;

/** Stage 1 only: capitals, no numbering. */
export const B0_STAGE1 = `
export const server = {
  init: () => ({}),
  onMessage(state, from, msg, ctx) {
    if (msg.type === "request") ctx.send(from, { type: "reply", seq: msg.seq, result: msg.text.toUpperCase() });
  },
};
`;

/** Counts every request together instead of per client. */
export const B0_SHARED_COUNT = B0_SOLUTION.replace(/state\.counts\[from\]/g, "state.counts.all");

/* ------------------------------------------------------------------ */
/* B5 Raft                                                             */
/* ------------------------------------------------------------------ */

import { B5_STARTER } from "@/content/protocols/b5";

const B5_VOTE_BUGGY = `      const grant = msg.term === s.currentTerm;`;
const B5_VOTE_FIXED = `      const myLastTerm = s.log.length ? s.log[s.log.length - 1].term : 0;
      const upToDate = msg.lastLogTerm > myLastTerm || (msg.lastLogTerm === myLastTerm && msg.lastLogIndex >= s.log.length);
      const grant = msg.term === s.currentTerm && (s.votedFor === null || s.votedFor === from) && upToDate;`;
const B5_APPEND_BUGGY = `      s.log.push(...msg.entries);
      save(s, ctx);
      const match = msg.prevLogIndex + msg.entries.length;
      if (msg.leaderCommit > s.commitIndex) s.commitIndex = Math.min(msg.leaderCommit, s.log.length);`;
const B5_APPEND_FIXED = `      if (msg.prevLogIndex > s.log.length || (msg.prevLogIndex > 0 && s.log[msg.prevLogIndex - 1].term !== msg.prevLogTerm)) {
        ctx.send(from, { type: "appendReply", term: s.currentTerm, success: false, match: 0 });
        return;
      }
      let i = msg.prevLogIndex;
      for (const e of msg.entries) {
        if (s.log[i] && s.log[i].term !== e.term) s.log.length = i;
        if (!s.log[i]) s.log.push(e);
        i++;
      }
      save(s, ctx);
      const match = msg.prevLogIndex + msg.entries.length;
      if (msg.leaderCommit > s.commitIndex) s.commitIndex = Math.max(s.commitIndex, Math.min(msg.leaderCommit, match));`;
const B5_RECOVER_BUGGY = `    // TODO (crashes): after a restart, recover what you saved on disk.`;
const B5_RECOVER_FIXED = `    const disk = ctx.stored();
    if (disk) {
      s.currentTerm = disk.currentTerm;
      s.votedFor = disk.votedFor;
      s.log = disk.log;
    }`;
const B5_SAVE_BUGGY = `  // TODO (crashes): write what must survive a crash to disk.
  // Which fields does Raft need after a restart to stay safe?`;
const B5_SAVE_FIXED = `  ctx.store({ currentTerm: s.currentTerm, votedFor: s.votedFor, log: s.log });`;

function swap(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error("B5 starter changed: can't find " + from.slice(0, 40));
  return src.replace(from, to);
}

export const B5_SOLUTION = [
  [B5_VOTE_BUGGY, B5_VOTE_FIXED],
  [B5_APPEND_BUGGY, B5_APPEND_FIXED],
  [B5_RECOVER_BUGGY, B5_RECOVER_FIXED],
  [B5_SAVE_BUGGY, B5_SAVE_FIXED],
].reduce((src, [a, b]) => swap(src, a, b), B5_STARTER);

/** Everything right except the election restriction: a candidate with a shorter log can win. */
export const B5_NO_UPTODATE = B5_SOLUTION.replace(" && upToDate;", ";");
/** Saves the log but not the vote: after a restart a server can vote twice in one term. */
export const B5_FORGETS_VOTE = B5_SOLUTION.replace("s.votedFor = disk.votedFor;", "");

/* ------------------------------------------------------------------ */
/* B6 sharded key-value store                                          */
/* ------------------------------------------------------------------ */

export const B6_SOLUTION = `
const NSHARDS = 4;
const POLL = 15;
const shardOf = (key) => Number(key.slice(-1)) % NSHARDS;

export const server = {
  init(ctx) {
    ctx.setTimer("poll", POLL);
    return { config: { num: 0, shards: [null, null, null, null] }, shards: {}, pending: {}, outgoing: {} };
  },
  onTimer(s, t, ctx) {
    if (t.name !== "poll") return;
    // Finish the current configuration's handoffs before asking for the next one.
    for (const [shard, o] of Object.entries(s.outgoing)) ctx.send(o.to, { type: "shard", shard: Number(shard), num: o.num, contents: o.contents });
    if (!Object.keys(s.pending).length && !Object.keys(s.outgoing).length) ctx.send("ctrl", { type: "query", num: s.config.num + 1 });
    ctx.setTimer("poll", POLL);
  },
  onMessage(s, from, msg, ctx) {
    if (msg.type === "config" && msg.config.num === s.config.num + 1 && !Object.keys(s.pending).length && !Object.keys(s.outgoing).length) {
      const next = msg.config;
      for (let shard = 0; shard < NSHARDS; shard++) {
        const before = s.config.shards[shard];
        const after = next.shards[shard];
        if (before === ctx.self && after !== ctx.self) {
          s.outgoing[shard] = { to: after, num: next.num, contents: s.shards[shard] };
          delete s.shards[shard];
          ctx.send(after, { type: "shard", shard, num: next.num, contents: s.outgoing[shard].contents });
        }
        if (after === ctx.self && before !== ctx.self) {
          if (before === null) s.shards[shard] = { data: {}, last: {} };
          else s.pending[shard] = true;
        }
      }
      s.config = next;
    }
    if (msg.type === "shard") {
      // Only install a shard we're waiting for in this exact configuration; a late copy is just acknowledged.
      if (msg.num === s.config.num && s.pending[msg.shard]) {
        s.shards[msg.shard] = msg.contents;
        delete s.pending[msg.shard];
      }
      if (msg.num <= s.config.num) ctx.send(from, { type: "shardOk", shard: msg.shard, num: msg.num });
    }
    if (msg.type === "shardOk") {
      const o = s.outgoing[msg.shard];
      if (o && o.num === msg.num) delete s.outgoing[msg.shard];
    }
    if (msg.type === "request") {
      const shard = shardOf(msg.key);
      const sh = s.shards[shard];
      if (s.config.shards[shard] !== ctx.self || !sh || s.pending[shard]) {
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

/** Hands shards over, but installs any copy that arrives: a late duplicate overwrites newer appends. */
export const B6_INSTALLS_LATE_COPIES = B6_SOLUTION.replace("if (msg.num === s.config.num && s.pending[msg.shard]) {", "if (msg.num <= s.config.num) {");
/** Hands shards over, but sends each one only once: a lost handoff leaves the shard stuck. */
export const B6_NO_RESEND = B6_SOLUTION.replace("    for (const [shard, o] of Object.entries(s.outgoing)) ctx.send(o.to, { type: \"shard\", shard: Number(shard), num: o.num, contents: o.contents });\n", "");

/* ------------------------------------------------------------------ */
/* B7 two-phase commit                                                 */
/* ------------------------------------------------------------------ */

import { B7_STARTER } from "@/content/protocols/b7";

export const B7_SOLUTION = [
  [
    `    // TODO (crashes): after a restart, recover decisions saved on disk.
    const s = { txs: {}, decisions: {} };`,
    `    const s = { txs: {}, decisions: ctx.stored()?.decisions ?? {} };`,
  ],
  [
    `      // TODO (agreement): this decides as soon as any vote comes in.
      // Commit only when every bank has voted yes; abort as soon as one says no.
      decide(s, msg.id, msg.yes ? "commit" : "abort", ctx);`,
    `      if (!msg.yes) decide(s, msg.id, "abort", ctx);
      else if (BANKS.every((b) => tx.votes[b] === true)) decide(s, msg.id, "commit", ctx);`,
  ],
  [
    `  // TODO (crashes): the decision must be on disk before anyone hears it.`,
    `  ctx.store({ decisions: s.decisions });`,
  ],
  [
    `      else if (!s.txs[msg.id]) ctx.send(from, { type: "decision", id: msg.id, outcome: "abort" }); // never heard of it: it can't have committed`,
    `      else if (!s.txs[msg.id]) {
        // Never heard of it (or forgot it in a crash before deciding): it can't have committed. Record that.
        s.decisions[msg.id] = "abort";
        ctx.store({ decisions: s.decisions });
        ctx.send(from, { type: "decision", id: msg.id, outcome: "abort" });
      }`,
  ],
  [
    `      // TODO (lossy network): a bank that voted yes gives up after a while.
      // Once you've voted yes, you may not decide on your own: only the
      // coordinator knows whether the other bank voted yes too.
      if (p.waited > 1) finish(s, id, "abort");`,
    ``,
  ],
].reduce((src, [a, b]) => {
  if (!src.includes(a)) throw new Error("B7 starter changed: " + a.slice(0, 50));
  return src.replace(a, b);
}, B7_STARTER);

/** Everything right, except decisions aren't written to disk. */
export const B7_FORGETS_DECISIONS = B7_SOLUTION.replace(`  ctx.store({ decisions: s.decisions });\n  for (const b of BANKS)`, `  for (const b of BANKS)`);
/** Everything right, except a bank that voted yes gives up waiting. */
export const B7_GIVES_UP = B7_SOLUTION.replace(`      ctx.send("coord", { type: "status", id });\n`, `      ctx.send("coord", { type: "status", id });\n      if (p.waited > 1) finish(s, id, "abort");\n`);

/* ------------------------------------------------------------------ */
/* B8 CRDTs                                                            */
/* ------------------------------------------------------------------ */

export const B8_SOLUTION = `
export const counter = {
  init: () => ({ p: {}, n: {} }),
  increment(s, r) { s.p[r] = (s.p[r] ?? 0) + 1; },
  decrement(s, r) { s.n[r] = (s.n[r] ?? 0) + 1; },
  value: (s) => Object.values(s.p).reduce((a, b) => a + b, 0) - Object.values(s.n).reduce((a, b) => a + b, 0),
  merge(a, b) {
    const max = (x, y) => {
      const o = { ...x };
      for (const k in y) o[k] = Math.max(o[k] ?? 0, y[k]);
      return o;
    };
    return { p: max(a.p, b.p), n: max(a.n, b.n) };
  },
};

export const set = {
  init: () => ({ adds: {}, removed: {} }),
  add(s, item, tag) { s.adds[tag] = item; },
  remove(s, item) {
    for (const tag in s.adds) if (s.adds[tag] === item) s.removed[tag] = true;
  },
  value: (s) => [...new Set(Object.keys(s.adds).filter((t) => !s.removed[t]).map((t) => s.adds[t]))].sort(),
  merge: (a, b) => ({ adds: { ...a.adds, ...b.adds }, removed: { ...a.removed, ...b.removed } }),
};
`;

/** One total per replica would work, but this keeps a single number and merges with max: concurrent updates are lost. */
export const B8_MAX_TOTAL = B8_SOLUTION.replace("export const counter = {", "export const _unused = {").replace(
  "export const set = {",
  `export const counter = {
  init: () => ({ n: 0 }),
  increment(s) { s.n++; },
  decrement(s) { s.n--; },
  value: (s) => s.n,
  merge: (a, b) => ({ n: Math.max(a.n, b.n) }),
};

export const set = {`,
);
/** Remembers removed items rather than removed adds: a re-add after a remove never shows up. */
export const B8_REMOVE_WINS = B8_SOLUTION.replace(
  "export const set = {",
  `export const _unused = {`,
) + `
export const set = {
  init: () => ({ items: {}, gone: {} }),
  add(s, item) { s.items[item] = true; },
  remove(s, item) { s.gone[item] = true; },
  value: (s) => Object.keys(s.items).filter((i) => !s.gone[i]).sort(),
  merge: (a, b) => ({ items: { ...a.items, ...b.items }, gone: { ...a.gone, ...b.gone } }),
};
`;
