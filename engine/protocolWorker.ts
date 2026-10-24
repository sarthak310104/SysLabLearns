/// <reference lib="webworker" />
/**
 * Runs the learner's protocol code off the main thread. Infinite loops can't
 * be interrupted from inside, so the page watches for silence and restarts
 * this worker if it stops answering.
 */
import { replay, type Failure, type Frame } from "./protocol/check";
import { buildRuntime, runStage, type StageOutcome } from "./protocol/stages";
import type { Step, World } from "./protocol/types";
import { describeStep } from "./protocol/world";

export type { StageOutcome };

export type ProtocolJob =
  | { type: "stage"; jobId: number; lab: string; code: string; stage: string }
  | { type: "replay"; jobId: number; lab: string; code: string; stage: string | null; failure: Failure }
  | { type: "trace"; jobId: number; lab: string; code: string; seed: number; perfect: boolean; steps: Step[]; extend: number };

export type ProtocolReply =
  | { type: "progress"; jobId: number; text: string; fraction?: number }
  | { type: "stage"; jobId: number; outcome: StageOutcome }
  | { type: "frames"; jobId: number; frames: Frame[]; steps: Step[]; done: boolean }
  | { type: "error"; jobId: number; message: string };

const post = (m: ProtocolReply) => (self as unknown as Worker).postMessage(m);

function run(job: ProtocolJob) {
  const { jobId } = job;
  if (job.type === "stage") {
    const outcome = runStage(job.lab, job.code, job.stage, (text, fraction) => post({ type: "progress", jobId, text, fraction }));
    post({ type: "stage", jobId, outcome });
    return;
  }
  if (job.type === "replay") {
    const { rt } = buildRuntime(job.lab, job.code, job.stage);
    const frames = replay(rt, job.failure);
    post({ type: "frames", jobId, frames, steps: job.failure.steps, done: true });
    return;
  }
  // A timed run for the Run view: replay the given steps, then keep going.
  const { rt } = buildRuntime(job.lab, job.code, null, job.perfect);
  let w: World = rt.init("timed", job.seed);
  const frames: Frame[] = [{ world: w, desc: "Start", step: null }];
  const steps: Step[] = [];
  const take = (step: Step) => {
    const desc = describeStep(w, step);
    w = rt.apply(w, step);
    steps.push(step);
    frames.push({ world: w, desc, step });
  };
  for (const s of job.steps) take(s);
  for (let i = 0; i < job.extend && !rt.done(w) && !w.error; i++) {
    const next = rt.nextTimed(w);
    if (!next) break;
    take(next);
    if (rt.violation(w)) break;
  }
  post({ type: "frames", jobId, frames, steps, done: rt.done(w) });
}

self.onmessage = (e: MessageEvent<ProtocolJob>) => {
  try {
    run(e.data);
  } catch (err) {
    post({ type: "error", jobId: e.data.jobId, message: err instanceof Error ? err.message : String(err) });
  }
};
