import type { Handlers, NodeId, ProtocolSpec } from "@/engine/protocol/types";
import { appliedOnce } from "./b2";

/*
 * B3: primary-backup replication with a view server.
 *
 * The view server (written by the lab) decides which server is primary and
 * which is backup. Servers ping it; it moves to a new view when one stops
 * pinging, but only after the current primary has acknowledged the current
 * view. The learner writes the servers. Clients (also the lab's) find the
 * primary through the view server and retry until they get an answer.
 */

export const PING_MS = 10;
const DEAD_AFTER_TICKS = 5;

interface View {
  num: number;
  primary: NodeId | null;
  backup: NodeId | null;
}

interface VsState {
  view: View;
  acked: boolean;
  lastPing: Record<NodeId, number>;
  tick: number;
}

const SERVERS = ["s1", "s2", "s3"];

const viewServer: Handlers = {
  init(ctx) {
    ctx.setTimer("tick", PING_MS);
    const s: VsState = { view: { num: 0, primary: null, backup: null }, acked: false, lastPing: {}, tick: 0 };
    return s;
  },
  onTimer(s: VsState, _t, ctx) {
    s.tick++;
    const dead = (id: NodeId) => s.tick - (s.lastPing[id] ?? -1000) >= DEAD_AFTER_TICKS;
    const idle = () => SERVERS.find((id) => id !== s.view.primary && id !== s.view.backup && !dead(id)) ?? null;
    const next = (primary: NodeId | null, backup: NodeId | null) => {
      s.view = { num: s.view.num + 1, primary, backup };
      s.acked = false;
      ctx.log(`View ${s.view.num}: primary ${primary ?? "none"}, backup ${backup ?? "none"}`);
    };
    // The view can only change once the primary has acknowledged the current one.
    if (s.acked && s.view.primary) {
      if (dead(s.view.primary)) {
        if (s.view.backup && !dead(s.view.backup)) next(s.view.backup, idle());
      } else if (s.view.backup && dead(s.view.backup)) next(s.view.primary, idle());
      else if (!s.view.backup && idle()) next(s.view.primary, idle());
    }
    ctx.setTimer("tick", PING_MS);
  },
  onMessage(s: VsState, from, msg, ctx) {
    if (msg?.type === "ping") {
      s.lastPing[from] = s.tick;
      if (s.view.num === 0) {
        s.view = { num: 1, primary: from, backup: null };
        s.acked = false;
      } else if (from === s.view.primary) {
        if (msg.viewNum === s.view.num) s.acked = true;
        // A primary pinging with 0 has restarted and lost everything: replace it.
        else if (msg.viewNum === 0 && s.acked && s.view.backup) {
          s.view = { num: s.view.num + 1, primary: s.view.backup, backup: null };
          s.acked = false;
        }
      } else if (from === s.view.backup && msg.viewNum === 0 && s.acked) {
        s.view = { num: s.view.num + 1, primary: s.view.primary, backup: from };
        s.acked = false;
      }
      ctx.send(from, { type: "view", view: s.view });
    }
    if (msg?.type === "getView") ctx.send(from, { type: "view", view: s.view });
  },
};

interface ClientState {
  view: View | null;
  seq: number;
  cmd: unknown;
}

const client: Handlers = {
  init: () => ({ view: null, seq: 0, cmd: null }) as ClientState,
  onCommand(s: ClientState, cmd, ctx) {
    s.seq++;
    s.cmd = cmd;
    trySend(s, ctx);
    ctx.setTimer("retry", 40, s.seq);
  },
  onMessage(s: ClientState, _from, msg, ctx) {
    if (msg?.type === "view") {
      if (!s.view || msg.view.num >= s.view.num) s.view = msg.view;
      if (s.cmd !== null && s.view?.primary) trySend(s, ctx);
    }
    if (msg?.type === "reply" && msg.seq === s.seq && s.cmd !== null) {
      if (msg.error) {
        ctx.send("vs", { type: "getView" });
        return;
      }
      s.cmd = null;
      ctx.reply(msg.result);
    }
  },
  onTimer(s: ClientState, t, ctx) {
    if (t.data !== s.seq || s.cmd === null) return;
    ctx.send("vs", { type: "getView" });
    trySend(s, ctx);
    ctx.setTimer("retry", 40, s.seq);
  },
};

function trySend(s: ClientState, ctx: Parameters<NonNullable<Handlers["onCommand"]>>[2]) {
  if (s.view?.primary) ctx.send(s.view.primary, { type: "request", client: ctx.self, seq: s.seq, cmd: s.cmd });
  else ctx.send("vs", { type: "getView" });
}

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with the ${name}'s handlers.`);
  return h as Handlers;
}

const appends = (client: string, values: string[]) => values.map((value) => ({ op: "append", key: client, value }));

export const B3: ProtocolSpec = {
  id: "b3-primary-backup",
  nodes: [
    { id: "vs", role: "viewserver", label: "View server" },
    { id: "s1", role: "server", label: "Server 1" },
    { id: "s2", role: "server", label: "Server 2" },
    { id: "s3", role: "server", label: "Server 3" },
    { id: "c1", role: "client", label: "Client 1" },
    { id: "c2", role: "client", label: "Client 2" },
  ],
  labRoles: ["viewserver", "client"],
  roles: (user) => ({ viewserver: viewServer, client, server: need(user, "server") }),
  workload: { c1: appends("c1", "abcdefghijklmnopqrst".split("")), c2: appends("c2", "ABCDEFGHIJKLMNOPQRST".split("")) },
  invariants: [{ name: "Every append happens exactly once", check: appliedOnce, why: "A request was applied twice, or an applied one was lost. After a crash, the new primary only knows what was copied to it, so every append (and the duplicate table) must reach the backup before the client hears back." }],
  network: { delayMin: 1, delayMax: 8, drop: 0.05, duplicate: 0.05 },
  crashable: ["s1", "s2", "s3"],
  restart: true,
  canCrash: (w) => {
    // Primary-backup can't survive losing its only copy, so the lab only
    // crashes a server while the view has a backup and the primary has
    // confirmed it, and nobody else is down.
    const vs = w.nodes.vs.state as VsState;
    return vs.acked && Boolean(vs.view.backup) && SERVERS.every((id) => !w.nodes[id].crashed);
  },
  budget: { maxDepth: 14, maxStates: 100000, crashes: 3, timers: true },
};

export const B3_STARTER = `// Primary-backup replication.
//
// The view server ("vs") decides who is primary and who is backup. Every
// server must ping it every ${PING_MS} ms with the number of the latest view it
// has fully set up; the view server answers with the current view:
//   { type: "view", view: { num, primary, backup } }
// The view server only moves on to a new view after the primary pings with
// the current view's number, so don't do that until the view is ready.
//
// Clients send { type: "request", client, seq, cmd } to whoever they think
// is primary, and retry. Answer with { type: "reply", seq, result }, or
// { type: "reply", seq, error: "not primary" }. cmd is { op: "append", key, value }
// and result is the key's whole value after appending.
//
// This version handles views, and it has duplicate detection from B2, but the
// backup never hears about anything. Watch what happens when the primary crashes.

export const server = {
  init(ctx) {
    ctx.setTimer("ping", ${PING_MS});
    return { view: { num: 0, primary: null, backup: null }, readyView: 0, data: {}, last: {} };
  },

  onTimer(state, timer, ctx) {
    if (timer.name === "ping") {
      ctx.send("vs", { type: "ping", viewNum: state.readyView });
      ctx.setTimer("ping", ${PING_MS});
    }
  },

  onMessage(state, from, msg, ctx) {
    if (msg.type === "view" && msg.view.num > state.view.num) {
      state.view = msg.view;
      // TODO: if this server is primary and there's a new backup, the backup
      // needs a copy of everything before this view counts as ready.
      state.readyView = msg.view.num;
    }

    if (msg.type === "request") {
      if (state.view.primary !== ctx.self) {
        ctx.send(from, { type: "reply", seq: msg.seq, error: "not primary" });
        return;
      }
      // Duplicate detection, as in B2: one entry per client.
      const prev = state.last[msg.client];
      if (prev && prev.seq === msg.seq) {
        ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
        return;
      }
      if (prev && prev.seq > msg.seq) return;

      // TODO: forward to the backup and wait for it to confirm before applying and answering.
      const { key, value } = msg.cmd;
      state.data[key] = (state.data[key] ?? "") + value;
      state.last[msg.client] = { seq: msg.seq, result: state.data[key] };
      ctx.send(from, { type: "reply", seq: msg.seq, result: state.data[key] });
    }
  },
};
`;
