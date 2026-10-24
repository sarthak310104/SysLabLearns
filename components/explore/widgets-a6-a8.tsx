"use client";

import { useEffect, useMemo, useState } from "react";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph } from "@/engine/model/types";
import { partitionConflicts, retryAmplification } from "@/lib/models";
import { BarChart, LineChart } from "./Charts";
import { ControlRow, Explorable, Readout, Segmented, Slider } from "./Explorable";
import { runHeadless } from "./widgets-a1-a2";

/* ------------------------------------------------------------------ */
/* A6                                                                  */
/* ------------------------------------------------------------------ */

/** A queue's backlog under spiky traffic, as a fluid: in minus out, never below zero. */
export function BacklogSim() {
  const [capacity, setCapacity] = useState(150);
  const [spike, setSpike] = useState(4);
  const base = 100;
  const { points, peak } = useMemo(() => {
    const pts: [number, number][] = [];
    let backlog = 0;
    let max = 0;
    for (let i = 0; i <= 400; i++) {
      const t = i / 10;
      const phase = t % 10;
      const arriving = phase >= 6 && phase < 8 ? base * spike : base;
      backlog = Math.max(0, backlog + (arriving - capacity) * 0.1);
      max = Math.max(max, backlog);
      if (i % 2 === 0) pts.push([t, backlog]);
    }
    return { points: pts, peak: max };
  }, [capacity, spike]);
  const average = base * (0.8 + 0.2 * spike);
  const keepsUp = capacity > average;
  return (
    <Explorable
      title="A backlog under spiky traffic"
      caption="Workers only need to keep up with the average, not the peak: the queue holds the difference. Below the average, the backlog ratchets up with every spike."
    >
      <ControlRow>
        <Slider label="Workers can process (msg/s)" value={capacity} min={60} max={500} step={10} onChange={setCapacity} />
        <Slider label="Spike size (x normal traffic)" value={spike} min={1} max={6} step={0.5} onChange={setSpike} format={(v) => `${v}x`} />
      </ControlRow>
      <LineChart
        series={[{ name: "Waiting messages", color: 1, points }]}
        xLabel="Seconds"
        yLabel="Waiting"
        ariaLabel="Backlog of waiting messages over 40 seconds of spiky traffic"
      />
      <div className="grid grid-cols-3 gap-3 mt-3">
        <Readout label="Average arrivals" value={`${Math.round(average)}/s`} />
        <Readout label="Longest wait at the peak" value={`${(peak / capacity).toFixed(1)} s`} tone={peak / capacity > 5 ? "crit" : undefined} />
        <Readout label="Keeps up on average" value={keepsUp ? "Yes" : "No"} tone={keepsUp ? undefined : "crit"} />
      </div>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A7                                                                  */
/* ------------------------------------------------------------------ */

/** Attempts per request as failures rise, with and without a retry budget. */
export function RetryCurves() {
  const [retries, setRetries] = useState(3);
  const [budget, setBudget] = useState(10);
  const xs = Array.from({ length: 41 }, (_, i) => i * 2.5);
  const series = [
    { name: "No budget", color: 1 as const, points: xs.map((p) => [p, retryAmplification(p / 100, retries)] as [number, number]) },
    { name: `${budget}% budget`, color: 2 as const, dashed: true, points: xs.map((p) => [p, retryAmplification(p / 100, retries, budget / 100)] as [number, number]) },
  ];
  return (
    <Explorable
      title="How much load retries add as failures rise"
      caption="At low failure rates, retries cost almost nothing. When everything fails, each request becomes retries + 1 attempts, unless a budget caps it."
    >
      <ControlRow>
        <Segmented
          label="Retries per request"
          value={retries}
          options={[1, 2, 3, 5].map((r) => ({ value: r, label: String(r) }))}
          onChange={setRetries}
        />
        <Slider label="Retry budget" value={budget} min={5} max={50} step={5} onChange={setBudget} format={(v) => `${v}%`} />
      </ControlRow>
      <LineChart
        series={series}
        xLabel="Requests failing (%)"
        yLabel="Load"
        yMax={retries + 1}
        yFormat={(v) => `${v.toFixed(1)}x`}
        ariaLabel="Load amplification rising with failure rate, capped by a retry budget"
      />
    </Explorable>
  );
}

function nodeOf(id: string, kind: ComponentKind, config: Partial<AnyConfig> = {}) {
  return { id, kind, label: id, position: { x: 0, y: 0 }, config: { ...defaultConfig(kind), ...config } as AnyConfig };
}

/** Goodput against offered load, with a long queue and a short one, measured in the engine. */
export function GoodputSweep() {
  const [data, setData] = useState<{ long: [number, number][]; short: [number, number][] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = (rps: number, queueLimit: number) => {
        const g: Graph = {
          nodes: [
            nodeOf("c", "client", { rps, timeoutMs: 1000 }),
            nodeOf("api", "server", { workers: 32, serviceMs: 5, queueLimit }),
            nodeOf("db", "database", { workers: 8, serviceMs: 50 }),
          ],
          edges: [
            { id: "a", source: "c", target: "api" },
            { id: "b", source: "api", target: "db" },
          ],
        };
        return runHeadless(g, 15000, "c").goodput;
    };
    // One run per tick, so the page stays responsive while the sweep runs.
    (async () => {
      const loads = [40, 80, 120, 160, 200, 240, 280, 320];
      const long: [number, number][] = [];
      const short: [number, number][] = [];
      for (const l of loads) {
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        long.push([l, run(l, 200)]);
        short.push([l, run(l, 20)]);
      }
      if (!cancelled) setData({ long, short });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <Explorable
      title="Useful answers per second as load rises, measured in the lab engine"
      caption="The database can do about 160 a second. With a long queue, pushing past that makes useful output collapse. With a short one, it levels off at capacity."
    >
      {!data ? (
        <p className="text-[13px] text-muted">Running 16 simulations...</p>
      ) : (
        <LineChart
          series={[
            { name: "Queue of 200", color: 1, points: data.long },
            { name: "Queue of 20", color: 2, points: data.short },
          ]}
          xLabel="Requests sent per second"
          yLabel="Answered in time"
          refLines={[{ y: 160, label: "DB capacity" }]}
          ariaLabel="Goodput collapsing past capacity with a long queue, flat at capacity with a short queue"
        />
      )}
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A8                                                                  */
/* ------------------------------------------------------------------ */

/** Expected conflicts from a partition of a given length. */
export function ConflictCurve() {
  const [writes, setWrites] = useState(45);
  const [keys, setKeys] = useState(1000);
  const [duration, setDuration] = useState(30);
  const points = useMemo(() => Array.from({ length: 61 }, (_, i) => [i * 5, partitionConflicts(i * 5, writes, keys)] as [number, number]), [writes, keys]);
  return (
    <Explorable
      title="How many writes collide during a partition?"
      caption="Short partitions are cheap. The longer one lasts, the more keys get written on both sides, until nearly every key does."
    >
      <ControlRow>
        <Slider label="Writes per second, each side" value={writes} min={1} max={200} step={1} onChange={setWrites} />
        <Slider label="Distinct keys being written" value={keys} min={100} max={20000} step={100} onChange={setKeys} />
      </ControlRow>
      <ControlRow>
        <Slider label="Partition lasts" value={duration} min={5} max={300} step={5} onChange={setDuration} format={(v) => `${v} s`} />
      </ControlRow>
      <LineChart
        series={[{ name: "Conflicting keys", color: 1, points }]}
        xLabel="Partition length (s)"
        yLabel="Conflicts"
        marker={{ x: duration, label: `${Math.round(partitionConflicts(duration, writes, keys))} conflicts` }}
        ariaLabel="Conflicting keys rising with the length of the partition"
      />
    </Explorable>
  );
}

/** What consistency costs on every write, partition or not. */
export function SyncLatency() {
  const [rtt, setRtt] = useState(80);
  const local = 10;
  return (
    <Explorable
      title="The everyday price of consistency"
      caption="Waiting for another region adds a round trip to every single write, all the time, not only during failures."
    >
      <ControlRow>
        <Slider label="Round trip between regions" value={rtt} min={5} max={300} step={5} onChange={setRtt} format={(v) => `${v} ms`} />
      </ControlRow>
      <BarChart
        bars={[
          { label: "Available", value: local },
          { label: "Consistent", value: local + rtt, highlight: true },
        ]}
        format={(v) => `${Math.round(v)} ms`}
        ariaLabel="Write latency in available and consistent modes"
      />
      <div className="mt-3">
        <Readout label="Every write is slower by" value={`${Math.round(((local + rtt) / local - 1) * 100)}%`} />
      </div>
    </Explorable>
  );
}
