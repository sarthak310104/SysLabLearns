"use client";

import { useEffect, useMemo, useState } from "react";
import { Simulation } from "@/engine/model/simulation";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, LbStrategy } from "@/engine/model/types";
import { queueLatency } from "@/lib/models";
import { BarChart, LineChart, type Series } from "./Charts";
import { ControlRow, Explorable, Readout, Slider } from "./Explorable";

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/* ------------------------------------------------------------------ */
/* A1                                                                  */
/* ------------------------------------------------------------------ */

/** p99 against utilization for 1, 4 and 16 workers: the hockey stick, and why pooling helps. */
export function LatencyCurve() {
  const [serviceMs, setServiceMs] = useState(40);
  const [util, setUtil] = useState(70);
  const series: Series[] = useMemo(() => {
    const line = (workers: number, color: 1 | 2 | 3) => ({
      name: `${workers} worker${workers > 1 ? "s" : ""}`,
      color,
      points: Array.from({ length: 50 }, (_, i) => {
        const u = 0.02 + (i / 49) * 0.96;
        const capacity = (workers * 1000) / serviceMs;
        return [u * 100, queueLatency(u * capacity, workers, serviceMs).p99] as [number, number];
      }),
    });
    return [line(1, 1), line(4, 2), line(16, 3)];
  }, [serviceMs]);
  const yMax = serviceMs * 25;
  return (
    <Explorable
      title="How the slowest 1% grows as a server gets busy"
      caption="The curves stay flat, then shoot up. With more workers sharing one queue, a request rarely finds all of them busy, so the curve bends later."
    >
      <ControlRow>
        <Slider label="Work per request" value={serviceMs} min={10} max={100} step={5} onChange={setServiceMs} format={ms} />
        <Slider label="Busy" value={util} min={10} max={98} step={1} onChange={setUtil} format={(v) => `${v}%`} />
      </ControlRow>
      <LineChart
        series={series}
        xLabel="Busy (%)"
        yLabel="p99 latency"
        xFormat={(v) => `${Math.round(v)}`}
        yFormat={ms}
        yMax={yMax}
        marker={{ x: util, label: `${util}% busy` }}
        ariaLabel="p99 latency rising steeply with utilization, for 1, 4 and 16 workers"
      />
      <div className="grid grid-cols-3 gap-3 mt-3">
        {[1, 4, 16].map((w) => {
          const p = queueLatency((util / 100) * ((w * 1000) / serviceMs), w, serviceMs).p99;
          return <Readout key={w} label={`p99 with ${w} worker${w > 1 ? "s" : ""}`} value={ms(p)} tone={p > serviceMs * 8 ? "crit" : p > serviceMs * 4 ? "warn" : undefined} />;
        })}
      </div>
    </Explorable>
  );
}

/** Little's law: requests in flight = arrival rate x time in the system. */
export function LittlesLaw() {
  const [rps, setRps] = useState(200);
  const [latency, setLatency] = useState(120);
  const inFlight = (rps * latency) / 1000;
  const workers = Math.ceil(inFlight / 0.7);
  return (
    <Explorable
      title="Little's law: how many requests are in flight"
      caption="In flight = arrivals per second x seconds each one stays. It holds for any stable system, which makes it the quickest capacity check there is."
    >
      <ControlRow>
        <Slider label="Requests per second" value={rps} min={10} max={2000} step={10} onChange={setRps} />
        <Slider label="Time each request takes" value={latency} min={5} max={2000} step={5} onChange={setLatency} format={ms} />
      </ControlRow>
      <div className="grid grid-cols-2 gap-3">
        <Readout label="Requests in flight at any moment" value={inFlight.toFixed(inFlight < 10 ? 1 : 0)} />
        <Readout label="Workers needed at 70% busy" value={String(workers)} />
      </div>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A2                                                                  */
/* ------------------------------------------------------------------ */

/** What happens to the survivors when servers die. */
export function CapacityPlanner() {
  const [servers, setServers] = useState(4);
  const [busy, setBusy] = useState(70);
  const bars = [0, 1, 2].map((lost) => {
    const left = servers - lost;
    const u = left > 0 ? (busy * servers) / left : Infinity;
    return { label: lost === 0 ? "All up" : `${lost} down`, value: Math.min(u, 200), over: u > 100 };
  });
  return (
    <Explorable
      title="Planning for a server to fail"
      caption="When a server dies, its traffic lands on the survivors. If they were already busy, the failure of one becomes the overload of all."
    >
      <ControlRow>
        <Slider label="Servers" value={servers} min={2} max={12} step={1} onChange={setServers} />
        <Slider label="How busy each one is normally" value={busy} min={10} max={95} step={5} onChange={setBusy} format={(v) => `${v}%`} />
      </ControlRow>
      <BarChart bars={bars} max={200} format={(v) => (v >= 200 ? "200%+" : `${Math.round(v)}%`)} limit={{ y: 100, label: "Full" }} ariaLabel="How busy each surviving server is after losing servers" />
    </Explorable>
  );
}

/* Headless lab runs, used by diagrams that compare whole setups. */

function nodeOf(id: string, kind: ComponentKind, config: Partial<AnyConfig> = {}) {
  return { id, kind, label: id, position: { x: 0, y: 0 }, config: { ...defaultConfig(kind), ...config } as AnyConfig };
}

export function runHeadless(graph: Graph, ms: number, clientId: string, seed = 4) {
  const sim = new Simulation(graph, seed);
  let ok = 0;
  let err = 0;
  let p99 = 0;
  let n = 0;
  for (let t = 100; t <= ms; t += 100) {
    sim.runUntil(t);
    const s = sim.snapshot();
    if (t > ms / 3) {
      const c = s.nodes[clientId];
      ok += c.okPerSec;
      err += c.errorsPerSec;
      p99 += c.p99;
      n++;
    }
  }
  return { goodput: ok / n, errorRate: ok + err ? err / (ok + err) : 0, p99: p99 / n };
}

/** Runs the real engine to compare balancing strategies on unequal servers. */
export function StrategyRace() {
  const [rps, setRps] = useState(220);
  const [results, setResults] = useState<Record<string, { errorRate: number; p99: number }> | null>(null);
  useEffect(() => {
    setResults(null);
    const t = setTimeout(() => {
      const out: Record<string, { errorRate: number; p99: number }> = {};
      for (const strategy of ["roundRobin", "random", "leastConnections"] as LbStrategy[]) {
        const g: Graph = {
          nodes: [
            nodeOf("c", "client", { rps }),
            nodeOf("lb", "loadBalancer", { strategy }),
            nodeOf("s1", "server", { serviceMs: 40 }),
            nodeOf("s2", "server", { serviceMs: 40 }),
            nodeOf("s3", "server", { serviceMs: 90 }),
          ],
          edges: ["c>lb", "lb>s1", "lb>s2", "lb>s3"].map((x) => {
            const [source, target] = x.split(">");
            return { id: x, source, target };
          }),
        };
        out[strategy] = runHeadless(g, 15000, "c");
      }
      setResults(out);
    }, 30);
    return () => clearTimeout(t);
  }, [rps]);
  const names: Record<string, string> = { roundRobin: "Round robin", random: "Random", leastConnections: "Least connections" };
  return (
    <Explorable
      title="Three strategies, same servers, measured in the lab engine"
      caption="Two servers handle about 100 req/s, the old one about 44. Every result here comes from running the real simulation for 15 seconds."
    >
      <ControlRow>
        <Slider label="Requests per second" value={rps} min={100} max={260} step={10} onChange={setRps} />
      </ControlRow>
      {!results ? (
        <p className="text-[13px] text-muted">Running the simulation...</p>
      ) : (
        <>
          <p className="text-[13px] mb-1">Requests failing</p>
          <BarChart
            bars={Object.entries(results).map(([k, r]) => ({ label: names[k], value: r.errorRate * 100, over: r.errorRate > 0.01 }))}
            max={Math.max(5, ...Object.values(results).map((r) => r.errorRate * 100))}
            format={(v) => `${v.toFixed(1)}%`}
            ariaLabel="Share of requests failing for each strategy"
          />
          <p className="text-[13px] mt-4 mb-1">Slowest 1% of responses</p>
          <BarChart bars={Object.entries(results).map(([k, r]) => ({ label: names[k], value: r.p99 }))} format={ms} ariaLabel="p99 latency for each strategy" />
        </>
      )}
    </Explorable>
  );
}
