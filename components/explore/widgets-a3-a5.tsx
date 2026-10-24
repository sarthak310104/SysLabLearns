"use client";

import { useMemo, useState } from "react";
import { keysMoved, ring, ttlHitRatio, zipfHitRatio } from "@/lib/models";
import { BarChart, LineChart } from "./Charts";
import { ControlRow, Explorable, Readout, Segmented, Slider } from "./Explorable";

const pct = (v: number) => `${Math.round(v)}%`;

/* ------------------------------------------------------------------ */
/* A3                                                                  */
/* ------------------------------------------------------------------ */

/** Hit ratio against cache size, for skewed and flat traffic. */
export function HitRatioCurve() {
  const [skew, setSkew] = useState(1);
  const [size, setSize] = useState(2);
  const keys = 20000;
  const sizes = useMemo(() => Array.from({ length: 41 }, (_, i) => i * 0.5), []);
  const series = useMemo(() => {
    const line = (s: number, name: string, color: 1 | 2) => ({
      name,
      color,
      points: sizes.map((x) => [x, zipfHitRatio(Math.max(1, Math.round((x / 100) * keys)), keys, s) * 100] as [number, number]),
    });
    return [line(skew, "Your traffic", 1), line(0.2, "Almost even traffic", 2)];
  }, [skew, sizes]);
  const hit = zipfHitRatio(Math.max(1, Math.round((size / 100) * keys)), keys, skew);
  return (
    <Explorable
      title="How much of your data does a cache need to hold?"
      caption="With skewed traffic, caching a tiny slice of the data answers most requests. With even traffic, a cache needs to hold nearly everything to help."
    >
      <ControlRow>
        <Slider label="How skewed traffic is" value={skew} min={0.4} max={1.4} step={0.05} onChange={setSkew} format={(v) => v.toFixed(2)} />
        <Slider label="Cache size, share of all items" value={size} min={0.5} max={20} step={0.5} onChange={setSize} format={(v) => `${v}%`} />
      </ControlRow>
      <LineChart
        series={series}
        xLabel="Cache size (% of items)"
        yLabel="Hit ratio"
        yMax={100}
        yFormat={pct}
        xFormat={(v) => `${v}`}
        marker={{ x: size, label: `${pct(hit * 100)} hits` }}
        ariaLabel="Cache hit ratio rising with cache size, much faster for skewed traffic"
      />
    </Explorable>
  );
}

/** The TTL trade-off for one key. */
export function TtlTradeoff() {
  const [reads, setReads] = useState(2);
  const [ttl, setTtl] = useState(30);
  const points = useMemo(() => Array.from({ length: 61 }, (_, i) => [i * 2, ttlHitRatio(reads, i * 2) * 100] as [number, number]), [reads]);
  return (
    <Explorable
      title="Time to live: hits against freshness, for one key"
      caption="Past a point, a longer TTL barely improves hits but keeps making data staler. Busy keys reach that point sooner."
    >
      <ControlRow>
        <Slider label="Reads of this key per second" value={reads} min={0.05} max={10} step={0.05} onChange={setReads} format={(v) => v.toFixed(2)} />
        <Slider label="Time to live" value={ttl} min={1} max={120} step={1} onChange={setTtl} format={(v) => `${v} s`} />
      </ControlRow>
      <LineChart
        series={[{ name: "Hit ratio", color: 1, points }]}
        xLabel="Time to live (s)"
        yLabel="Hit ratio"
        yMax={100}
        yFormat={pct}
        marker={{ x: ttl, label: `${ttl} s` }}
        ariaLabel="Hit ratio rising with TTL and levelling off"
      />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Readout label="Hit ratio for this key" value={pct(ttlHitRatio(reads, ttl) * 100)} />
        <Readout label="Readers can see data this old" value={`${ttl} s`} tone={ttl > 60 ? "warn" : undefined} />
      </div>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A4                                                                  */
/* ------------------------------------------------------------------ */

/** A timeline: a write lands on the primary, then on the replica after the lag. Where does your read fall? */
export function StaleReadTimeline() {
  const [lag, setLag] = useState(300);
  const [readAt, setReadAt] = useState(150);
  const span = 1000;
  const W = 560;
  const x = (t: number) => 60 + (t / span) * (W - 80);
  const stale = readAt < lag;
  return (
    <Explorable
      title="Why a refresh can show old data"
      caption="Until the replica applies the write, it still holds the old value. Any read that lands on it in that window is stale, even though the write succeeded."
    >
      <ControlRow>
        <Slider label="Replication lag" value={lag} min={0} max={900} step={10} onChange={setLag} format={(v) => `${v} ms`} />
        <Slider label="You refresh after" value={readAt} min={0} max={900} step={10} onChange={setReadAt} format={(v) => `${v} ms`} />
      </ControlRow>
      <svg viewBox={`0 0 ${W} 150`} className="w-full" role="img" aria-label={`A write reaches the replica after ${lag} ms; a read at ${readAt} ms is ${stale ? "stale" : "fresh"}`}>
        {[
          { y: 40, label: "Primary" },
          { y: 105, label: "Replica" },
        ].map((lane) => (
          <g key={lane.label}>
            <text x="0" y={lane.y + 4} fontSize="12" fill="var(--muted)">
              {lane.label}
            </text>
            <line x1="60" x2={W - 20} y1={lane.y} y2={lane.y} stroke="var(--line)" strokeWidth="2" />
          </g>
        ))}
        <circle cx={x(0)} cy="40" r="7" fill="var(--series-1)" />
        <text x={x(0) + 10} y="24" fontSize="11" fill="var(--text)">
          Write committed
        </text>
        <line x1={x(0)} y1="40" x2={x(lag)} y2="105" stroke="var(--series-1)" strokeWidth="1.5" strokeDasharray="4 3" />
        <circle cx={x(lag)} cy="105" r="7" fill="var(--series-1)" />
        <text x={x(lag) + 10} y="132" fontSize="11" fill="var(--text)">
          Applied on replica
        </text>
        <rect x={x(0)} y="96" width={Math.max(0, x(lag) - x(0))} height="18" fill="var(--warn)" opacity="0.18" />
        <line x1={x(readAt)} x2={x(readAt)} y1="80" y2="125" stroke={stale ? "var(--crit)" : "var(--series-2)"} strokeWidth="2.5" />
        <text x={x(readAt)} y="76" textAnchor="middle" fontSize="11" fill={stale ? "var(--crit)" : "var(--series-2)"}>
          {stale ? "Your read: old value" : "Your read: new value"}
        </text>
      </svg>
    </Explorable>
  );
}

/** Lag over time when writes arrive faster or slower than a replica can apply them. */
export function LagGrowth() {
  const [writes, setWrites] = useState(150);
  const [apply, setApply] = useState(200);
  const points = useMemo(
    () =>
      Array.from({ length: 31 }, (_, s) => {
        const backlog = Math.max(0, (writes - apply) * s);
        return [s, (backlog / apply) * 1000] as [number, number];
      }),
    [writes, apply],
  );
  const growing = writes > apply;
  return (
    <Explorable
      title="When does a replica start falling behind?"
      caption="Below its apply rate, a replica stays a few milliseconds behind. Above it, lag grows every second and never recovers on its own."
    >
      <ControlRow>
        <Slider label="Writes per second" value={writes} min={10} max={400} step={10} onChange={setWrites} />
        <Slider label="Writes the replica can apply per second" value={apply} min={50} max={400} step={10} onChange={setApply} />
      </ControlRow>
      <LineChart
        series={[{ name: "Lag", color: 1, points }]}
        xLabel="Seconds"
        yLabel="Lag"
        yMax={Math.max(1000, points[points.length - 1][1])}
        yFormat={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)}
        ariaLabel={growing ? "Lag growing steadily over 30 seconds" : "Lag staying near zero"}
      />
      <p className="text-[13px] mt-2" style={{ color: growing ? "var(--crit)" : "var(--text)" }}>
        {growing ? `Falling behind by ${(((writes - apply) / apply) * 1000).toFixed(0)} ms every second.` : "Keeping up."}
      </p>
    </Explorable>
  );
}

/* ------------------------------------------------------------------ */
/* A5                                                                  */
/* ------------------------------------------------------------------ */

/** Mod N against a consistent-hash ring: how many keys move when you add a shard. */
export function HashRingExplorer() {
  const [shards, setShards] = useState(4);
  const [scheme, setScheme] = useState<"mod" | "ring">("mod");
  const moved = useMemo(() => keysMoved(shards, scheme), [shards, scheme]);
  const r = useMemo(() => ring(shards + 1, 12), [shards]);
  const C = 90;
  const arcs = r.points.map((p, i) => {
    const next = r.points[(i + 1) % r.points.length];
    const a0 = (p.at / 2 ** 32) * Math.PI * 2;
    let a1 = (next.at / 2 ** 32) * Math.PI * 2;
    if (a1 <= a0) a1 += Math.PI * 2;
    return { a0, a1, owner: next.shard };
  });
  const arcPath = (a0: number, a1: number) => {
    const p = (a: number) => `${100 + C * Math.sin(a)},${100 - C * Math.cos(a)}`;
    return `M${p(a0)} A${C},${C} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
  };
  return (
    <Explorable
      title={`Adding shard ${shards + 1}: how many keys have to move?`}
      caption="Every moved key is data copied across the network while the system is live. Consistent hashing places each shard at many points on a ring, so a new shard only takes small slices from its neighbours."
    >
      <ControlRow>
        <Slider label="Shards today" value={shards} min={2} max={12} step={1} onChange={setShards} />
        <Segmented
          label="Routing"
          value={scheme}
          options={[
            { value: "mod", label: "Hash mod N" },
            { value: "ring", label: "Consistent hashing" },
          ]}
          onChange={setScheme}
        />
      </ControlRow>
      <div className="flex flex-col sm:flex-row items-center gap-5">
        <svg viewBox="0 0 200 200" className="w-44 shrink-0" role="img" aria-label="Hash ring with the new shard's slices highlighted">
          {arcs.map((a, i) => (
            <path
              key={i}
              d={arcPath(a.a0, a.a1)}
              fill="none"
              strokeWidth="14"
              stroke={a.owner === shards ? "var(--series-1)" : a.owner % 2 ? "var(--series-2)" : "var(--series-4)"}
              opacity={a.owner === shards ? 1 : 0.55}
            />
          ))}
          <text x="100" y="98" textAnchor="middle" fontSize="11" fill="var(--muted)">
            Ring
          </text>
          <text x="100" y="114" textAnchor="middle" fontSize="11" fill="var(--series-1)">
            new shard
          </text>
        </svg>
        <div className="grid grid-cols-2 gap-4 flex-1">
          <Readout label="Keys that move" value={pct(moved * 100)} tone={moved > 0.5 ? "crit" : undefined} />
          <Readout label="Ideal minimum" value={pct(100 / (shards + 1))} />
        </div>
      </div>
    </Explorable>
  );
}

/** Per-shard load with a celebrity key. */
export function HotShardBars() {
  const [shards, setShards] = useState(4);
  const [celebrity, setCelebrity] = useState(30);
  const total = 900;
  const capacity = 320;
  const rest = (total * (1 - celebrity / 100)) / shards;
  const bars = Array.from({ length: shards }, (_, i) => {
    const v = rest + (i === 0 ? (total * celebrity) / 100 : 0);
    return { label: i === 0 ? "Celebrity's shard" : `Shard ${i + 1}`, value: v, over: v > capacity, highlight: i === 0 };
  });
  return (
    <Explorable
      title="900 req/s across shards, with one celebrity key"
      caption="Add shards and every bar shrinks except the celebrity's: its traffic never moves."
    >
      <ControlRow>
        <Slider label="Shards" value={shards} min={2} max={12} step={1} onChange={setShards} />
        <Slider label="Traffic to the celebrity key" value={celebrity} min={0} max={50} step={5} onChange={setCelebrity} format={(v) => `${v}%`} />
      </ControlRow>
      <BarChart bars={bars} max={Math.max(500, ...bars.map((b) => b.value))} format={(v) => `${Math.round(v)}/s`} limit={{ y: capacity, label: "Shard capacity" }} ariaLabel="Requests per second on each shard" />
    </Explorable>
  );
}
