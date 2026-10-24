import { labById, SIM_DEFAULTS, stageSpec } from "@/content/protocols";
import { compileUserCode } from "./compile";
import { modelCheck, simulate, type Failure } from "./check";
import { Runtime } from "./world";

export interface StageOutcome {
  ok: boolean;
  /** Simulations: runs completed. */
  runs?: number;
  /** Model checks: states explored and depth reached. */
  states?: number;
  depth?: number;
  complete?: boolean;
  reachedDone?: boolean;
  failure: Failure | null;
}

/** A runtime for the learner's code, set up for one stage (or a plain run). */
export function buildRuntime(labId: string, code: string, stageId: string | null, perfect = false) {
  const lab = labById(labId);
  if (!lab) throw new Error(`Unknown lab ${labId}`);
  const stage = stageId ? (lab.stages.find((s) => s.id === stageId) ?? null) : null;
  const compiled = compileUserCode(code);
  if (!compiled.exports) throw new Error(compiled.error ?? "Your code didn't load.");
  let spec = stageSpec(lab, stage);
  if (perfect) spec = { ...spec, network: { ...spec.network, drop: 0, duplicate: 0 } };
  const rt = new Runtime(spec, spec.roles(compiled.exports));
  rt.only = stage?.invariants ?? null;
  return { lab, stage, rt };
}

export function runStage(labId: string, code: string, stageId: string, progress?: (text: string, fraction?: number) => void): StageOutcome {
  const { stage, rt } = buildRuntime(labId, code, stageId);
  if (!stage) throw new Error(`Unknown stage ${stageId}`);
  if (stage.kind === "simulate") {
    const opts = { ...SIM_DEFAULTS, ...stage.sim };
    const r = simulate(rt, { ...opts, onProgress: (done) => progress?.(`Run ${done} of ${opts.runs} passed`, done / opts.runs) });
    return { ok: r.ok, runs: r.runs, failure: r.failure };
  }
  const r = modelCheck(rt, { ...stage.check, onProgress: (states, depth) => progress?.(`${states.toLocaleString()} states, depth ${depth}`) });
  return { ok: r.ok, states: r.states, depth: r.depth, complete: r.complete, reachedDone: r.reachedDone, failure: r.failure };
}
