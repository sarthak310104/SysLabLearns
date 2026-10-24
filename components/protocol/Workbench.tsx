"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Frame } from "@/engine/protocol/check";
import type { StageOutcome } from "@/engine/protocol/stages";
import type { Step } from "@/engine/protocol/types";
import type { ProtocolLab, Stage } from "@/content/protocols";
import { loadLabCode, saveLabCode } from "@/lib/progress";
import { useProtocolWorker } from "@/lib/useProtocolWorker";
import { CodeEditor } from "./CodeEditor";
import { RunView, type TraceRequest } from "./RunView";
import { TraceView } from "./TraceView";

type Tab = "code" | "run" | "check";

interface StageState {
  status: "running" | "passed" | "failed" | "error";
  progress?: string;
  fraction?: number;
  outcome?: StageOutcome;
  message?: string;
  /** The code this result belongs to. */
  code: string;
}

type RunSource = { kind: "run"; seed: number; perfect: boolean } | { kind: "failure"; title: string };

export function Workbench({ lab, passed, onStagePassed }: { lab: ProtocolLab; passed: Set<string>; onStagePassed: (stage: string) => void }) {
  const worker = useProtocolWorker();
  const [code, setCode] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [tab, setTab] = useState<Tab>("code");
  const [run, setRun] = useState<{ frames: Frame[] | null; steps: Step[]; source: RunSource; error: string | null; startAt: number }>({
    frames: null,
    steps: [],
    source: { kind: "run", seed: 1, perfect: false },
    error: null,
    startAt: 0,
  });
  const [runLoading, setRunLoading] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [trace, setTrace] = useState<{ stage: string; frames: Frame[] } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeRef = useRef<string>("");

  useEffect(() => {
    loadLabCode(lab.id).then((saved) => {
      const c = saved ?? lab.starter;
      codeRef.current = c;
      setCode(c);
      setResetKey((k) => k + 1);
    });
  }, [lab]);

  const onChange = useCallback(
    (c: string) => {
      codeRef.current = c;
      setCode(c);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLabCode(lab.id, c), 400);
    },
    [lab.id],
  );

  const doTrace = useCallback(
    async (req: TraceRequest, jumpTo = 0) => {
      setRunLoading(true);
      const r = await worker.run({ type: "trace", lab: lab.id, code: codeRef.current, seed: req.seed, perfect: req.perfect, steps: req.steps, extend: 1500 });
      setRunLoading(false);
      if (r.type === "frames") {
        setRun({ frames: r.frames, steps: r.steps, source: { kind: "run", seed: req.seed, perfect: req.perfect }, error: null, startAt: jumpTo });
      } else if (r.type === "error") {
        if (r.message === "Cancelled.") return;
        setRun((s) => ({ ...s, frames: null, error: r.message }));
      }
    },
    [worker, lab.id],
  );

  const startRun = () => {
    setTab("run");
    doTrace({ seed: run.source.kind === "run" ? run.source.seed : 1, perfect: run.source.kind === "run" ? run.source.perfect : false, steps: [] });
  };

  const runStage = useCallback(
    async (stage: Stage): Promise<boolean> => {
      const c = codeRef.current;
      setTrace((t) => (t?.stage === stage.id ? null : t));
      setStages((s) => ({ ...s, [stage.id]: { status: "running", progress: "Starting...", code: c } }));
      const r = await worker.run({ type: "stage", lab: lab.id, code: c, stage: stage.id }, (text, fraction) =>
        setStages((s) => ({ ...s, [stage.id]: { ...s[stage.id], status: "running", progress: text, fraction } })),
      );
      if (r.type === "stage") {
        const ok = r.outcome.ok;
        setStages((s) => ({ ...s, [stage.id]: { status: ok ? "passed" : "failed", outcome: r.outcome, code: c } }));
        if (ok) onStagePassed(stage.id);
        else if (r.outcome.failure) {
          const rep = await worker.run({ type: "replay", lab: lab.id, code: c, stage: stage.id, failure: r.outcome.failure });
          if (rep.type === "frames") setTrace({ stage: stage.id, frames: rep.frames });
        }
        return ok;
      }
      if (r.type === "error") {
        setStages((s) => ({ ...s, [stage.id]: { status: "error", message: r.message, code: c } }));
      }
      return false;
    },
    [worker, lab.id, onStagePassed],
  );

  const runAll = async () => {
    setTab("check");
    for (const st of lab.stages) {
      if (!(await runStage(st))) break;
    }
  };

  const watch = (stage: Stage, frames: Frame[], index: number) => {
    setRun({ frames, steps: frames.slice(1).map((f) => f.step!), source: { kind: "failure", title: stage.title }, error: null, startAt: index });
    setTab("run");
  };

  if (code === null) return <div className="p-6 text-muted">Loading your code...</div>;

  const tabBtn = (t: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={`px-3 py-2 text-[14px] border-b-2 ${tab === t ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel">
      <div className="flex items-center gap-1 px-2 border-b border-line" role="tablist">
        {tabBtn("code", "Code")}
        {tabBtn("run", "Run")}
        {tabBtn("check", "Check")}
        <span className="flex-1" />
        <button className="ctl text-[13px] mr-1" onClick={startRun} disabled={runLoading}>
          Run
        </button>
        <button className="btn-accent rounded px-3 py-1 text-[13px]" onClick={runAll} disabled={worker.busy && !runLoading}>
          Check
        </button>
      </div>

      <div className={tab === "code" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
        <div className="flex-1 min-h-0">
          <CodeEditor value={code} onChange={onChange} resetKey={resetKey} />
        </div>
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-line text-[12px] text-muted">
          <span>Saved in this browser as you type.</span>
          <span className="flex-1" />
          <button
            className="hover:text-crit"
            onClick={() => {
              if (!window.confirm("Replace your code with the starter? Your changes will be lost.")) return;
              codeRef.current = lab.starter;
              setCode(lab.starter);
              saveLabCode(lab.id, lab.starter);
              setResetKey((k) => k + 1);
            }}
          >
            Reset to starter
          </button>
        </div>
      </div>

      {tab === "run" && (
        <div className="flex-1 min-h-0">
          <RunView
            spec={lab.spec}
            frames={run.frames}
            steps={run.steps}
            source={run.source}
            loading={runLoading}
            error={run.error}
            onTrace={doTrace}
            startAt={run.startAt}
          />
        </div>
      )}

      {tab === "check" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ol className="divide-y divide-line">
            {lab.stages.map((st, i) => {
              const s = stages[st.id];
              const stale = s && s.status !== "running" && s.code !== code;
              const done = passed.has(st.id);
              const f = s?.outcome?.failure;
              return (
                <li key={st.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="num text-[13px] text-muted pt-0.5 w-4">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">
                        {st.title}
                        {done && <span className="ml-2 text-[12px] text-signal">Passed before</span>}
                      </p>
                      <p className="text-[13px] text-muted">{st.blurb}</p>
                    </div>
                    <button className="ctl text-[13px]" onClick={() => runStage(st)} disabled={s?.status === "running"}>
                      {s?.status === "running" ? "Running" : "Run"}
                    </button>
                  </div>
                  {s && (
                    <div className="ml-7 mt-2 text-[13px]">
                      {s.status === "running" && (
                        <>
                          <p className="text-muted num">{s.progress}</p>
                          {s.fraction !== undefined && (
                            <div className="mt-1 h-1 rounded-full bg-panel-2 overflow-hidden">
                              <div className="h-full bg-accent" style={{ width: `${Math.round(s.fraction * 100)}%` }} />
                            </div>
                          )}
                          <button className="text-[12px] text-muted hover:text-text mt-1" onClick={worker.cancel}>
                            Stop
                          </button>
                        </>
                      )}
                      {s.status === "passed" && s.outcome && (
                        <p className="text-signal">
                          Passed.{" "}
                          <span className="text-muted">
                            {st.kind === "simulate"
                              ? `${s.outcome.runs} runs, no problems.`
                              : `${s.outcome.states?.toLocaleString()} states checked to depth ${s.outcome.depth}${s.outcome.complete ? "" : " (stopped at the time limit)"}${s.outcome.reachedDone === false ? ". No search path finished the work, so this proves less than it seems" : ""}.`}
                          </span>
                        </p>
                      )}
                      {s.status === "failed" && f && (
                        <div>
                          <p className="text-crit">
                            <span className="font-medium">{f.name}.</span> {f.message}
                          </p>
                          <p className="text-[12px] text-muted mt-1">
                            Found {st.kind === "simulate" ? `in run ${s.outcome?.runs}` : `after ${s.outcome?.states?.toLocaleString()} states`}, {f.steps.length} steps in.
                            {st.kind === "check" && " This is the shortest way to make it happen."}
                          </p>
                        </div>
                      )}
                      {s.status === "error" && <p className="text-crit whitespace-pre-wrap">{s.message}</p>}
                      {stale && <p className="text-[12px] text-warn mt-1">Your code changed since this ran.</p>}
                    </div>
                  )}
                  {trace?.stage === st.id && s?.status === "failed" && (
                    <div className="mt-3 rounded-md border border-line overflow-hidden">
                      <TraceView key={trace.frames.length} spec={lab.spec} frames={trace.frames} onWatch={(index) => watch(st, trace.frames, index)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
