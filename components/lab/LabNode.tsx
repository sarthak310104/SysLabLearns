"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { AnyConfig, ComponentKind, NodeStats, Region } from "@/engine/model/types";
import { HEALTH_COLOR, HEALTH_LABEL, nodeHealth } from "@/lib/health";
import { REGION_LABEL } from "@/engine/model/defaults";
import { Glyph } from "./glyphs";
import { fmtMs, fmtPct, fmtRate } from "./format";
import { useSnapshot } from "./LabContext";

export type LabNodeData = { kind: ComponentKind; label: string; config: AnyConfig; region?: Region };
export type LabFlowNode = Node<LabNodeData, "lab">;


function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "crit" }) {
  const color = tone === "crit" ? "var(--h-failing)" : tone === "warn" ? "var(--h-strained)" : "var(--text)";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="num" style={{ color }}>{value}</span>
    </div>
  );
}

function Bar({ value, tone }: { value: number; tone: "signal" | "warn" | "crit" }) {
  return (
    <div className="h-1 rounded-full bg-panel-2 overflow-hidden" aria-hidden="true">
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
          background: tone === "crit" ? "var(--h-failing)" : tone === "warn" ? "var(--h-strained)" : value >= 0.5 ? "var(--h-good)" : "var(--h-ideal)",
        }}
      />
    </div>
  );
}

function Body({ s, kind }: { s: NodeStats | undefined; kind: ComponentKind }) {
  if (!s) return <div className="text-muted">Not running yet</div>;
  if (s.down) return <div className="font-medium" style={{ color: "var(--h-failing)" }}>Down: refusing requests</div>;
  const errTone = s.errorRate > 0.05 ? "crit" : s.errorRate > 0.005 ? "warn" : undefined;

  if (kind === "client") {
    const success = 1 - s.errorRate;
    const sending = s.sendingRps ?? 0;
    const amplification = sending > 0 && s.attemptsPerSec ? s.attemptsPerSec / sending : 1;
    return (
      <>
        <Metric label="Sending" value={fmtRate(sending)} />
        {amplification > 1.15 && <Metric label="With retries" value={fmtRate(s.attemptsPerSec ?? 0)} tone={amplification > 1.5 ? "crit" : "warn"} />}
        <Metric label="Succeeding" value={fmtPct(s.okPerSec + s.errorsPerSec ? success : 1)} tone={errTone} />
        <Metric label="Slowest 1%" value={fmtMs(s.p99)} />
        <Bar value={s.okPerSec + s.errorsPerSec ? success : 0} tone={errTone ?? "signal"} />
      </>
    );
  }
  if (kind === "loadBalancer") {
    return (
      <>
        <Metric label="Passing" value={fmtRate(s.okPerSec)} />
        <Metric label="Errors" value={fmtRate(s.errorsPerSec)} tone={errTone} />
        {s.limitedPerSec !== undefined && <Metric label="Rate limited" value={fmtRate(s.limitedPerSec)} tone={s.limitedPerSec > 0 ? "warn" : undefined} />}
      </>
    );
  }
  if (kind === "queue") {
    const fill = s.queueLimit ? s.queue / s.queueLimit : 0;
    const age = s.oldestAgeMs ?? 0;
    return (
      <>
        <Metric label="Waiting" value={`${s.queue}`} tone={fill > 0.8 ? "crit" : s.queue > 0 ? "warn" : undefined} />
        <Metric label="Oldest" value={fmtMs(age)} tone={age > 5000 ? "crit" : age > 1000 ? "warn" : undefined} />
        <Metric label="Processed" value={fmtRate(s.processedPerSec ?? 0)} />
        {(s.deadLetters ?? 0) > 0 && <Metric label="Gave up on" value={`${s.deadLetters}`} tone="crit" />}
        <Bar value={fill} tone={fill > 0.8 ? "crit" : fill > 0.2 ? "warn" : "signal"} />
      </>
    );
  }
  if (kind === "cache") {
    const hit = s.hitRatio ?? 0;
    return (
      <>
        <Metric label="Hit ratio" value={fmtPct(hit)} />
        <Metric label="Serving" value={fmtRate(s.okPerSec)} />
        <Bar value={hit} tone="signal" />
      </>
    );
  }
  const util = s.utilization;
  const utilTone = util > 0.95 ? "crit" : util > 0.85 ? "warn" : "signal";
  const qTone = s.queueLimit && s.queue >= s.queueLimit * 0.8 ? "crit" : s.queue > 0 ? "warn" : undefined;
  const lag = s.lagMs ?? 0;
  return (
    <>
      <Metric label="Busy" value={`${s.busy}/${s.workers}`} tone={utilTone === "signal" ? undefined : utilTone} />
      <Metric label="Queue" value={`${s.queue}/${s.queueLimit}`} tone={qTone} />
      <Metric label="Rejecting" value={fmtRate(s.errorsPerSec)} tone={errTone} />
      {s.lagMs !== undefined && <Metric label="Behind by" value={fmtMs(lag)} tone={lag > 1000 ? "crit" : lag > 200 ? "warn" : undefined} />}
      {s.staleRate !== undefined && s.staleRate > 0 && <Metric label="Stale reads" value={fmtPct(s.staleRate)} tone="warn" />}
      {s.unreplicated !== undefined && <Metric label="Not yet synced" value={`${s.unreplicated}`} tone={s.unreplicated > 50 ? "warn" : undefined} />}
      {(s.lostUpdates ?? 0) > 0 && <Metric label="Lost updates" value={`${s.lostUpdates}`} tone="crit" />}
      {s.breakerOpen && <Metric label="Breaker" value="Open" tone="warn" />}
      {(s.booting ?? 0) > 0 && <Metric label="Starting up" value={`+${s.booting}`} tone="warn" />}
      <Bar value={util} tone={utilTone} />
    </>
  );
}

function LabNodeImpl({ id, data, selected }: NodeProps<LabFlowNode>) {
  const snap = useSnapshot();
  const s = snap?.nodes[id];
  const health = nodeHealth(s);
  const hColor = HEALTH_COLOR[health];
  const hasInput = data.kind !== "client";
  const hasOutput = data.kind !== "replica";

  return (
    <div
      className={`relative w-44 rounded-lg bg-panel text-[12px] leading-snug shadow-sm ${s?.down ? "opacity-70" : ""}`}
      style={{
        border: `2px ${s?.down ? "dashed" : "solid"} ${hColor}`,
        boxShadow: [
          selected ? "0 0 0 2px var(--panel), 0 0 0 4px var(--text)" : "",
          health === "failing" || health === "down" ? "0 0 18px color-mix(in srgb, var(--h-failing) 35%, transparent)" : "",
        ]
          .filter(Boolean)
          .join(", ") || undefined,
      }}
    >
      {s?.bottleneck && (
        <div className="absolute -top-6 left-0 text-[11px] font-medium" style={{ color: "var(--h-failing)" }}>
          Bottleneck
        </div>
      )}
      {hasInput && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[13px] font-medium">
        <span style={{ color: health === "idle" ? "var(--muted)" : hColor }} title={HEALTH_LABEL[health]}>
          <Glyph kind={data.kind} size={16} />
        </span>
        <span className="truncate">{data.label}</span>
        {s && s.slowFactor > 1 && !s.down && <span className="ml-auto text-[11px]" style={{ color: "var(--h-strained)" }}>Slowed</span>}
        {data.region && !(s && s.slowFactor > 1) && <span className="ml-auto text-[11px] text-muted font-normal">{REGION_LABEL[data.region]}</span>}
      </div>
      <div className="px-3 pb-2.5 space-y-0.5">
        <Body s={s} kind={data.kind} />
      </div>
      {hasOutput && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const LabNode = memo(LabNodeImpl);
