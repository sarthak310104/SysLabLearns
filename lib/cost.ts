import { withDefaults } from "@/engine/model/defaults";
import type { CacheConfig, ComponentKind, Graph, Snapshot } from "@/engine/model/types";

/**
 * A simple monthly price list, in dollars. It's made up, but the ratios are
 * realistic: database capacity costs far more than web servers, and memory
 * for a cache is cheap compared with the database load it saves.
 */
export const PRICES = {
  serverWorker: 20,
  databaseConnection: 80,
  replicaConnection: 50,
  cachePer1000Keys: 5,
  cacheMinimum: 10,
  loadBalancer: 25,
  queue: 15,
};

export interface CostLine {
  id: string;
  label: string;
  kind: ComponentKind;
  monthly: number;
}

/**
 * What the design costs per month right now. Worker counts come from the live
 * simulation when there is one, so autoscaled capacity is billed as it runs.
 */
export function monthlyCost(graph: Graph, snap?: Snapshot | null): { total: number; lines: CostLine[] } {
  const lines: CostLine[] = graph.nodes.map((n) => {
    const cfg = withDefaults(n.kind, n.config) as unknown as Record<string, number>;
    const live = snap?.nodes[n.id];
    const workers = live && !live.down ? live.workers : Math.floor(cfg.workers ?? 0);
    let monthly = 0;
    switch (n.kind) {
      case "server":
        monthly = workers * PRICES.serverWorker;
        break;
      case "database":
        monthly = workers * PRICES.databaseConnection;
        break;
      case "replica":
        monthly = workers * PRICES.replicaConnection;
        break;
      case "cache":
        monthly = Math.max(PRICES.cacheMinimum, ((n.config as CacheConfig).capacity / 1000) * PRICES.cachePer1000Keys);
        break;
      case "loadBalancer":
        monthly = PRICES.loadBalancer;
        break;
      case "queue":
        monthly = PRICES.queue;
        break;
    }
    return { id: n.id, label: n.label, kind: n.kind, monthly: Math.round(monthly) };
  });
  return { total: lines.reduce((a, l) => a + l.monthly, 0), lines };
}

export const fmtDollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
