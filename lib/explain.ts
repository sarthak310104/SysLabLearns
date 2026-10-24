import { withDefaults } from "@/engine/model/defaults";
import type { ComponentKind, Graph, GraphNode, NodeStats, Snapshot } from "@/engine/model/types";

/*
 * "Explain this": turns a live snapshot into plain sentences, the way a
 * teacher would narrate the lab. Numbers come from the run; the reasoning
 * (capacity = workers / time per request, Little's law for waiting) is the
 * same arithmetic the lessons teach.
 */

const r = (n: number) => (n >= 10 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1));
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} seconds` : `${Math.round(n)} ms`);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function cfg<T>(n: GraphNode): T {
  return withDefaults(n.kind, n.config) as unknown as T;
}

/** Requests per second a pool can finish on its own work alone. */
export function capacityOf(n: GraphNode, s: NodeStats | undefined): number | null {
  if (n.kind !== "server" && n.kind !== "database" && n.kind !== "replica") return null;
  const c = cfg<{ workers: number; serviceMs: number }>(n);
  const workers = s?.workers ?? c.workers;
  const slow = s?.slowFactor ?? 1;
  return (workers * 1000) / (c.serviceMs * slow);
}

/** Sentences about one component, for the inspector. */
export function explainNode(graph: Graph, snap: Snapshot | null, id: string): string[] {
  const n = graph.nodes.find((x) => x.id === id);
  if (!n) return [];
  const s = snap?.nodes[id];
  const name = n.label;
  if (!s || (s.okPerSec + s.errorsPerSec === 0 && !s.down && s.busy === 0)) {
    return n.kind === "client" ? [`${name} will send traffic once you press Send traffic.`] : [`No requests have reached ${name} yet.`];
  }
  if (s.down) return [`${name} is down, so every request sent to it fails straight away. Anything that depends on it fails too, unless there's another copy to send traffic to instead.`];
  const out: string[] = [];
  const incoming = s.okPerSec + s.errorsPerSec;
  const targets = graph.edges.filter((e) => e.source === id).map((e) => graph.nodes.find((x) => x.id === e.target)!).filter(Boolean);
  const names = (ns: GraphNode[]) => (ns.length === 1 ? ns[0].label : ns.length === 2 ? `${ns[0].label} and ${ns[1].label}` : `${ns.length} components`);

  switch (n.kind as ComponentKind) {
    case "client": {
      const c = cfg<{ rps: number; retries: number; timeoutMs: number }>(n);
      const sending = s.sendingRps ?? 0;
      const amp = sending > 0 && s.attemptsPerSec ? s.attemptsPerSec / sending : 1;
      const factor = snap?.loadFactor ?? 1;
      out.push(`${name} ${factor !== 1 ? `normally sends ${r(c.rps)} requests a second; an event has made that ${factor}x, so it's sending ${r(sending)}` : `send ${r(sending)} new requests a second`}${targets.length ? ` to ${names(targets)}` : ""}.`);
      const fail = s.errorRate;
      if (fail < 0.001) out.push(`Nearly all of them succeed, and the slowest 1% take ${ms(s.p99)}.`);
      else out.push(`${pct(fail)} of them fail. The slowest 1% of the ones that succeed take ${ms(s.p99)}.`);
      if (amp > 1.15) out.push(`Because failed attempts are retried${c.retries ? ` up to ${c.retries} times` : ""}, ${name} is really making ${r(s.attemptsPerSec ?? 0)} attempts a second, ${amp.toFixed(1)}x the real traffic. That extra load is often what keeps an overloaded system from recovering.`);
      if (c.timeoutMs > 0 && s.p99 >= c.timeoutMs * 0.9) out.push(`Users give up after ${ms(c.timeoutMs)}, and the slowest requests are hitting that limit: those count as failures even if the server finishes later.`);
      return out;
    }
    case "loadBalancer": {
      const c = cfg<{ strategy: string; healthChecks: boolean; rateLimit: number }>(n);
      const strategy: Record<string, string> = {
        roundRobin: "takes turns, one server after another",
        leastConnections: "sends each request to the server with the fewest requests in progress",
        random: "picks a server at random",
        keyHash: "sends each key to the same server every time",
        consistentHash: "places servers on a hash ring so each key has a home",
      };
      out.push(`${name} passes on ${r(s.okPerSec)} requests a second to ${names(targets)}. It ${strategy[c.strategy] ?? "spreads them out"}.`);
      if ((s.limitedPerSec ?? 0) > 0) out.push(`Its rate limit (${r(c.rateLimit)} a second) is turning away ${r(s.limitedPerSec!)} a second on purpose.`);
      const down = targets.filter((t) => snap?.nodes[t.id]?.down);
      if (down.length && !c.healthChecks) out.push(`${names(down)} ${down.length > 1 ? "are" : "is"} down, but health checks are off, so ${name} keeps sending ${down.length > 1 ? "them" : "it"} requests that fail. Turning health checks on would route around ${down.length > 1 ? "them" : "it"}.`);
      else if (down.length) out.push(`${names(down)} ${down.length > 1 ? "are" : "is"} down; health checks noticed and stopped sending ${down.length > 1 ? "them" : "it"} traffic.`);
      if (s.errorRate > 0.01) out.push(`${pct(s.errorRate)} of requests fail because the servers behind it are full or down.`);
      return out;
    }
    case "cache": {
      const c = cfg<{ capacity: number; ttlMs: number }>(n);
      const hit = s.hitRatio ?? 0;
      out.push(`${name} holds up to ${r(c.capacity)} items, each for ${ms(c.ttlMs)}. It answers ${pct(hit)} of lookups from memory.`);
      if (targets.length) out.push(`The other ${pct(1 - hit)}, about ${r(incoming * (1 - hit))} a second, go on to ${names(targets)}.`);
      if (hit < 0.5) out.push(`That's a low hit ratio: either the cache is too small for how many different items people ask for, or items expire before they're asked for again. Raising the capacity or the expiry time would help.`);
      return out;
    }
    case "queue": {
      const c = cfg<{ capacity: number; maxRetries: number }>(n);
      const processed = s.processedPerSec ?? 0;
      out.push(`${name} has ${r(s.queue)} messages waiting (room for ${r(c.capacity)}). Consumers finish ${r(processed)} a second.`);
      if (s.okPerSec > processed * 1.1 && s.queue > 0) out.push(`Messages arrive faster than they're processed (${r(s.okPerSec)} a second in), so the backlog grows by about ${r(s.okPerSec - processed)} a second. More consumers, or faster ones, would stop it growing.`);
      if ((s.oldestAgeMs ?? 0) > 1000) out.push(`The oldest message has waited ${ms(s.oldestAgeMs!)}.`);
      if ((s.deadLetters ?? 0) > 0) out.push(`${s.deadLetters} messages failed ${c.maxRetries} times and were set aside as dead letters.`);
      return out;
    }
    default: {
      const c = cfg<{ workers: number; serviceMs: number; queueLimit: number }>(n);
      const cap = capacityOf(n, s)!;
      const slow = s.slowFactor > 1 ? ` (it's been slowed ${s.slowFactor}x, so each takes about ${ms(c.serviceMs * s.slowFactor)})` : "";
      out.push(`${name} has ${s.workers} worker${s.workers === 1 ? "" : "s"}, each handling one request at a time, ${ms(c.serviceMs)} of work per request${slow}. That's room for about ${r(cap)} requests a second.`);
      out.push(`Right now ${r(incoming)} a second arrive and ${s.busy} of ${s.workers} workers are busy (${pct(s.utilization)} on average).`);
      if (s.utilization > 0.8 && s.workUtilization < s.utilization * 0.6 && targets.length) {
        out.push(`Most of that busy time is spent waiting on ${names(targets)}, not doing its own work. ${name} isn't the problem; it's stuck behind something slower.`);
      } else if (s.queue > 0) {
        const wait = s.okPerSec > 0 ? (1000 * s.queue) / s.okPerSec : 0;
        out.push(`${r(s.queue)} requests are waiting for a free worker, so each one waits roughly ${ms(wait)} before work even starts (queue length divided by throughput).`);
      }
      if (s.errorsPerSec > 0) out.push(`Its waiting line is full${c.queueLimit ? ` (limit ${c.queueLimit})` : ""}, so ${r(s.errorsPerSec)} requests a second are turned away.`);
      if (incoming > cap * 1.02 && s.workUtilization > 0.9) out.push(`More arrives than it can finish, so this will only get worse until load drops or it gets more capacity.`);
      if ((s.lagMs ?? 0) > 50) out.push(`It's ${ms(s.lagMs!)} behind its primary, so reads here can return old data${s.staleRate ? ` (${pct(s.staleRate)} of reads did)` : ""}.`);
      if ((s.lostUpdates ?? 0) > 0) out.push(`Two databases accepted conflicting writes to the same key, and ${s.lostUpdates} updates were overwritten. That data is gone.`);
      if (s.breakerOpen) out.push(`Its circuit breaker is open: calls downstream kept failing, so it's failing fast for a few seconds instead of waiting.`);
      if ((s.booting ?? 0) > 0) out.push(`Autoscaling is starting ${s.booting} more worker${s.booting === 1 ? "" : "s"}; they help only once they've booted.`);
      return out;
    }
  }
}

/** A few sentences about the whole system: where traffic goes and what limits it. */
export function explainSystem(graph: Graph, snap: Snapshot | null): string[] {
  if (!snap) return ["Press Send traffic, then ask again: there's nothing running to explain yet."];
  const out: string[] = [];
  const nodes = Object.values(snap.nodes);
  const clients = nodes.filter((s) => s.kind === "client");
  const sending = clients.reduce((a, c) => a + (c.sendingRps ?? 0), 0);
  const ok = clients.reduce((a, c) => a + c.okPerSec, 0);
  const err = clients.reduce((a, c) => a + c.errorsPerSec, 0);
  const p99 = Math.max(0, ...clients.map((c) => c.p99));
  if (snap.scenario) out.push(`An event is running: ${snap.scenario.name}, with about ${Math.ceil(snap.scenario.remainingMs / 1000)} seconds to go.`);
  out.push(`Users are sending ${r(sending)} requests a second. ${err + ok === 0 ? "None have finished yet." : err / (ok + err) < 0.001 ? `Practically all succeed, and the slowest 1% take ${ms(p99)}.` : `${pct(err / (ok + err))} fail, and the slowest 1% take ${ms(p99)}.`}`);

  // The bottleneck: the busiest pool doing its own work.
  const pools = graph.nodes.filter((n) => ["server", "database", "replica"].includes(n.kind));
  const hot = pools
    .map((n) => ({ n, s: snap.nodes[n.id] }))
    .filter((x) => x.s && !x.s.down)
    .sort((a, b) => b.s.workUtilization - a.s.workUtilization)[0];
  if (hot && hot.s.workUtilization > 0.6) {
    const cap = capacityOf(hot.n, hot.s)!;
    out.push(
      `The busiest part is ${hot.n.label}, at ${pct(hot.s.workUtilization)} of its capacity of about ${r(cap)} requests a second. ${
        hot.s.workUtilization > 0.9 ? "It's the bottleneck: it runs out first, and everything in front of it waits." : "It has some room left, but it's the first thing that will run out if traffic grows."
      }`,
    );
  } else if (sending > 0) {
    out.push("Nothing is close to its limit: every component has plenty of room.");
  }
  const down = graph.nodes.filter((n) => snap.nodes[n.id]?.down);
  if (down.length) out.push(`${down.map((d) => d.label).join(", ")} ${down.length > 1 ? "are" : "is"} down.`);
  if (snap.cutEdges.length) out.push(`${snap.cutEdges.length} network link${snap.cutEdges.length > 1 ? "s are" : " is"} cut, so anything sent across ${snap.cutEdges.length > 1 ? "them" : "it"} is lost.`);
  const caches = graph.nodes.filter((n) => n.kind === "cache" && snap.nodes[n.id]);
  for (const c of caches) {
    const s = snap.nodes[c.id];
    if (s.okPerSec > 0) out.push(`${c.label} answers ${pct(s.hitRatio ?? 0)} of lookups, which keeps that share of reads away from the database.`);
  }
  return out;
}
