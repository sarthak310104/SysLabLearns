import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";
import { appliedOnce } from "./b2";

/*
 * B5: Raft.
 *
 * Three servers (written by the learner) elect a leader and replicate a log
 * of client commands. The lab's clients guess a server, follow redirects to
 * the leader, and retry on a timer. Commands are appends, and the starter
 * already applies committed entries with duplicate detection, so a lost or
 * reordered committed entry shows up as a wrong reply.
 *
 * The invariants read four fields every server keeps: currentTerm, role,
 * log (an array of { term, cmd }) and commitIndex (how many entries are
 * committed).
 */

const SERVERS = ["s1", "s2", "s3"];

interface Entry {
  term: number;
  cmd: unknown;
}
interface RaftView {
  currentTerm?: number;
  role?: string;
  log?: Entry[];
  commitIndex?: number;
}

const view = (w: World, id: string) => w.nodes[id].state as RaftView;

export function oneLeaderPerTerm(w: World): string | null {
  const leaders = new Map<number, string>();
  for (const id of SERVERS) {
    if (w.nodes[id].crashed) continue;
    const s = view(w, id);
    if (s.role !== "leader") continue;
    const t = Number(s.currentTerm);
    const other = leaders.get(t);
    if (other) return `${other} and ${id} are both leader in term ${t}. Each server may vote once per term, so only one candidate can collect a majority.`;
    leaders.set(t, id);
  }
  return null;
}

const same = (a: Entry, b: Entry) => a.term === b.term && JSON.stringify(a.cmd) === JSON.stringify(b.cmd);

export function committedAgree(w: World): string | null {
  for (let i = 0; i < SERVERS.length; i++) {
    for (let j = i + 1; j < SERVERS.length; j++) {
      const a = view(w, SERVERS[i]);
      const b = view(w, SERVERS[j]);
      const n = Math.min(Number(a.commitIndex ?? 0), Number(b.commitIndex ?? 0));
      for (let k = 0; k < n; k++) {
        const x = a.log?.[k];
        const y = b.log?.[k];
        if (!x || !y) return `${!x ? SERVERS[i] : SERVERS[j]} says entry ${k + 1} is committed, but its log is shorter than that.`;
        if (!same(x, y)) {
          return `${SERVERS[i]} and ${SERVERS[j]} both say entry ${k + 1} is committed, but they disagree on it (term ${x.term} ${JSON.stringify(x.cmd)} versus term ${y.term} ${JSON.stringify(y.cmd)}).`;
        }
      }
    }
  }
  return null;
}

/* ---------------- the lab's client ---------------- */

interface ClientState {
  seq: number;
  cmd: unknown;
  guess: number;
}

const client: Handlers = {
  init: () => ({ seq: 0, cmd: null, guess: 0 }) as ClientState,
  onCommand(s: ClientState, cmd, ctx) {
    s.seq++;
    s.cmd = cmd;
    send(s, ctx);
    ctx.setTimer("retry", 60, s.seq);
  },
  onMessage(s: ClientState, _from, msg, ctx) {
    if (msg?.type !== "reply" || msg.seq !== s.seq || s.cmd === null) return;
    if (msg.ok) {
      s.cmd = null;
      ctx.reply(msg.result);
    } else if (typeof msg.leader === "string" && SERVERS.includes(msg.leader)) {
      // A follower told us who it thinks leads: try there next.
      s.guess = SERVERS.indexOf(msg.leader);
      send(s, ctx);
    }
  },
  onTimer(s: ClientState, t, ctx) {
    if (t.data !== s.seq || s.cmd === null) return;
    s.guess = (s.guess + 1) % SERVERS.length;
    send(s, ctx);
    ctx.setTimer("retry", 60, s.seq);
  },
};

function send(s: ClientState, ctx: Parameters<NonNullable<Handlers["onCommand"]>>[2]) {
  const c = s.cmd as { key: string; value: string };
  ctx.send(SERVERS[s.guess], { type: "request", client: ctx.self, seq: s.seq, key: c.key, value: c.value });
}

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with the ${name}'s handlers.`);
  return h as Handlers;
}

const appends = (c: string, values: string) => values.split("").map((value) => ({ op: "append", key: c, value }));

export const B5: ProtocolSpec = {
  id: "b5-raft",
  nodes: [
    { id: "s1", role: "server", label: "Server 1" },
    { id: "s2", role: "server", label: "Server 2" },
    { id: "s3", role: "server", label: "Server 3" },
    { id: "c1", role: "client", label: "Client 1" },
    { id: "c2", role: "client", label: "Client 2" },
  ],
  labRoles: ["client"],
  roles: (user) => ({ client, server: need(user, "server") }),
  workload: { c1: appends("c1", "abcdefgh"), c2: appends("c2", "ABCDEFGH") },
  checkerWorkload: { c1: appends("c1", "a") },
  invariants: [
    {
      name: "At most one leader per term",
      check: oneLeaderPerTerm,
      why: "Two candidates won the same term. A server must vote at most once per term (remember votedFor), and only for a candidate whose log is at least as up to date as its own.",
    },
    {
      name: "Committed entries agree",
      check: committedAgree,
      why: "Two servers committed different entries at the same index. A follower must only accept entries that continue its log exactly: check prevLogIndex and prevLogTerm, and delete anything that conflicts before appending.",
    },
    {
      name: "Every append happens exactly once",
      check: appliedOnce,
      why: "A client got back a value that's missing an earlier append (or has one twice). Usually a committed entry was lost: a server forgot its term, vote or log after a restart, or a candidate with a shorter log was elected and overwrote it.",
    },
  ],
  network: { delayMin: 1, delayMax: 6, drop: 0.08, duplicate: 0.08 },
  crashable: SERVERS,
  restart: true,
  // Keep a majority up: Raft stays safe with more failures, but can't make progress.
  canCrash: (w) => SERVERS.every((id) => !w.nodes[id].crashed),
  budget: { maxDepth: 22, maxStates: 150000, crashes: 4, timers: true },
};

export const B5_STARTER = `// Raft: three servers elect a leader and keep the same log.
//
// Every server keeps (the lab checks these four fields):
//   currentTerm   the latest term it has seen
//   role          "follower", "candidate" or "leader"
//   log           an array of { term, cmd }; entry 1 is log[0]
//   commitIndex   how many entries are known to be committed
//
// ctx.store(x) writes x to this server's disk, which survives a crash.
// ctx.stored() reads it back (null on a brand new server).
//
// Clients send { type: "request", client, seq, key, value }. Followers answer
// { type: "reply", seq, ok: false, leader } so the client can try the leader.
// The leader appends the command, and once it's committed and applied, answers
// { type: "reply", seq, ok: true, result }.
//
// This version mostly works on a perfect network. It has three bugs, marked TODO.

const ELECTION_MIN = 40;
const ELECTION_MAX = 80;
const HEARTBEAT = 10;
const SERVERS = ["s1", "s2", "s3"];
const MAJORITY = 2;

export const server = {
  init(ctx) {
    const s = {
      currentTerm: 0,
      votedFor: null,
      log: [],
      role: "follower",
      commitIndex: 0,
      lastApplied: 0,
      leader: null,
      votes: [],
      nextIndex: {},
      matchIndex: {},
      data: {},  // the key-value store the log is applied to
      last: {},  // client -> { seq, result }, so a retried command isn't applied twice
      timer: 0,
    };
    // TODO (crashes): after a restart, recover what you saved on disk.
    resetElectionTimer(s, ctx);
    return s;
  },

  onTimer(s, t, ctx) {
    if (t.name === "election" && t.data === s.timer && s.role !== "leader") startElection(s, ctx);
    if (t.name === "heartbeat" && s.role === "leader" && t.data === s.currentTerm) {
      for (const peer of others(ctx)) sendAppend(s, peer, ctx);
      ctx.setTimer("heartbeat", HEARTBEAT, s.currentTerm);
    }
  },

  onMessage(s, from, msg, ctx) {
    // Anyone with a newer term means our term is over.
    if (typeof msg.term === "number" && msg.term > s.currentTerm) {
      s.currentTerm = msg.term;
      s.votedFor = null;
      s.role = "follower";
      save(s, ctx);
    }

    if (msg.type === "requestVote") {
      // TODO (one leader per term): this grants every vote request for the
      // current term. A server may vote only once per term, and only for a
      // candidate whose log is at least as up to date as its own.
      const grant = msg.term === s.currentTerm;
      if (grant) {
        s.votedFor = from;
        save(s, ctx);
        resetElectionTimer(s, ctx);
      }
      ctx.send(from, { type: "vote", term: s.currentTerm, granted: grant });
    }

    if (msg.type === "vote" && s.role === "candidate" && msg.term === s.currentTerm && msg.granted) {
      if (!s.votes.includes(from)) s.votes.push(from);
      if (s.votes.length >= MAJORITY) becomeLeader(s, ctx);
    }

    if (msg.type === "appendEntries") {
      if (msg.term < s.currentTerm) {
        ctx.send(from, { type: "appendReply", term: s.currentTerm, success: false, match: 0 });
        return;
      }
      s.role = "follower";
      s.leader = from;
      resetElectionTimer(s, ctx);
      // TODO (logs that agree): this tacks the entries onto the end of the log.
      // Only accept them if our log has an entry at prevLogIndex whose term is
      // prevLogTerm; then delete anything after prevLogIndex that conflicts.
      s.log.push(...msg.entries);
      save(s, ctx);
      const match = msg.prevLogIndex + msg.entries.length;
      if (msg.leaderCommit > s.commitIndex) s.commitIndex = Math.min(msg.leaderCommit, s.log.length);
      apply(s, ctx);
      ctx.send(from, { type: "appendReply", term: s.currentTerm, success: true, match });
    }

    if (msg.type === "appendReply" && s.role === "leader" && msg.term === s.currentTerm) {
      if (msg.success) {
        s.matchIndex[from] = Math.max(s.matchIndex[from] ?? 0, msg.match);
        s.nextIndex[from] = s.matchIndex[from] + 1;
        advanceCommit(s, ctx);
      } else {
        // The follower's log didn't match: step back and try an earlier point.
        s.nextIndex[from] = Math.max(1, (s.nextIndex[from] ?? 1) - 1);
        sendAppend(s, from, ctx);
      }
    }

    if (msg.type === "request") {
      const done = s.last[msg.client];
      if (done && done.seq === msg.seq) {
        ctx.send(from, { type: "reply", seq: msg.seq, ok: true, result: done.result });
        return;
      }
      if (s.role !== "leader") {
        ctx.send(from, { type: "reply", seq: msg.seq, ok: false, leader: s.leader });
        return;
      }
      s.log.push({ term: s.currentTerm, cmd: { client: msg.client, seq: msg.seq, key: msg.key, value: msg.value } });
      save(s, ctx);
      for (const peer of others(ctx)) sendAppend(s, peer, ctx);
    }
  },
};

const others = (ctx) => SERVERS.filter((id) => id !== ctx.self);

function save(s, ctx) {
  // TODO (crashes): write what must survive a crash to disk.
  // Which fields does Raft need after a restart to stay safe?
}

function resetElectionTimer(s, ctx) {
  s.timer++;
  ctx.setTimer("election", ELECTION_MIN + ctx.random() * (ELECTION_MAX - ELECTION_MIN), s.timer);
}

function startElection(s, ctx) {
  s.currentTerm++;
  s.role = "candidate";
  s.votedFor = ctx.self;
  s.votes = [ctx.self];
  save(s, ctx);
  resetElectionTimer(s, ctx);
  const lastLogIndex = s.log.length;
  const lastLogTerm = lastLogIndex ? s.log[lastLogIndex - 1].term : 0;
  for (const peer of others(ctx)) ctx.send(peer, { type: "requestVote", term: s.currentTerm, lastLogIndex, lastLogTerm });
}

function becomeLeader(s, ctx) {
  s.role = "leader";
  s.leader = ctx.self;
  for (const peer of others(ctx)) {
    s.nextIndex[peer] = s.log.length + 1;
    s.matchIndex[peer] = 0;
    sendAppend(s, peer, ctx);
  }
  ctx.setTimer("heartbeat", HEARTBEAT, s.currentTerm);
}

function sendAppend(s, peer, ctx) {
  const next = s.nextIndex[peer] ?? s.log.length + 1;
  const prevLogIndex = next - 1;
  const prevLogTerm = prevLogIndex ? s.log[prevLogIndex - 1].term : 0;
  ctx.send(peer, {
    type: "appendEntries",
    term: s.currentTerm,
    prevLogIndex,
    prevLogTerm,
    entries: s.log.slice(prevLogIndex),
    leaderCommit: s.commitIndex,
  });
}

/** Commit the highest entry from this term that a majority has. */
function advanceCommit(s, ctx) {
  for (let n = s.log.length; n > s.commitIndex; n--) {
    // Only count entries from the current term (Raft's figure 8 explains why).
    if (s.log[n - 1].term !== s.currentTerm) break;
    const have = 1 + others(ctx).filter((p) => (s.matchIndex[p] ?? 0) >= n).length;
    if (have >= MAJORITY) {
      s.commitIndex = n;
      apply(s, ctx);
      break;
    }
  }
}

/** Apply committed entries in order. The leader also answers the client. */
function apply(s, ctx) {
  while (s.lastApplied < s.commitIndex) {
    const { cmd } = s.log[s.lastApplied];
    s.lastApplied++;
    const prev = s.last[cmd.client];
    if (prev && prev.seq >= cmd.seq) continue; // a duplicate of a command already applied
    s.data[cmd.key] = (s.data[cmd.key] ?? "") + cmd.value;
    s.last[cmd.client] = { seq: cmd.seq, result: s.data[cmd.key] };
    if (s.role === "leader") ctx.send(cmd.client, { type: "reply", seq: cmd.seq, ok: true, result: s.data[cmd.key] });
  }
}
`;
