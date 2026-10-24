import type { ComponentKind, EdgeStats, NodeStats } from "@/engine/model/types";

/**
 * One scale for how a component or link is doing, used for colors on the
 * canvas and for the verdict panel:
 *   ideal    blue    plenty of room
 *   good     green   busy and healthy
 *   strained yellow  works, but something should be improved
 *   failing  red     overloaded or losing requests
 */
export type Health = "idle" | "ideal" | "good" | "strained" | "failing" | "down" | "cut";

export const HEALTH_COLOR: Record<Health, string> = {
  idle: "var(--line)",
  ideal: "var(--h-ideal)",
  good: "var(--h-good)",
  strained: "var(--h-strained)",
  failing: "var(--h-failing)",
  down: "var(--h-failing)",
  cut: "var(--h-failing)",
};

export const HEALTH_LABEL: Record<Health, string> = {
  idle: "No traffic",
  ideal: "Plenty of room",
  good: "Busy and healthy",
  strained: "Could be better",
  failing: "Overloaded or failing",
  down: "Down",
  cut: "Link cut",
};

const RANK: Record<Health, number> = { idle: 0, ideal: 1, good: 2, strained: 3, failing: 4, down: 5, cut: 5 };
export const worse = (a: Health, b: Health): Health => (RANK[a] >= RANK[b] ? a : b);

/** How full a component is, 0..1, for the kinds where that means something. */
export function loadOf(s: NodeStats): number | null {
  if (s.kind === "server" || s.kind === "database" || s.kind === "replica") return s.utilization;
  if (s.kind === "queue") return s.queueLimit ? s.queue / s.queueLimit : 0;
  return null;
}

export function nodeHealth(s: NodeStats | undefined): Health {
  if (!s) return "idle";
  if (s.down) return "down";
  if (s.status === "critical") return "failing";
  if (s.status === "warning") return "strained";
  if (s.status === "idle") return "idle";
  const load = loadOf(s);
  if (load !== null && load >= 0.5) return "good";
  return "ideal";
}

/** A link takes the health of what it feeds, made worse by failures on the link itself. */
export function edgeHealth(e: EdgeStats | undefined, target: NodeStats | undefined, cut: boolean): Health {
  if (cut) return "cut";
  if (!e || e.perSec <= 0) return target?.down ? "down" : "idle";
  let h = nodeHealth(target);
  if (h === "idle") h = "ideal";
  if (e.errorRate > 0.05) h = worse(h, "failing");
  else if (e.errorRate > 0.005) h = worse(h, "strained");
  return h;
}

/** Line thickness from traffic: thin when quiet, heavier as requests per second grow. */
export function edgeWidth(perSec: number): number {
  if (perSec <= 0) return 1.5;
  return Math.min(6, 2 + Math.log10(1 + perSec) * 1.3);
}

export interface Finding {
  health: Exclude<Health, "idle" | "ideal" | "good">;
  nodeId: string;
  text: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Plain-words findings for the verdict panel: what's wrong and what usually
 * fixes it. Worst first.
 */
export function findings(nodes: Record<string, NodeStats>, labels: Record<string, string>, kinds: Record<string, ComponentKind>, cutCount: number): Finding[] {
  const out: Finding[] = [];
  const name = (id: string) => labels[id] ?? id;
  const hasCache = Object.values(kinds).includes("cache");
  const hasReplica = Object.values(kinds).includes("replica");

  for (const s of Object.values(nodes)) {
    const n = name(s.id);
    if (s.down) {
      out.push({ health: "down", nodeId: s.id, text: `${n} is down. Anything that depends on it fails unless there's another copy to fall back on.` });
      continue;
    }
    if (s.kind === "client") {
      const sending = s.sendingRps ?? 0;
      const amp = sending > 0 && s.attemptsPerSec ? s.attemptsPerSec / sending : 1;
      if (s.errorRate > 0.05) out.push({ health: "failing", nodeId: s.id, text: `Only ${pct(1 - s.errorRate)} of ${n}'s requests succeed. Follow the red links to find where they fail.` });
      else if (s.errorRate > 0.005) out.push({ health: "strained", nodeId: s.id, text: `${n} sees ${pct(s.errorRate)} of requests fail. Small, but users notice.` });
      if (amp > 1.5) out.push({ health: "failing", nodeId: s.id, text: `${n} is sending ${amp.toFixed(1)}x its real traffic because of retries. Add backoff and a retry budget.` });
      else if (amp > 1.15) out.push({ health: "strained", nodeId: s.id, text: `Retries add ${pct(amp - 1)} extra load from ${n}. Fine during a blip, dangerous during an outage.` });
      if (s.p99 > 1000 && s.errorRate <= 0.05) out.push({ health: "strained", nodeId: s.id, text: `The slowest 1% of ${n}'s requests take over a second.` });
      continue;
    }
    if (s.kind === "server" || s.kind === "database" || s.kind === "replica") {
      const u = s.utilization;
      const qf = s.queueLimit ? s.queue / s.queueLimit : 0;
      if (s.errorRate > 0.05 || qf > 0.8) {
        const fix =
          s.kind === "server"
            ? "Add workers or more servers behind the load balancer."
            : !hasCache
              ? "Put a cache in front of it, or add read replicas for reads."
              : !hasReplica && s.kind === "database"
                ? "Add read replicas, or raise its connections."
                : "Raise its capacity or take load off it.";
        out.push({ health: "failing", nodeId: s.id, text: `${n} is overloaded (${pct(u)} busy, turning away ${pct(s.errorRate)} of requests). ${fix}` });
      } else if (u > 0.85) {
        out.push({ health: "strained", nodeId: s.id, text: `${n} is ${pct(u)} busy. A small spike will start a queue; leave more headroom.` });
      } else if (qf > 0.2) {
        out.push({ health: "strained", nodeId: s.id, text: `Requests are queueing at ${n}. It's keeping up, barely.` });
      }
      if ((s.lagMs ?? 0) > 1000) out.push({ health: "strained", nodeId: s.id, text: `${n} is ${(s.lagMs! / 1000).toFixed(1)} s behind its primary, so reads there can be out of date.` });
      if ((s.staleRate ?? 0) > 0.05) out.push({ health: "strained", nodeId: s.id, text: `${pct(s.staleRate!)} of reads from ${n} return old data.` });
      if ((s.lostUpdates ?? 0) > 0) out.push({ health: "failing", nodeId: s.id, text: `${n} has overwritten ${s.lostUpdates} conflicting writes. Data was lost.` });
      if (s.breakerOpen) out.push({ health: "strained", nodeId: s.id, text: `${n}'s circuit breaker is open: it's failing fast instead of waiting on something broken.` });
      continue;
    }
    if (s.kind === "queue") {
      const qf = s.queueLimit ? s.queue / s.queueLimit : 0;
      if (qf > 0.8) out.push({ health: "failing", nodeId: s.id, text: `${n} is nearly full (${s.queue} waiting). Consumers can't keep up: add more.` });
      else if ((s.oldestAgeMs ?? 0) > 5000) out.push({ health: "strained", nodeId: s.id, text: `Messages wait over 5 s in ${n}. Fine for background work, slow for anything a user waits on.` });
      if ((s.deadLetters ?? 0) > 0) out.push({ health: "failing", nodeId: s.id, text: `${n} gave up on ${s.deadLetters} messages after repeated failures.` });
      continue;
    }
    if (s.kind === "cache") {
      if ((s.hitRatio ?? 1) < 0.5 && s.okPerSec > 0) out.push({ health: "strained", nodeId: s.id, text: `${n} answers only ${pct(s.hitRatio ?? 0)} of lookups. A bigger cache or a longer expiry would help.` });
      continue;
    }
    if (s.kind === "loadBalancer") {
      if ((s.limitedPerSec ?? 0) > 0) out.push({ health: "strained", nodeId: s.id, text: `${n} is rate limiting ${Math.round(s.limitedPerSec!)} requests a second. Intended if a client is misbehaving.` });
      else if (s.errorRate > 0.05) out.push({ health: "failing", nodeId: s.id, text: `${n} can't place ${pct(s.errorRate)} of requests: the servers behind it are full or down.` });
    }
  }
  if (cutCount > 0) out.push({ health: "cut", nodeId: "", text: `${cutCount} link${cutCount > 1 ? "s are" : " is"} cut. Requests sent over ${cutCount > 1 ? "them" : "it"} are lost.` });

  const order: Record<Finding["health"], number> = { cut: 0, down: 0, failing: 1, strained: 2 };
  return out.sort((a, b) => order[a.health] - order[b.health]);
}

export type Verdict = "idle" | "healthy" | "improve" | "failing";

export function verdictOf(nodes: Record<string, NodeStats>, fs: Finding[]): Verdict {
  const active = Object.values(nodes).some((s) => s.okPerSec + s.errorsPerSec > 0);
  if (!active) return "idle";
  if (fs.some((f) => f.health !== "strained")) return "failing";
  if (fs.length) return "improve";
  return "healthy";
}
