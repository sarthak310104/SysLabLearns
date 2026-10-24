import type { CheckOptions, SimulateOptions } from "@/engine/protocol/check";
import type { NetworkConfig, ProtocolSpec } from "@/engine/protocol/types";
import { B0, B0_STARTER } from "./b0";
import { B1, B1_STARTER } from "./b1";
import { B2, B2_STARTER } from "./b2";
import { B3, B3_STARTER } from "./b3";
import { B4, B4_STARTER } from "./b4";

/**
 * A stage is one test the learner's code has to pass. Stages build on each
 * other: an easy network first, then faults, then every possible ordering.
 */
export interface Stage {
  id: string;
  title: string;
  blurb: string;
  /** A ladder of hints, shown one at a time on request: a nudge, a direction, then nearly the answer. */
  hints?: string[];
  kind: "simulate" | "check";
  /** Only these invariants count in this stage (default: all). */
  invariants?: string[];
  network?: Partial<NetworkConfig>;
  sim?: Partial<SimulateOptions>;
  check?: CheckOptions;
}

export interface ProtocolLab {
  id: string;
  /** Lesson slug this lab belongs to. */
  slug: string;
  spec: ProtocolSpec;
  starter: string;
  stages: Stage[];
}

export const SIM_DEFAULTS: SimulateOptions = { runs: 100, maxSteps: 600, healSteps: 3000, seed: 3, crashChance: 0, restartAfter: 50 };

export const LABS: ProtocolLab[] = [
  {
    id: B0.id,
    slug: "b0-foundations",
    spec: B0,
    starter: B0_STARTER,
    stages: [
      {
        id: "capitals",
        title: "Answer in capitals",
        blurb: "50 runs. Every request gets a reply, and the reply contains the text in capital letters.",
        hints: ["The server reads each message but never sends anything back. Which ctx function sends a message?", "Inside the if, send a message to `from` with type \"reply\", the same seq as the request, and the text in capitals as result.", "ctx.send(from, { type: \"reply\", seq: msg.seq, result: msg.text.toUpperCase() });"],
        kind: "simulate",
        invariants: ["Replies are in capitals"],
        sim: { runs: 50 },
      },
      {
        id: "numbered",
        title: "Number each client's requests",
        blurb: 'Reply "1: HELLO", then "2: WORLD", counting each client separately. The server has to remember.',
        hints: ["The server has to remember how many requests each client has sent. Where does a node keep memory between messages?", "Return { counts: {} } from init. In onMessage, add one to state.counts[from] before replying (it starts undefined, so use ?? 0), and put the count at the front of the result.", "state.counts[from] = (state.counts[from] ?? 0) + 1;\nctx.send(from, {\n  type: \"reply\",\n  seq: msg.seq,\n  result: state.counts[from] + \": \" + msg.text.toUpperCase(),\n});"],
        kind: "simulate",
        sim: { runs: 50 },
      },
    ],
  },
  {
    id: B1.id,
    slug: "b1-clocks",
    spec: B1,
    starter: B1_STARTER,
    stages: [
      {
        id: "lamport",
        title: "Lamport clocks",
        blurb: "100 random runs. If one event happened before another, its Lamport time must be smaller.",
        hints: ["A receive always happens after the send it belongs to, so its timestamp must be bigger than the stamp the message carried.", "In receive, first move your clock up to at least the stamp you were sent, then tick by one.", "receive(state, stamp) {\n  state.time = Math.max(state.time, stamp) + 1;\n  return state.time;\n}"],
        kind: "simulate",
        invariants: ["Lamport clocks respect causality"],
      },
      {
        id: "vector",
        title: "Vector clocks",
        blurb: "100 random runs. Comparing two vector stamps must tell you exactly whether one event happened before the other.",
        hints: ["A vector clock keeps one counter per process. A process only bumps its own counter; it learns the others' counts from messages.", "init: a 0 for every process. localEvent and send: add one to your own slot and return a copy. receive: take the larger of each slot from the stamp, then add one to your own.", "init(self, everyone) {\n  const v = {};\n  for (const p of everyone) v[p] = 0;\n  return { self, v };\n},\nlocalEvent(s) { s.v[s.self] += 1; return { ...s.v }; },\nsend(s) { s.v[s.self] += 1; return { ...s.v }; },\nreceive(s, stamp) {\n  for (const p in stamp) s.v[p] = Math.max(s.v[p], stamp[p]);\n  s.v[s.self] += 1;\n  return { ...s.v };\n},"],
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker tries every order the messages could arrive in, up to a depth.",
        hints: ["If random runs pass, this usually does too. The checker just tries orders that random runs rarely hit.", "Look for a stamp that changes after it was returned. If you return the vector itself, a later event that changes it also changes the old timestamp.", "Return { ...state.v } (a copy) everywhere you hand back a vector, and merge before you tick in receive."],
        kind: "check",
        check: { timeLimitMs: 20000 },
      },
    ],
  },
  {
    id: B2.id,
    slug: "b2-rpc",
    spec: B2,
    starter: B2_STARTER,
    stages: [
      {
        id: "perfect",
        title: "Perfect network",
        blurb: "Nothing is lost or repeated. 50 runs with random delays.",
        hints: ["Nothing is lost on a perfect network, so the starter code should already pass. Try Check first.", "If it fails, the client must send the command to the server, wait for the reply, and call ctx.reply once with msg.result.", "The starter's client and server, unchanged, are a complete answer for this stage."],
        kind: "simulate",
        network: { drop: 0, duplicate: 0 },
        sim: { runs: 50 },
      },
      {
        id: "lossy",
        title: "Lossy network",
        blurb: "One in five messages is lost and one in five arrives twice. 100 runs, then the network heals and every command must finish.",
        hints: ["Two things go wrong. A lost request or reply leaves the client waiting forever. A repeated request makes the server append twice.", "Client: number each command (seq) and resend it on a timer until the reply for that seq arrives. Server: remember, per client, the last seq it did and the answer it gave. For a repeat, send the saved answer back instead of appending again.", "// client\nonCommand(state, cmd, ctx) {\n  state.seq = (state.seq ?? 0) + 1;\n  state.cmd = cmd;\n  state.waiting = true;\n  send(state, ctx);\n},\nonTimer(state, timer, ctx) {\n  if (state.waiting && timer.data === state.seq) send(state, ctx);\n},\n// with: function send(state, ctx) {\n//   ctx.send(ctx.nodes(\"server\")[0], { type: \"request\", seq: state.seq, cmd: state.cmd });\n//   ctx.setTimer(\"retry\", 30, state.seq);\n// }\n// and in onMessage, accept only msg.seq === state.seq.\n\n// server, before applying\nconst prev = state.last[from];\nif (prev && prev.seq === msg.seq) {\n  ctx.send(from, { type: \"reply\", seq: msg.seq, result: prev.result });\n  return;\n}\n// ...apply, then:\nstate.last[from] = { seq: msg.seq, result: state.data[key] };"],
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker tries every way messages can be delayed, lost, repeated and reordered, with a smaller workload.",
        hints: ["A very old copy of a request can arrive after the client has already moved on to newer commands.", "If a request's seq is older than the last one the server did for that client, the client already has its answer. The server should ignore it.", "const prev = state.last[from];\nif (prev && msg.seq < prev.seq) return; // stale copy\nif (prev && msg.seq === prev.seq) { /* resend saved answer */ }"],
        kind: "check",
        check: { timeLimitMs: 60000 },
      },
    ],
  },
  {
    id: B3.id,
    slug: "b3-primary-backup",
    spec: B3,
    starter: B3_STARTER,
    stages: [
      {
        id: "steady",
        title: "No crashes",
        blurb: "Servers stay up, but the network loses and repeats some messages. 40 runs.",
        hints: ["Clients retry, and the primary already spots repeats. What's missing is the backup: it never hears about any append.", "Keep one request pending at a time. Forward it to the backup, and apply and reply only when the backup confirms. Messages get lost, so resend the forward on the ping timer until the confirmation arrives. The backup applies the same append and records the same duplicate-table entry, so a repeat forward is harmless.", "// primary, for a new request (ignore others while one is pending; clients retry):\nstate.pending = { client: msg.client, seq: msg.seq, cmd: msg.cmd };\nif (state.view.backup) ctx.send(state.view.backup, { type: \"forward\", view: state.view.num, ...state.pending });\nelse finish(state, ctx); // apply, record in state.last, reply to the client\n\n// on the ping timer: if (state.pending) send the forward again\n\n// backup, on \"forward\" for its view:\n//   apply it with the same duplicate check (skip if state.last[client].seq >= seq)\n//   ctx.send(from, { type: \"forwardOk\", view: msg.view, client: msg.client, seq: msg.seq });\n\n// primary, on \"forwardOk\" matching state.pending: finish(state, ctx);"],
        kind: "simulate",
        sim: { runs: 40, maxSteps: 3000, healSteps: 6000, crashChance: 0 },
      },
      {
        id: "crashes",
        title: "Crashes and restarts",
        blurb: "60 runs where servers crash and come back empty, as long as a backup exists to take over.",
        hints: ["When the primary crashes the backup takes over, but the new backup the view server picks starts out empty.", "When a view names a backup, the primary sends it a full copy (data and the duplicate table) and only sets readyView to that view once the backup confirms. Resend the copy on the ping timer until it does. A view with no backup is ready straight away.", "// primary, on a new view:\nif (state.view.backup) { state.syncing = true; sendCopy(state, ctx); }\nelse state.readyView = state.view.num;\n// function sendCopy(s, ctx) {\n//   ctx.send(s.view.backup, { type: \"sync\", view: s.view.num, data: s.data, last: s.last });\n// }\n// on the ping timer: if (state.syncing) sendCopy(state, ctx);\n\n// backup, on \"sync\":\nstate.data = msg.data;\nstate.last = msg.last;\nctx.send(from, { type: \"syncOk\", view: msg.view });\n\n// primary, on \"syncOk\" for the current view from its backup:\nstate.syncing = false;\nstate.readyView = state.view.num;"],
        kind: "simulate",
        sim: { runs: 60, maxSteps: 3000, healSteps: 6000, crashChance: 0.004, restartAfter: 150 },
      },
    ],
  },
  {
    id: B4.id,
    slug: "b4-paxos",
    spec: B4,
    starter: B4_STARTER,
    stages: [
      {
        id: "random",
        title: "Random runs",
        blurb: "100 runs with lost and repeated messages. Plenty of bugs survive this.",
        hints: ["Read each promise carefully: it says whether that acceptor has already accepted a value, and under which ballot.", "Keep what each promise reported, not just who sent it. Once you have a majority, if any promise carries an accepted value, you must propose the one with the highest acceptedBallot instead of your own value.", "// promises as an object keyed by sender, so each acceptor counts once:\nif (msg.type === \"promise\" && !(from in state.promises)) {\n  state.promises[from] = { ballot: msg.acceptedBallot, value: msg.acceptedValue };\n  if (Object.keys(state.promises).length === majority) {\n    let best = null;\n    for (const p of Object.values(state.promises)) {\n      if (p.ballot > 0 && (!best || p.ballot > best.ballot)) best = p;\n    }\n    const value = best ? best.value : state.value;\n    // send { type: \"accept\", ballot: state.ballot, value } to every acceptor\n  }\n}\n// and use state.promises = {} in startRound"],
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker searches every interleaving of the two proposers. This is where Paxos bugs show up.",
        hints: ["A message that arrives twice can be counted twice.", "Count each acceptor's accepted reply at most once, the same way promises are counted by who sent them.", "if (msg.type === \"accepted\" && !state.acceptedBy.includes(from)) {\n  state.acceptedBy.push(from);\n  if (state.acceptedBy.length === majority) { /* decide */ }\n}\n// and reset state.acceptedBy = [] in startRound"],
        kind: "check",
        check: { timeLimitMs: 30000 },
      },
    ],
  },
];

export const labById = (id: string) => LABS.find((l) => l.id === id);
export const labBySlug = (slug: string) => LABS.find((l) => l.slug === slug);

/** The spec a stage runs against (some stages change the network). */
export function stageSpec(lab: ProtocolLab, stage: Stage | null): ProtocolSpec {
  if (!stage?.network) return lab.spec;
  return { ...lab.spec, network: { ...lab.spec.network, ...stage.network } };
}
