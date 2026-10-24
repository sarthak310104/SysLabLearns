"use client";

import { useState } from "react";
import type { AnyConfig, ComponentKind, FaultAction, Incident, NodeStats, Region, Snapshot } from "@/engine/model/types";
import { REGION_LABEL } from "@/engine/model/defaults";
import type { HistoryPoint } from "@/lib/useSimulation";
import { CONTROLS, type Control } from "./controls";
import { fmtMs, fmtPct, fmtRate, fmtTime } from "./format";
import { Glyph } from "./glyphs";
import { Sparkline } from "./Sparkline";
import type { LabFlowNode } from "./LabNode";

function ControlRow({ c, value, onChange }: { c: Control; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ctl-${c.key}`;
  if (c.type === "toggle") {
    return (
      <label className="flex items-start gap-2.5 py-1.5 cursor-pointer">
        <input id={id} type="checkbox" className="mt-1 accent-[var(--accent)]" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <span className="block">{c.label}</span>
          {c.help && <span className="block text-[12px] text-muted">{c.help}</span>}
        </span>
      </label>
    );
  }
  if (c.type === "select") {
    return (
      <div className="py-1.5">
        <label htmlFor={id} className="block mb-1">
          {c.label}
        </label>
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} className="w-full bg-panel-2 border border-line rounded-md px-2 py-1.5">
          {c.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {c.help && <p className="text-[12px] text-muted mt-1">{c.help}</p>}
      </div>
    );
  }
  const scale = c.scale ?? 1;
  const num = Number(value ?? 0);
  let shown: string;
  if (num === 0 && c.zeroLabel) shown = c.zeroLabel;
  else if (c.unit === "ms" && num >= 1000) shown = `${(num / 1000).toFixed(1)} s`;
  else if (c.unit === "%") shown = `${Math.round(num * scale)}%`;
  else shown = `${Number.isInteger(num * scale) ? num * scale : (num * scale).toFixed(1)}${c.unit ? ` ${c.unit}` : ""}`;
  return (
    <div className="py-1.5">
      <div className="flex justify-between mb-1">
        <label htmlFor={id}>{c.label}</label>
        <span className="num text-muted">{shown}</span>
      </div>
      <input id={id} type="range" min={c.min} max={c.max} step={c.step} value={num} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      {c.help && <p className="text-[12px] text-muted mt-0.5">{c.help}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`num text-[15px] ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function NodeCharts({ history }: { history: HistoryPoint[] }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex justify-between text-[12px] text-muted mb-1">
          <span>Throughput</span>
          <span>
            <span className="text-signal">served</span> and <span className="text-crit">failed</span> per second
          </span>
        </div>
        <Sparkline
          label="Throughput over the last 15 seconds"
          series={[
            { values: history.map((h) => h.ok), color: "var(--signal)" },
            { values: history.map((h) => h.err), color: "var(--crit)" },
          ]}
        />
      </div>
      <div>
        <div className="text-[12px] text-muted mb-1">Slowest 1% of responses (p99)</div>
        <Sparkline label="p99 latency over the last 15 seconds" series={[{ values: history.map((h) => h.p99), color: "var(--accent)" }]} />
      </div>
    </div>
  );
}

function IncidentFeed({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) return <p className="text-muted text-[13px]">Nothing has gone wrong yet. Add load or break something to see what happens.</p>;
  return (
    <ol className="space-y-2">
      {incidents.slice(0, 12).map((i) => (
        <li key={i.id} className="flex gap-2.5 text-[13px]">
          <span
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
            style={{ background: i.severity === "critical" ? "var(--crit)" : i.severity === "warning" ? "var(--warn)" : "var(--signal)" }}
            aria-hidden="true"
          />
          <span>
            <span className="num text-muted mr-2">{fmtTime(i.time)}</span>
            {i.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function SystemSummary({ snapshot }: { snapshot: Snapshot | null }) {
  const clients = Object.values(snapshot?.nodes ?? {}).filter((n) => n.kind === "client");
  const sent = clients.reduce((a, c) => a + (c.sendingRps ?? 0), 0);
  const ok = clients.reduce((a, c) => a + c.okPerSec, 0);
  const err = clients.reduce((a, c) => a + c.errorsPerSec, 0);
  const p99 = Math.max(0, ...clients.map((c) => c.p99));
  const success = ok + err ? ok / (ok + err) : 1;
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Sending" value={fmtRate(sent)} />
      <Stat label="Succeeding" value={fmtPct(success)} tone={success < 0.95 ? "text-crit" : success < 0.995 ? "text-warn" : undefined} />
      <Stat label="p99" value={fmtMs(p99)} />
    </div>
  );
}

const BTN = "px-3 py-1.5 rounded-md border text-[13px]";

function FaultButtons({ s, id, kind, onFault }: { s: NodeStats | undefined; id: string; kind: ComponentKind; onFault: (a: FaultAction) => void }) {
  if (kind === "client" || !s) return null;
  const canSlow = kind === "server" || kind === "database" || kind === "replica";
  return (
    <div className="flex flex-wrap gap-2">
      {s.down ? (
        <button className={`${BTN} border-line hover:bg-panel-2`} onClick={() => onFault({ type: "recover", nodeId: id })}>
          Bring back up
        </button>
      ) : (
        <button className={`${BTN} border-crit text-crit hover:bg-panel-2`} onClick={() => onFault({ type: "crash", nodeId: id })}>
          Crash it
        </button>
      )}
      {canSlow &&
        (s.slowFactor > 1 ? (
          <button className={`${BTN} border-line hover:bg-panel-2`} onClick={() => onFault({ type: "slow", nodeId: id, factor: 1 })}>
            Restore speed
          </button>
        ) : (
          <button className={`${BTN} border-warn text-warn hover:bg-panel-2`} onClick={() => onFault({ type: "slow", nodeId: id, factor: 4 })}>
            Make it 4x slower
          </button>
        ))}
    </div>
  );
}

export interface SelectedLink {
  id: string;
  from: string;
  to: string;
  /** This link plus the link going the other way, if there is one: a partition cuts both. */
  pairIds: string[];
  replication: boolean;
}

export interface InspectorProps {
  selected: LabFlowNode | null;
  selectedLink: SelectedLink | null;
  snapshot: Snapshot | null;
  history: Map<string, HistoryPoint[]>;
  incidents: Incident[];
  canDelete: boolean;
  onConfig: (id: string, config: AnyConfig) => void;
  onRename: (id: string, label: string) => void;
  onRegion: (id: string, region: Region | undefined) => void;
  onFault: (a: FaultAction) => void;
  onDelete: (id: string) => void;
  onDeleteLink: (id: string) => void;
}

function LinkPanel({ link, p }: { link: SelectedLink; p: InspectorProps }) {
  const isCut = p.snapshot?.cutEdges.includes(link.id) ?? false;
  const section = "px-4 py-3 border-b border-line";
  return (
    <div className="text-[14px]">
      <div className={section}>
        <h2 className="font-medium">Link</h2>
        <p className="text-muted text-[13px] mt-0.5">
          {link.from} to {link.to}
          {link.replication ? ": carries replication, not requests" : ""}
        </p>
      </div>
      <div className={`${section} space-y-3`}>
        <p className="text-[13px] text-muted">
          A network partition drops everything on this link{link.pairIds.length > 1 ? " in both directions" : ""}. Nothing tells the sender: requests just never get an answer.
        </p>
        {isCut ? (
          <button className={`${BTN} border-line hover:bg-panel-2`} onClick={() => p.onFault({ type: "heal", edgeIds: link.pairIds })}>
            Reconnect
          </button>
        ) : (
          <button className={`${BTN} border-crit text-crit hover:bg-panel-2`} onClick={() => p.onFault({ type: "cut", edgeIds: link.pairIds })}>
            Cut the network here
          </button>
        )}
        {p.canDelete && (
          <div>
            <button className="text-[13px] text-muted hover:text-crit" onClick={() => p.onDeleteLink(link.id)}>
              Remove this link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Inspector(p: InspectorProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const sel = p.selected;
  const section = "px-4 py-3 border-b border-line";
  if (p.selectedLink) return <LinkPanel link={p.selectedLink} p={p} />;
  if (!sel) {
    return (
      <div className="text-[14px]">
        <div className={section}>
          <h2 className="font-medium mb-2.5">Whole system</h2>
          <SystemSummary snapshot={p.snapshot} />
        </div>
        <div className={section}>
          <h2 className="font-medium mb-2.5">What happened</h2>
          <IncidentFeed incidents={p.incidents} />
        </div>
        <p className="px-4 py-3 text-[13px] text-muted">Select a component to tune it or break it, or a link to cut it.</p>
      </div>
    );
  }
  const { kind, label, config } = sel.data;
  const s = p.snapshot?.nodes[sel.id];
  const cfg = config as unknown as Record<string, unknown>;
  const basic = CONTROLS[kind].filter((c) => !c.advanced);
  const advanced = CONTROLS[kind].filter((c) => c.advanced);
  const row = (c: Control) => <ControlRow key={c.key} c={c} value={cfg[c.key]} onChange={(v) => p.onConfig(sel.id, { ...cfg, [c.key]: v } as unknown as AnyConfig)} />;
  return (
    <div className="text-[14px]">
      <div className={`${section} flex items-center gap-2`}>
        <span className="text-muted">
          <Glyph kind={kind} />
        </span>
        <input
          aria-label="Component name"
          value={label}
          onChange={(e) => p.onRename(sel.id, e.target.value)}
          className="flex-1 bg-transparent font-medium rounded px-1 -mx-1 hover:bg-panel-2 focus:bg-panel-2"
        />
      </div>
      {s && (
        <div className={section}>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Stat label={kind === "queue" ? "Accepted" : "Served"} value={fmtRate(s.okPerSec)} />
            <Stat label="Failed" value={fmtRate(s.errorsPerSec)} tone={s.errorsPerSec > 0 ? "text-crit" : undefined} />
            <Stat label="p99" value={fmtMs(s.p99)} />
          </div>
          <NodeCharts history={p.history.get(sel.id) ?? []} />
        </div>
      )}
      <div className={section}>
        <h2 className="font-medium mb-1">Settings</h2>
        <div className="py-1.5">
          <label htmlFor="ctl-region" className="block mb-1">
            Region
          </label>
          <select
            id="ctl-region"
            value={sel.data.region ?? ""}
            onChange={(e) => p.onRegion(sel.id, (e.target.value || undefined) as Region | undefined)}
            className="w-full bg-panel-2 border border-line rounded-md px-2 py-1.5"
          >
            <option value="">Same place as everything else</option>
            {(Object.keys(REGION_LABEL) as Region[]).map((r) => (
              <option key={r} value={r}>
                {REGION_LABEL[r]}
              </option>
            ))}
          </select>
          <p className="text-[12px] text-muted mt-1">Links to other regions take real time: Mumbai to Virginia is about 95 ms each way.</p>
        </div>
        {basic.map(row)}
        {advanced.length > 0 && (
          <>
            <button className="text-[13px] text-accent mt-2" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Fewer settings" : "More settings: timeouts, retries, limits"}
            </button>
            {showAdvanced && <div className="mt-1">{advanced.map(row)}</div>}
          </>
        )}
      </div>
      {(kind !== "client" || p.canDelete) && (
        <div className={`${section} space-y-3`}>
          <FaultButtons s={s} id={sel.id} kind={kind} onFault={p.onFault} />
          {p.canDelete && (
            <button className="text-[13px] text-muted hover:text-crit" onClick={() => p.onDelete(sel.id)}>
              Remove from canvas
            </button>
          )}
        </div>
      )}
    </div>
  );
}
