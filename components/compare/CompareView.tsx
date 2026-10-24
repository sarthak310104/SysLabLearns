"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant } from "@xyflow/react";
import { LineChart } from "@/components/explore/Charts";
import { edgeTypes, nodeTypes, toFlow } from "@/components/lab/Lab";
import { FlightNsContext, SnapshotContext } from "@/components/lab/LabContext";
import { EventsMenu } from "@/components/lab/EventsMenu";
import type { Graph, Snapshot } from "@/engine/model/types";
import { findings, verdictOf, HEALTH_COLOR } from "@/lib/health";
import { fmtDollars, monthlyCost } from "@/lib/cost";
import { listDesigns, loadDesign } from "@/lib/progress";
import { scenariosFor, type Scenario } from "@/lib/scenarios";
import { useSimulation } from "@/lib/useSimulation";

interface Choice {
  id: string;
  name: string;
  graph: Graph;
}

interface Point {
  t: number;
  ok: number;
  errPct: number;
  p99: number;
  sending: number;
}

/** Totals across every client in a snapshot. */
function clientTotals(s: Snapshot) {
  const cs = Object.values(s.nodes).filter((n) => n.kind === "client");
  const ok = cs.reduce((a, c) => a + c.okPerSec, 0);
  const err = cs.reduce((a, c) => a + c.errorsPerSec, 0);
  return {
    ok,
    errPct: ok + err ? (100 * err) / (ok + err) : 0,
    p99: Math.max(0, ...cs.map((c) => c.p99)),
    sending: cs.reduce((a, c) => a + (c.sendingRps ?? 0), 0),
  };
}

const LIMIT_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const limitScenario: Scenario = {
  id: "find-limit",
  name: "Finding the limit",
  blurb: "",
  steps: LIMIT_STEPS.map((f, i) => ({ afterMs: i * 8000, action: { type: "load" as const, factor: f } })).concat([{ afterMs: LIMIT_STEPS.length * 8000, action: { type: "load", factor: 1 } }]),
  restore: [{ type: "load", factor: 1 }],
};

/** One design's canvas, read-only, animated by its own simulation. */
function Canvas({ graph, snapshot, ns }: { graph: Graph; snapshot: Snapshot | null; ns: string }) {
  const flow = useMemo(() => toFlow(graph), [graph]);
  return (
    <SnapshotContext.Provider value={snapshot}>
      <FlightNsContext.Provider value={ns}>
        <ReactFlowProvider>
          <div className="relative h-[300px] lg:h-[340px] rounded-md border border-line bg-bg overflow-hidden">
            <div className="absolute inset-0">
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.15, maxZoom: 0.9 }}
                minZoom={0.2}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--grid)" />
              </ReactFlow>
            </div>
          </div>
        </ReactFlowProvider>
      </FlightNsContext.Provider>
    </SnapshotContext.Provider>
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function Run({ a, b }: { a: Choice; b: Choice }) {
  const simA = useSimulation(a.graph, 42, "a:");
  const simB = useSimulation(b.graph, 42, "b:");
  const [series, setSeries] = useState<{ a: Point[]; b: Point[] }>({ a: [], b: [] });
  const [limits, setLimits] = useState<{ a?: number | null; b?: number | null }>({});
  const [findingLimit, setFindingLimit] = useState(false);
  const strikes = useRef({ a: 0, b: 0 });
  const sawRamp = useRef(false);
  const restoreRef = useRef<Scenario["restore"]>([]);

  // Record each design's totals as snapshots arrive.
  useEffect(() => {
    if (!simA.snapshot) return;
    const s = simA.snapshot;
    setSeries((prev) => ({ ...prev, a: [...prev.a, { t: s.time, ...clientTotals(s) }].slice(-900) }));
  }, [simA.snapshot]);
  useEffect(() => {
    if (!simB.snapshot) return;
    const s = simB.snapshot;
    setSeries((prev) => ({ ...prev, b: [...prev.b, { t: s.time, ...clientTotals(s) }].slice(-900) }));
  }, [simB.snapshot]);

  // While finding the limit, note the traffic at which each design starts failing.
  useEffect(() => {
    if (!findingLimit) return;
    for (const key of ["a", "b"] as const) {
      const snap = key === "a" ? simA.snapshot : simB.snapshot;
      if (!snap || limits[key] !== undefined) continue;
      const t = clientTotals(snap);
      const bad = t.errPct > 1 || t.p99 > 1000;
      strikes.current[key] = bad ? strikes.current[key] + 1 : 0;
      if (strikes.current[key] >= 5) setLimits((l) => ({ ...l, [key]: Math.round(t.sending) }));
    }
    if (simA.snapshot?.scenario?.name === limitScenario.name) sawRamp.current = true;
    const done = sawRamp.current && !simA.snapshot?.scenario;
    if (done) {
      setFindingLimit(false);
      setLimits((l) => ({ a: l.a ?? null, b: l.b ?? null }));
    }
  }, [simA.snapshot, simB.snapshot, findingLimit, limits]);

  const sims = [simA, simB];
  const playing = simA.playing || simB.playing;
  const play = () => sims.forEach((s) => s.play());
  const pause = () => sims.forEach((s) => s.pause());
  const restart = () => {
    sims.forEach((s) => s.reset());
    setSeries({ a: [], b: [] });
    setLimits({});
    setFindingLimit(false);
  };
  const speed = (v: number) => sims.forEach((s) => s.setSpeed(v));

  // Run an event on both designs (where it applies).
  const scenariosA = useMemo(() => scenariosFor(a.graph), [a.graph]);
  const scenariosB = useMemo(() => scenariosFor(b.graph), [b.graph]);
  const merged: Scenario[] = scenariosA.map((sa) => {
    const sb = scenariosB.find((x) => x.id === sa.id)!;
    return { ...sa, unavailable: sa.unavailable && sb.unavailable ? sa.unavailable.replace("first.", "to either design first.") : undefined };
  });
  const runEvent = (id: string) => {
    for (const a2 of restoreRef.current) sims.forEach((s) => s.fault(a2));
    const pairs = [
      [simA, scenariosA.find((x) => x.id === id)!],
      [simB, scenariosB.find((x) => x.id === id)!],
    ] as const;
    restoreRef.current = [];
    for (const [sim, sc] of pairs) {
      if (sc.unavailable) continue;
      sim.fault({ type: "scenario", name: sc.name, steps: sc.steps });
    }
    restoreRef.current = [...pairs[0][1].restore, ...pairs[1][1].restore];
  };
  const findLimit = () => {
    setLimits({});
    strikes.current = { a: 0, b: 0 };
    sawRamp.current = false;
    setFindingLimit(true);
    sims.forEach((s) => {
      if (!s.playing) s.play();
      s.fault({ type: "scenario", name: limitScenario.name, steps: limitScenario.steps });
    });
  };

  const costA = monthlyCost(a.graph, simA.snapshot).total;
  const costB = monthlyCost(b.graph, simB.snapshot).total;

  const recent = (pts: Point[]) => pts.filter((p) => p.t >= (pts[pts.length - 1]?.t ?? 0) - 10000);
  const stat = (pts: Point[]) => {
    const r = recent(pts);
    return { ok: avg(r.map((p) => p.ok)), errPct: avg(r.map((p) => p.errPct)), p99: Math.max(0, ...r.map((p) => p.p99)) };
  };
  const sa = stat(series.a);
  const sb = stat(series.b);

  const verdict = (snap: Snapshot | null, g: Graph) => {
    if (!snap) return "idle" as const;
    const labels = Object.fromEntries(g.nodes.map((n) => [n.id, n.label]));
    const kinds = Object.fromEntries(g.nodes.map((n) => [n.id, n.kind]));
    return verdictOf(snap.nodes, findings(snap.nodes, labels, kinds, snap.cutEdges.length));
  };
  const VERDICT_LABEL = { idle: "Not running", healthy: "Healthy", improve: "Could be better", failing: "Failing" } as const;
  const VERDICT_COLOR = { idle: "var(--line)", healthy: HEALTH_COLOR.good, improve: HEALTH_COLOR.strained, failing: HEALTH_COLOR.failing } as const;

  const step = (pts: Point[]) => pts.filter((_, i) => i % 5 === 0 || i === pts.length - 1);

  const summary = (() => {
    if (series.a.length < 30 || series.b.length < 30) return null;
    const parts: string[] = [];
    const better = (x: number, y: number, lowerIsBetter: boolean) => (lowerIsBetter ? x < y : x > y);
    if (Math.abs(sa.errPct - sb.errPct) >= 0.5) parts.push(`${better(sa.errPct, sb.errPct, true) ? a.name : b.name} fails fewer requests (${Math.min(sa.errPct, sb.errPct).toFixed(1)}% vs ${Math.max(sa.errPct, sb.errPct).toFixed(1)}%)`);
    if (Math.abs(sa.p99 - sb.p99) >= 10) parts.push(`${better(sa.p99, sb.p99, true) ? a.name : b.name} is faster for the slowest 1% (${Math.round(Math.min(sa.p99, sb.p99))} ms vs ${Math.round(Math.max(sa.p99, sb.p99))} ms)`);
    if (Math.abs(costA - costB) >= 1) parts.push(`${costA < costB ? a.name : b.name} costs ${fmtDollars(Math.abs(costA - costB))} a month less`);
    if (limits.a && limits.b && limits.a !== limits.b) {
      const hi = Math.max(limits.a, limits.b);
      const lo = Math.min(limits.a, limits.b);
      parts.push(`${limits.a > limits.b ? a.name : b.name} holds up to ${(hi / lo).toFixed(1)}x more traffic before failing`);
    }
    return parts.length ? parts.join(". ") + "." : "Over the last 10 seconds the two designs perform about the same.";
  })();

  const col = (key: "a" | "b", c: Choice, sim: typeof simA, st: ReturnType<typeof stat>, cost: number) => {
    const v = verdict(sim.snapshot, c.graph);
    const lim = limits[key];
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="h-3 w-3 rounded-sm" style={{ background: key === "a" ? "var(--series-1)" : "var(--series-2)" }} aria-hidden="true" />
          <h2 className="font-semibold truncate">{c.name}</h2>
          <span className="ml-auto flex items-center gap-1.5 text-[12px]">
            <span className="h-2 w-2 rounded-full" style={{ background: VERDICT_COLOR[v] }} />
            {VERDICT_LABEL[v]}
          </span>
        </div>
        <Canvas graph={c.graph} snapshot={sim.snapshot} ns={`${key}:`} />
        <dl className="grid grid-cols-4 gap-2 mt-3 text-[12px]">
          <div>
            <dt className="text-muted">Answered</dt>
            <dd className="num text-[15px]">{Math.round(st.ok)}/s</dd>
          </div>
          <div>
            <dt className="text-muted">Failing</dt>
            <dd className="num text-[15px]" style={{ color: st.errPct > 1 ? "var(--h-failing)" : undefined }}>
              {st.errPct.toFixed(1)}%
            </dd>
          </div>
          <div>
            <dt className="text-muted">Slowest 1%</dt>
            <dd className="num text-[15px]">{Math.round(st.p99)} ms</dd>
          </div>
          <div>
            <dt className="text-muted">Monthly cost</dt>
            <dd className="num text-[15px]">{fmtDollars(cost)}</dd>
          </div>
        </dl>
        {lim !== undefined && (
          <p className="mt-2 text-[13px]">
            {lim === null ? <span style={{ color: "var(--h-good)" }}>Never broke, even at 8x traffic.</span> : <span>Starts failing at about <span className="num">{lim}</span> req/s.</span>}
          </p>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4 text-[13px]">
        <button onClick={playing ? pause : play} className={`px-3.5 py-1.5 rounded-md font-medium min-w-[92px] ${playing ? "bg-panel-2" : "bg-accent text-accent-ink neon"}`}>
          {playing ? "Pause" : "Send traffic"}
        </button>
        <div className="flex rounded-md border border-line overflow-hidden" role="group" aria-label="Speed">
          {[1, 2, 5].map((v) => (
            <button key={v} onClick={() => speed(v)} aria-pressed={simA.speed === v} className={`px-2.5 py-1.5 num ${simA.speed === v ? "bg-panel-2" : "text-muted hover:text-text"}`}>
              {v}x
            </button>
          ))}
        </div>
        <button onClick={restart} className="px-2.5 py-1.5 rounded-md text-muted hover:text-text">
          Restart both
        </button>
        <EventsMenu scenarios={merged} onRun={(sc) => runEvent(sc.id)} disabled={!playing} />
        <button onClick={findLimit} disabled={findingLimit} className="px-2.5 py-1.5 rounded-md border border-line hover:border-accent disabled:opacity-50">
          {findingLimit ? `Finding the limit (${simA.snapshot?.loadFactor ?? 1}x)...` : "Find the limit"}
        </button>
        <span className="text-muted text-[12px]">Same traffic, same random seed: any difference comes from the design.</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {col("a", a, simA, sa, costA)}
        {col("b", b, simB, sb, costB)}
      </div>

      {summary && (
        <p className="mt-6 rounded-lg border border-line bg-panel px-4 py-3">
          <span className="font-medium">In short: </span>
          {summary}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3 mt-6">
        {(
          [
            ["Answered per second", (p: Point) => p.ok, (v: number) => String(Math.round(v))],
            ["Failing (%)", (p: Point) => p.errPct, (v: number) => v.toFixed(1)],
            ["Slowest 1% (ms)", (p: Point) => p.p99, (v: number) => String(Math.round(v))],
          ] as const
        ).map(([title, pick, fmt]) => {
          const s = [
            { name: a.name, color: 1 as const, points: step(series.a).map((p) => [p.t / 1000, pick(p)] as [number, number]) },
            { name: b.name, color: 2 as const, points: step(series.b).map((p) => [p.t / 1000, pick(p)] as [number, number]), dashed: true },
          ];
          return (
            <section key={title} className="rounded-lg border border-line bg-panel p-3">
              <h3 className="text-[13px] font-medium mb-1">{title}</h3>
              {s[0].points.length > 1 && s[1].points.length > 1 ? (
                <LineChart series={s} xLabel="Seconds" yLabel={title} yFormat={fmt} height={180} ariaLabel={`${title} for both designs over time`} />
              ) : (
                <p className="text-[12px] text-muted py-10 text-center">Press Send traffic to start.</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Pick two designs (the live sandbox or saved versions) and run them side by side. */
export function CompareView() {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [pick, setPick] = useState<{ a: string; b: string }>({ a: "", b: "" });

  useEffect(() => {
    Promise.all([loadDesign("sandbox"), listDesigns()]).then(([live, versions]) => {
      const list: Choice[] = [...(live ? [{ id: "sandbox", name: "Sandbox (now)", graph: live }] : []), ...versions.map((v) => ({ id: v.id, name: v.name, graph: v.graph }))];
      setChoices(list);
      setPick({ a: list[1]?.id ?? list[0]?.id ?? "", b: list[0]?.id ?? "" });
    });
  }, []);

  if (!choices) return <p className="text-muted">Loading your designs...</p>;
  if (choices.length < 2) {
    return (
      <div className="rounded-lg border border-line bg-panel px-5 py-6 max-w-xl">
        <p className="font-medium">You need two designs to compare.</p>
        <p className="text-muted mt-1">
          In the sandbox, open <span className="text-text">Versions</span> and save your design. Change something (add a cache, more servers), and the live sandbox becomes the second design. Or save several versions and pick any two here.
        </p>
        <Link href="/sandbox/" className="inline-block mt-4 px-4 py-2 rounded-md bg-accent text-accent-ink font-medium">
          Go to the sandbox
        </Link>
      </div>
    );
  }
  const a = choices.find((c) => c.id === pick.a) ?? choices[0];
  const b = choices.find((c) => c.id === pick.b) ?? choices[1];
  const select = (key: "a" | "b") => (
    <select value={key === "a" ? a.id : b.id} onChange={(e) => setPick((p) => ({ ...p, [key]: e.target.value }))} className="rounded-md border border-line bg-panel px-2 py-1.5 min-w-0 max-w-[260px]" aria-label={key === "a" ? "First design" : "Second design"}>
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-5 text-[14px]">
        {select("a")}
        <span className="text-muted">versus</span>
        {select("b")}
      </div>
      {a.id === b.id ? <p className="text-muted">Pick two different designs.</p> : <Run key={`${a.id}|${b.id}`} a={a} b={b} />}
    </>
  );
}
