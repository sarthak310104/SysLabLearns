import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B7: two-phase commit.
 *
 * Money moves between two banks (participants). A transfer debits an account
 * at one bank and credits an account at the other: both must happen, or
 * neither. The coordinator runs two-phase commit for each transfer. The
 * learner writes the coordinator and the participants; the lab's clients
 * submit transfers and retry.
 *
 * The invariants read participants' `balances` and `outcomes`
 * ({ txid: "commit" | "abort" }) and the coordinator's `decisions`.
 */

const BANKS = ["bankA", "bankB"];
export const START_BALANCES: Record<string, Record<string, number>> = {
  bankA: { alice: 100, carol: 50 },
  bankB: { bob: 100, dave: 50 },
};

interface PartView {
  balances?: Record<string, number>;
  outcomes?: Record<string, string>;
}

export function atomic(w: World): string | null {
  const seen = new Map<string, { where: string; outcome: string }>();
  const record = (tx: string, where: string, outcome: string): string | null => {
    const prev = seen.get(tx);
    if (prev && prev.outcome !== outcome) {
      return `Transfer ${tx} was ${prev.outcome === "commit" ? "committed" : "aborted"} at ${prev.where} but ${outcome === "commit" ? "committed" : "aborted"} at ${where}. Either both banks apply it or neither does.`;
    }
    if (!prev) seen.set(tx, { where, outcome });
    return null;
  };
  for (const b of BANKS) {
    const s = w.nodes[b].state as PartView;
    for (const [tx, o] of Object.entries(s.outcomes ?? {})) {
      const m = record(tx, b, o);
      if (m) return m;
    }
  }
  const c = w.nodes.coord.state as { decisions?: Record<string, string> };
  if (!w.nodes.coord.crashed) {
    for (const [tx, o] of Object.entries(c.decisions ?? {})) {
      const m = record(tx, "the coordinator", o);
      if (m) return m;
    }
  }
  for (const e of w.history) {
    if (e.kind !== "ok") continue;
    const tx = (e.cmd as { id: string }).id;
    const m = record(tx, `${e.client} (who was told "${e.value}")`, e.value === "committed" ? "commit" : "abort");
    if (m) return m;
  }
  return null;
}

export function noOverdraft(w: World): string | null {
  for (const b of BANKS) {
    const s = w.nodes[b].state as PartView;
    for (const [acct, bal] of Object.entries(s.balances ?? {})) {
      if (bal < 0) return `${acct} at ${b} has a balance of ${bal}. A bank must vote no when the money isn't there, counting what's already promised to other transfers.`;
    }
  }
  return null;
}

/* ---------------- the lab's clients ---------------- */

interface Transfer {
  op: "transfer";
  id: string;
  from: { bank: string; account: string };
  to: { bank: string; account: string };
  amount: number;
}

interface ClientState {
  seq: number;
  tx: Transfer | null;
}

const client: Handlers = {
  init: () => ({ seq: 0, tx: null }) as ClientState,
  onCommand(s: ClientState, cmd, ctx) {
    s.seq++;
    s.tx = cmd;
    ctx.send("coord", { type: "transfer", client: ctx.self, tx: cmd });
    ctx.setTimer("retry", 50, s.seq);
  },
  onMessage(s: ClientState, _from, msg, ctx) {
    if (msg?.type === "result" && s.tx && msg.id === s.tx.id) {
      s.tx = null;
      ctx.reply(msg.outcome);
    }
  },
  onTimer(s: ClientState, t, ctx) {
    if (t.data !== s.seq || !s.tx) return;
    ctx.send("coord", { type: "transfer", client: ctx.self, tx: s.tx });
    ctx.setTimer("retry", 50, s.seq);
  },
};

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with the ${name}'s handlers.`);
  return h as Handlers;
}

const t = (id: string, from: string, to: string, amount: number): Transfer => {
  const [fb, fa] = from.split(":");
  const [tb, ta] = to.split(":");
  return { op: "transfer", id, from: { bank: fb, account: fa }, to: { bank: tb, account: ta }, amount };
};

export const B7: ProtocolSpec = {
  id: "b7-2pc",
  nodes: [
    { id: "coord", role: "coordinator", label: "Coordinator" },
    { id: "bankA", role: "participant", label: "Bank A" },
    { id: "bankB", role: "participant", label: "Bank B" },
    { id: "c1", role: "client", label: "Client 1" },
    { id: "c2", role: "client", label: "Client 2" },
  ],
  labRoles: ["client"],
  roles: (user) => ({ client, coordinator: need(user, "coordinator"), participant: need(user, "participant") }),
  workload: {
    // The third transfer from each client bounces: the money isn't there.
    c1: [t("t1", "bankA:alice", "bankB:bob", 30), t("t2", "bankA:alice", "bankB:bob", 50), t("t3", "bankA:alice", "bankB:bob", 40), t("t4", "bankB:bob", "bankA:alice", 10)],
    c2: [t("u1", "bankB:dave", "bankA:carol", 20), t("u2", "bankB:dave", "bankA:carol", 20), t("u3", "bankB:dave", "bankA:carol", 20), t("u4", "bankA:carol", "bankB:dave", 5)],
  },
  checkerWorkload: { c1: [t("t1", "bankA:alice", "bankB:bob", 120)] },
  invariants: [
    { name: "Both banks agree on every transfer", check: atomic, why: "One bank applied a transfer the other didn't. The coordinator may only decide commit once every bank has voted yes, a bank that voted yes must wait for the decision however long it takes, and the decision must survive the coordinator crashing." },
    { name: "No account goes below zero", check: noOverdraft, why: "A bank voted yes without the money. When voting, subtract what's already held for other prepared transfers." },
  ],
  network: { delayMin: 1, delayMax: 6, drop: 0.1, duplicate: 0.1 },
  crashable: ["coord"],
  restart: true,
  budget: { maxDepth: 14, maxStates: 120000, crashes: 1, timers: false },
};

export const B7_STARTER = `// Two-phase commit: move money between two banks, all or nothing.
//
// A client sends the coordinator { type: "transfer", client, tx } where
//   tx = { id, from: { bank, account }, to: { bank, account }, amount }
// and retries with the same tx until it gets { type: "result", id, outcome }
// with outcome "committed" or "aborted".
//
// Phase 1: the coordinator asks both banks { type: "prepare", tx }. Each votes
// { type: "vote", id, yes }: yes only if it can do its part (the debit needs
// the money, counting what's held for other prepared transfers).
// Phase 2: the coordinator decides, tells both banks { type: "decision", id,
// outcome: "commit" | "abort" }, and tells the client.
//
// The lab checks banks' balances and outcomes ({ id: "commit" | "abort" }) and
// the coordinator's decisions. ctx.store / ctx.stored give the coordinator a
// disk that survives a crash.
//
// Three bugs, marked TODO.

const BANKS = ["bankA", "bankB"];
const START = { bankA: { alice: 100, carol: 50 }, bankB: { bob: 100, dave: 50 } };

export const coordinator = {
  init(ctx) {
    // TODO (crashes): after a restart, recover decisions saved on disk.
    const s = { txs: {}, decisions: {} };
    ctx.setTimer("resend", 20);
    return s;
  },

  onTimer(s, t, ctx) {
    // Keep nudging: lost prepares and decisions get sent again.
    for (const [id, tx] of Object.entries(s.txs)) {
      if (s.decisions[id]) for (const b of BANKS) ctx.send(b, { type: "decision", id, outcome: s.decisions[id] });
      else for (const b of BANKS) if (!(b in tx.votes)) ctx.send(b, { type: "prepare", tx: tx.tx });
    }
    ctx.setTimer("resend", 20);
  },

  onMessage(s, from, msg, ctx) {
    if (msg.type === "transfer") {
      const id = msg.tx.id;
      if (s.decisions[id]) {
        ctx.send(msg.client, { type: "result", id, outcome: s.decisions[id] === "commit" ? "committed" : "aborted" });
        return;
      }
      if (!s.txs[id]) s.txs[id] = { tx: msg.tx, client: msg.client, votes: {} };
      for (const b of BANKS) ctx.send(b, { type: "prepare", tx: msg.tx });
    }

    if (msg.type === "vote" && s.txs[msg.id] && !s.decisions[msg.id]) {
      const tx = s.txs[msg.id];
      tx.votes[from] = msg.yes;
      // TODO (agreement): this decides as soon as any vote comes in.
      // Commit only when every bank has voted yes; abort as soon as one says no.
      decide(s, msg.id, msg.yes ? "commit" : "abort", ctx);
    }

    if (msg.type === "status") {
      // A bank that voted yes is asking what happened.
      if (s.decisions[msg.id]) ctx.send(from, { type: "decision", id: msg.id, outcome: s.decisions[msg.id] });
      else if (!s.txs[msg.id]) ctx.send(from, { type: "decision", id: msg.id, outcome: "abort" }); // never heard of it: it can't have committed
    }
  },
};

function decide(s, id, outcome, ctx) {
  s.decisions[id] = outcome;
  // TODO (crashes): the decision must be on disk before anyone hears it.
  for (const b of BANKS) ctx.send(b, { type: "decision", id, outcome });
  const tx = s.txs[id];
  ctx.send(tx.client, { type: "result", id, outcome: outcome === "commit" ? "committed" : "aborted" });
}

export const participant = {
  init(ctx) {
    ctx.setTimer("check", 30);
    return {
      balances: { ...START[ctx.self] },
      held: {},      // account -> money promised to prepared transfers
      prepared: {},  // id -> { account, change, waited }
      outcomes: {},  // id -> "commit" | "abort"
    };
  },

  onTimer(s, t, ctx) {
    for (const [id, p] of Object.entries(s.prepared)) {
      p.waited++;
      ctx.send("coord", { type: "status", id });
      // TODO (lossy network): a bank that voted yes gives up after a while.
      // Once you've voted yes, you may not decide on your own: only the
      // coordinator knows whether the other bank voted yes too.
      if (p.waited > 1) finish(s, id, "abort");
    }
    ctx.setTimer("check", 30);
  },

  onMessage(s, from, msg, ctx) {
    if (msg.type === "prepare") {
      const tx = msg.tx;
      const id = tx.id;
      if (s.outcomes[id]) {
        // Already decided: answer the same way (a no if it was aborted).
        ctx.send(from, { type: "vote", id, yes: s.outcomes[id] === "commit" });
        return;
      }
      if (s.prepared[id]) {
        ctx.send(from, { type: "vote", id, yes: true });
        return;
      }
      const mine = tx.from.bank === ctx.self ? { account: tx.from.account, change: -tx.amount } : { account: tx.to.account, change: tx.amount };
      const available = (s.balances[mine.account] ?? 0) - (s.held[mine.account] ?? 0);
      if (mine.change < 0 && available < -mine.change) {
        s.outcomes[id] = "abort";
        ctx.send(from, { type: "vote", id, yes: false });
        return;
      }
      if (mine.change < 0) s.held[mine.account] = (s.held[mine.account] ?? 0) - mine.change;
      s.prepared[id] = { ...mine, waited: 0 };
      ctx.send(from, { type: "vote", id, yes: true });
    }

    if (msg.type === "decision") finish(s, msg.id, msg.outcome);
  },
};

function finish(s, id, outcome) {
  const p = s.prepared[id];
  if (!p) {
    if (!s.outcomes[id]) s.outcomes[id] = outcome;
    return;
  }
  if (p.change < 0) s.held[p.account] -= -p.change;
  if (outcome === "commit") s.balances[p.account] += p.change;
  s.outcomes[id] = outcome;
  delete s.prepared[id];
}
`;
