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
  /** Shown on request in the lesson's goal list. */
  hint?: string;
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
        hint: 'Inside the if: ctx.send(from, { type: "reply", seq: msg.seq, result: msg.text.toUpperCase() });',
        kind: "simulate",
        invariants: ["Replies are in capitals"],
        sim: { runs: 50 },
      },
      {
        id: "numbered",
        title: "Number each client's requests",
        blurb: 'Reply "1: HELLO", then "2: WORLD", counting each client separately. The server has to remember.',
        hint: "Start with state = { counts: {} } in init. In onMessage, add one to state.counts[from] (it starts undefined, so use ?? 0).",
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
        hint: "On receive, a Lamport clock has to jump past the stamp it was sent, not just tick.",
        kind: "simulate",
        invariants: ["Lamport clocks respect causality"],
      },
      {
        id: "vector",
        title: "Vector clocks",
        blurb: "100 random runs. Comparing two vector stamps must tell you exactly whether one event happened before the other.",
        hint: "Each process counts its own events in its own slot. On receive, take the larger of each slot, then count the receive itself.",
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker tries every order the messages could arrive in, up to a depth.",
        hint: "If random runs pass, this usually does too. If it fails, the trace shows an ordering random runs never hit.",
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
        hint: "Send the request, wait for the reply, hand the result to ctx.reply.",
        kind: "simulate",
        network: { drop: 0, duplicate: 0 },
        sim: { runs: 50 },
      },
      {
        id: "lossy",
        title: "Lossy network",
        blurb: "One in five messages is lost and one in five arrives twice. 100 runs, then the network heals and every command must finish.",
        hint: "Retry on a timer until a reply arrives. The server must spot a request it has already done and send back the saved answer instead of doing it again.",
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker tries every way messages can be delayed, lost, repeated and reordered, with a smaller workload.",
        hint: "A very old copy of a request can arrive after newer ones. What should the server do with it?",
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
        hint: "Clients retry, so the primary needs duplicate detection, just like B2. Forward each request to the backup and only reply once the backup confirms.",
        kind: "simulate",
        sim: { runs: 40, maxSteps: 3000, healSteps: 6000, crashChance: 0 },
      },
      {
        id: "crashes",
        title: "Crashes and restarts",
        blurb: "60 runs where servers crash and come back empty, as long as a backup exists to take over.",
        hint: "When a new backup appears, send it a full copy (data and duplicate table) and don't ping the new view number until it confirms.",
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
        hint: "Read each promise carefully: it may carry a value that acceptor already accepted.",
        kind: "simulate",
      },
      {
        id: "orderings",
        title: "Every ordering",
        blurb: "The model checker searches every interleaving of the two proposers. This is where Paxos bugs show up.",
        hint: "Among the promises you collect, the one with the highest accepted ballot decides what you must propose. Count each acceptor once.",
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
