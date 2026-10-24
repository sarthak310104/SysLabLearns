"use client";

import { useMemo, useState } from "react";
import { REGION_LATENCY, REGION_LABEL } from "@/engine/model/defaults";
import type { Region } from "@/engine/model/types";
import { BarChart, LineChart } from "./Charts";
import { ControlRow, Explorable, Readout, Segmented, Slider } from "./Explorable";

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/* ------------------------------------------------------------------ */
/* A9                                                                  */
/* ------------------------------------------------------------------ */

/** Where a request's time goes: travel versus work, with and without an edge cache. */
export function LatencyBudget() {
  const [from, setFrom] = useState<Region>("mumbai");
  const [hit, setHit] = useState(90);
  const origin: Region = "virginia";
  const work = 25;
  const travel = 2 * REGION_LATENCY[from][origin];
  const fromOrigin = travel + work;
  const fromEdge = 3;
  const average = (hit / 100) * fromEdge + (1 - hit / 100) * (fromEdge + fromOrigin);
  return (
    <Explorable
      title="Where a request's time goes"
      caption="Distance is a cost you pay on every request, and no amount of server tuning removes it. Serving from nearby is the only fix."
    >
      <ControlRow>
        <Segmented
          label="Users are in"
          value={from}
          options={(Object.keys(REGION_LABEL) as Region[]).map((r) => ({ value: r, label: REGION_LABEL[r] }))}
          onChange={setFrom}
        />
        <Slider label="CDN hit ratio" value={hit} min={0} max={99} step={1} onChange={setHit} format={(v) => `${v}%`} />
      </ControlRow>
      <BarChart
        bars={[
          { label: "Travel to Virginia and back", value: travel, highlight: true },
          { label: "Server and database work", value: work },
          { label: "CDN hit nearby", value: fromEdge },
        ]}
        format={ms}
        ariaLabel="Breakdown of request time into travel and work"
      />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Readout label="Every request from the origin" value={ms(fromOrigin)} />
        <Readout label="Average with the CDN" value={ms(average)} />
      </div>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A11                                                                 */
/* ------------------------------------------------------------------ */

/** How a shared limit and per-client limits split capacity between a well-behaved and a noisy client. */
export function FairShare() {
  const [scope, setScope] = useState<"none" | "global" | "perClient">("none");
  const [limit, setLimit] = useState(450);
  const normal = 200;
  const noisy = 600;
  const capacity = 530;
  let allowedNormal = normal;
  let allowedNoisy = noisy;
  if (scope === "global") {
    const share = Math.min(1, limit / (normal + noisy));
    allowedNormal = normal * share;
    allowedNoisy = noisy * share;
  } else if (scope === "perClient") {
    allowedNormal = Math.min(normal, limit);
    allowedNoisy = Math.min(noisy, limit);
  }
  // Whatever gets through and exceeds capacity fails at the servers, shared out proportionally.
  const through = allowedNormal + allowedNoisy;
  const served = Math.min(1, capacity / through);
  const okNormal = allowedNormal * served;
  return (
    <Explorable
      title="Who gets through: no limit, one shared limit, or one per client"
      caption="A shared limit protects the servers but still punishes everyone in proportion to the noise. Per-client limits put the cost on whoever causes it."
    >
      <ControlRow>
        <Segmented
          label="Rate limit"
          value={scope}
          options={[
            { value: "none", label: "None" },
            { value: "global", label: "Shared" },
            { value: "perClient", label: "Per client" },
          ]}
          onChange={setScope}
        />
        <Slider label="Limit (req/s)" value={limit} min={100} max={700} step={10} onChange={setLimit} />
      </ControlRow>
      <BarChart
        bars={[
          { label: "Normal users ask", value: normal },
          { label: "Normal users served", value: okNormal, over: okNormal < normal * 0.99 },
          { label: "Script asks", value: noisy },
          { label: "Script let through", value: allowedNoisy, highlight: true },
        ]}
        max={700}
        format={(v) => `${Math.round(v)}/s`}
        limit={{ y: capacity, label: "Servers can do" }}
        ariaLabel="Requests asked for and served, for normal users and a noisy script"
      />
      <div className="mt-3">
        <Readout label="Normal users' requests that succeed" value={`${Math.round((okNormal / normal) * 100)}%`} tone={okNormal < normal * 0.99 ? "crit" : undefined} />
      </div>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A12                                                                 */
/* ------------------------------------------------------------------ */

/** Demand against capacity for a simple autoscaler, under a ramp or a spike. */
export function AutoscaleLag() {
  const [shape, setShape] = useState<"ramp" | "spike">("ramp");
  const [boot, setBoot] = useState(10);
  const series = useMemo(() => {
    const demand: [number, number][] = [];
    const capacity: [number, number][] = [];
    let cap = 150;
    const pending: { at: number; add: number }[] = [];
    for (let t = 0; t <= 60; t += 0.5) {
      const d = shape === "ramp" ? 100 + Math.min(1, t / 30) * 300 : t % 20 >= 10 && t % 20 < 12 ? 1600 : 400;
      while (pending.length && pending[0].at <= t) cap += pending.shift()!.add;
      if (t % 2 === 0) {
        const booting = pending.reduce((a, p) => a + p.add, 0);
        if (d > 0.7 * cap && cap + booting < 2400) pending.push({ at: t + boot, add: cap * 0.5 });
      }
      demand.push([t, d]);
      capacity.push([t, cap]);
    }
    return [
      { name: "Traffic", color: 1 as const, points: demand },
      { name: "Capacity", color: 2 as const, points: capacity },
    ];
  }, [shape, boot]);
  return (
    <Explorable
      title="Can capacity keep up with demand?"
      caption="An autoscaler reacts to load it has already seen, then waits for new workers to start. A slow ramp gives it time; a spike shorter than the start-up time is over before help arrives."
    >
      <ControlRow>
        <Segmented
          label="Traffic"
          value={shape}
          options={[
            { value: "ramp", label: "Slow ramp" },
            { value: "spike", label: "Sudden spikes" },
          ]}
          onChange={setShape}
        />
        <Slider label="Time for a worker to start" value={boot} min={0} max={60} step={1} onChange={setBoot} format={(v) => `${v} s`} />
      </ControlRow>
      <LineChart series={series} xLabel="Seconds" yLabel="Requests per second" ariaLabel="Traffic and capacity over 60 seconds" />
    </Explorable>
  );
}

