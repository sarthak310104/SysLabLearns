import type { FaultAction, Graph, GraphNode } from "@/engine/model/types";
import { REGION_LABEL } from "@/engine/model/defaults";

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  /** Why it can't run on this design, if it can't. */
  unavailable?: string;
  /** The timed events. */
  steps: { afterMs: number; action: FaultAction }[];
  /** Puts everything back if you stop it early. */
  restore: FaultAction[];
}

const s = (afterMs: number, action: FaultAction) => ({ afterMs, action });
const ofKind = (g: Graph, ...kinds: GraphNode["kind"][]) => g.nodes.filter((n) => kinds.includes(n.kind));

/** Events you can throw at a design, built for the components it actually has. */
export function scenariosFor(g: Graph): Scenario[] {
  const dbs = ofKind(g, "database", "replica");
  const servers = ofKind(g, "server");
  const caches = ofKind(g, "cache");
  const regions = [...new Set(g.nodes.filter((n) => n.kind !== "client").map((n) => n.region ?? "mumbai"))];
  // Take out the region with the most components, if the design spans more than one.
  const counts = regions.map((r) => [r, g.nodes.filter((n) => n.kind !== "client" && (n.region ?? "mumbai") === r).length] as const).sort((a, b) => b[1] - a[1]);
  const outRegion = counts[0]?.[0];
  const regionNodes = g.nodes.filter((n) => n.kind !== "client" && (n.region ?? "mumbai") === outRegion);
  const victim = servers[0];

  return [
    {
      id: "spike",
      name: "Traffic spike",
      blurb: "5x the traffic for 20 seconds, like a post going viral.",
      steps: [s(0, { type: "load", factor: 5 }), s(20000, { type: "load", factor: 1 })],
      restore: [{ type: "load", factor: 1 }],
    },
    {
      id: "black-friday",
      name: "Black Friday",
      blurb: "Traffic climbs to 4x over 30 seconds, stays there for 40, then eases off.",
      steps: [
        s(0, { type: "load", factor: 1.5 }),
        s(10000, { type: "load", factor: 2 }),
        s(20000, { type: "load", factor: 3 }),
        s(30000, { type: "load", factor: 4 }),
        s(70000, { type: "load", factor: 2 }),
        s(80000, { type: "load", factor: 1 }),
      ],
      restore: [{ type: "load", factor: 1 }],
    },
    {
      id: "db-slow",
      name: "Database slows down",
      blurb: "Every database and replica works 4x slower for 30 seconds, like a bad query plan.",
      unavailable: dbs.length ? undefined : "Add a database first.",
      steps: [...dbs.map((d) => s(0, { type: "slow", nodeId: d.id, factor: 4 })), ...dbs.map((d) => s(30000, { type: "slow", nodeId: d.id, factor: 1 }))],
      restore: dbs.map((d) => ({ type: "slow", nodeId: d.id, factor: 1 })),
    },
    {
      id: "server-crash",
      name: "A server crashes",
      blurb: victim ? `${victim.label} goes down for 30 seconds, then comes back.` : "One server goes down for 30 seconds.",
      unavailable: victim ? undefined : "Add a server first.",
      steps: victim ? [s(0, { type: "crash", nodeId: victim.id }), s(30000, { type: "recover", nodeId: victim.id })] : [],
      restore: victim ? [{ type: "recover", nodeId: victim.id }] : [],
    },
    {
      id: "cache-wipe",
      name: "Cache wiped",
      blurb: "Every cache restarts empty, so the database takes all the reads until it warms up.",
      unavailable: caches.length ? undefined : "Add a cache first.",
      steps: [...caches.map((c) => s(0, { type: "crash", nodeId: c.id })), ...caches.map((c) => s(500, { type: "recover", nodeId: c.id }))],
      restore: caches.map((c) => ({ type: "recover", nodeId: c.id })),
    },
    {
      id: "region-outage",
      name: "Region outage",
      blurb: outRegion && regions.length > 1 ? `Everything in ${REGION_LABEL[outRegion as keyof typeof REGION_LABEL] ?? outRegion} goes dark for 40 seconds.` : "A whole region goes dark for 40 seconds.",
      unavailable: regions.length > 1 ? undefined : "Put components in at least two regions first (select one, then choose its Region).",
      steps: [...regionNodes.map((n) => s(0, { type: "crash", nodeId: n.id })), ...regionNodes.map((n) => s(40000, { type: "recover", nodeId: n.id }))],
      restore: regionNodes.map((n) => ({ type: "recover", nodeId: n.id })),
    },
  ];
}
