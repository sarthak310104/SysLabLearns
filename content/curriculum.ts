import { A1, A2, A3 } from "./system-design/presets";
import type { Preset } from "@/lib/goals";

export interface Module {
  code: string;
  title: string;
  /** One line: what you'll see go wrong. */
  breaks: string;
  slug?: string;
  preset?: Preset;
  /** Shown instead of a link while the module isn't built yet. */
  comingIn?: string;
}

export interface Track {
  id: "system-design" | "protocols";
  title: string;
  blurb: string;
  modules: Module[];
}

export const TRACKS: Track[] = [
  {
    id: "system-design",
    title: "System design",
    blurb: "Wire up components, send traffic through them, and find what gives out first.",
    modules: [
      { code: "A1", title: "Requests, latency and throughput", breaks: "One server, rising load: queues grow and requests get turned away.", slug: "a1-requests", preset: A1 },
      { code: "A2", title: "Load balancing", breaks: "A slow server drags everyone down, and a dead one keeps getting traffic.", slug: "a2-load-balancing", preset: A2 },
      { code: "A3", title: "Caching", breaks: "The database melts under reads, and a cold cache brings it back.", slug: "a3-caching", preset: A3 },
      { code: "A4", title: "Databases and replication", breaks: "Replicas fall behind and readers see old data.", comingIn: "Phase 2" },
      { code: "A5", title: "Sharding", breaks: "One celebrity key overloads a single shard.", comingIn: "Phase 2" },
      { code: "A6", title: "Queues and async work", breaks: "Consumers fall behind and the backlog never drains.", comingIn: "Phase 2" },
      { code: "A7", title: "Timeouts, retries and circuit breakers", breaks: "Retries turn a small outage into a big one.", comingIn: "Phase 2" },
      { code: "A8", title: "Consistency and partitions", breaks: "The network splits and you must pick: refuse writes or diverge.", comingIn: "Phase 2" },
    ],
  },
  {
    id: "protocols",
    title: "Distributed protocols",
    blurb: "Write the code inside each box, then let a checker hunt for the order of events that breaks it.",
    modules: [
      { code: "B1", title: "Time and ordering", breaks: "Clocks drift and two events swap order.", comingIn: "Phase 3" },
      { code: "B2", title: "Exactly-once RPC", breaks: "A retried request runs twice.", comingIn: "Phase 3" },
      { code: "B3", title: "Primary-backup", breaks: "Split brain: two servers both think they are in charge.", comingIn: "Phase 3" },
      { code: "B4", title: "Paxos", breaks: "A leader skips one check and two values get chosen.", comingIn: "Phase 3" },
      { code: "B5", title: "Raft", breaks: "An entry from an old term gets committed, then lost.", comingIn: "Phase 4" },
      { code: "B6", title: "Sharded key-value store", breaks: "During a handoff, two groups both serve the same key.", comingIn: "Phase 4" },
      { code: "B7", title: "Two-phase commit", breaks: "The coordinator crashes mid-commit and everyone waits.", comingIn: "Phase 4" },
      { code: "B8", title: "CRDTs and chain replication", breaks: "Concurrent edits collide without a merge rule.", comingIn: "Phase 4" },
    ],
  },
];

export const LESSONS = TRACKS.flatMap((t) => t.modules).filter((m): m is Module & { slug: string; preset: Preset } => Boolean(m.slug && m.preset));

export function lessonBySlug(slug: string) {
  const i = LESSONS.findIndex((l) => l.slug === slug);
  return i < 0 ? null : { lesson: LESSONS[i], prev: LESSONS[i - 1] ?? null, next: LESSONS[i + 1] ?? null };
}
