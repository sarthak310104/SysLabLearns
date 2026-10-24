import { A1, A2, A3 } from "./system-design/presets";
import { A4, A5, A6, A7, A8 } from "./system-design/presets2";
import { A9, A10, A11, A12 } from "./system-design/presets3";
import type { Preset } from "@/lib/goals";
import { labBySlug, type ProtocolLab } from "./protocols";

export interface Module {
  code: string;
  title: string;
  /** One line: what you'll see go wrong. */
  breaks: string;
  slug?: string;
  preset?: Preset;
  /** Protocol modules: the coding lab, whose stages are the goals. */
  lab?: ProtocolLab;
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
      { code: "A4", title: "Databases and replication", breaks: "Replicas fall behind and readers see old data.", slug: "a4-replication", preset: A4 },
      { code: "A5", title: "Sharding", breaks: "One celebrity key overloads a single shard.", slug: "a5-sharding", preset: A5 },
      { code: "A6", title: "Queues and async work", breaks: "Spikes build a backlog, and workers must keep up on average.", slug: "a6-queues", preset: A6 },
      { code: "A7", title: "Timeouts, retries and circuit breakers", breaks: "A slow database plus impatient retries: lots of work, no answers.", slug: "a7-resilience", preset: A7 },
      { code: "A8", title: "Consistency and partitions", breaks: "The network splits and you must pick: refuse writes or diverge.", slug: "a8-partitions", preset: A8 },
      { code: "A9", title: "CDNs and network distance", breaks: "Users half a world away wait for the speed of light.", slug: "a9-cdn", preset: A9 },
      { code: "A10", title: "Consistent hashing", breaks: "Adding one cache shard sends a wave of misses to the database.", slug: "a10-consistent-hashing", preset: A10 },
      { code: "A11", title: "Rate limiting and noisy neighbours", breaks: "One client's buggy script takes capacity from everyone.", slug: "a11-rate-limiting", preset: A11 },
      { code: "A12", title: "Autoscaling", breaks: "New servers arrive after the spike is already over.", slug: "a12-autoscaling", preset: A12 },
    ],
  },
  {
    id: "protocols",
    title: "Distributed protocols",
    blurb: "Write the code inside each box, then let a checker hunt for the order of events that breaks it.",
    modules: [
      { code: "B1", title: "Time and ordering", breaks: "Clocks drift and two events swap order.", slug: "b1-clocks", lab: labBySlug("b1-clocks") },
      { code: "B2", title: "Exactly-once RPC", breaks: "A retried request runs twice.", slug: "b2-rpc", lab: labBySlug("b2-rpc") },
      { code: "B3", title: "Primary-backup", breaks: "The primary crashes and the backup takes over without the latest writes.", slug: "b3-primary-backup", lab: labBySlug("b3-primary-backup") },
      { code: "B4", title: "Paxos", breaks: "A leader skips one check and two values get chosen.", slug: "b4-paxos", lab: labBySlug("b4-paxos") },
      { code: "B5", title: "Raft", breaks: "An entry from an old term gets committed, then lost.", comingIn: "Phase 4" },
      { code: "B6", title: "Sharded key-value store", breaks: "During a handoff, two groups both serve the same key.", comingIn: "Phase 4" },
      { code: "B7", title: "Two-phase commit", breaks: "The coordinator crashes mid-commit and everyone waits.", comingIn: "Phase 4" },
      { code: "B8", title: "CRDTs and chain replication", breaks: "Concurrent edits collide without a merge rule.", comingIn: "Phase 4" },
    ],
  },
];

export const LESSONS = TRACKS.flatMap((t) => t.modules).filter((m): m is Module & { slug: string; preset: Preset } => Boolean(m.slug && m.preset));

export const PROTOCOL_LESSONS = TRACKS.flatMap((t) => t.modules).filter((m): m is Module & { slug: string; lab: ProtocolLab } => Boolean(m.slug && m.lab));

export function protocolLessonBySlug(slug: string) {
  const i = PROTOCOL_LESSONS.findIndex((l) => l.slug === slug);
  return i < 0 ? null : { lesson: PROTOCOL_LESSONS[i], prev: PROTOCOL_LESSONS[i - 1] ?? null, next: PROTOCOL_LESSONS[i + 1] ?? null };
}

/** The goals (or stages) a module tracks, as ids. */
export function moduleGoalIds(m: Module): string[] {
  return m.preset?.goals.map((g) => g.id) ?? m.lab?.stages.map((s) => s.id) ?? [];
}

export function lessonBySlug(slug: string) {
  const i = LESSONS.findIndex((l) => l.slug === slug);
  return i < 0 ? null : { lesson: LESSONS[i], prev: LESSONS[i - 1] ?? null, next: LESSONS[i + 1] ?? null };
}
