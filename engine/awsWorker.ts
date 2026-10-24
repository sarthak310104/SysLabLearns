/// <reference lib="webworker" />
/**
 * Runs the emulated AWS account off the main thread, so a Lambda function
 * stuck in a loop can't freeze the page: the page restarts this worker and
 * restores the last saved account.
 */
import { AwsLab, type ExecResult } from "./aws/shell";
import type { AwsState } from "./aws/state";

export type AwsCommand =
  | { type: "init"; state: AwsState }
  | { type: "exec"; id: number; line: string }
  | { type: "write"; id: number; path: string; content: string };

export type AwsReply =
  | { type: "ready" }
  | { type: "result"; id: number; result: ExecResult; state: AwsState }
  | { type: "state"; state: AwsState };

let lab: AwsLab | null = null;
let busy = false;
const post = (m: AwsReply) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<AwsCommand>) => {
  const m = e.data;
  if (m.type === "init") {
    lab = new AwsLab(m.state);
    post({ type: "ready" });
    return;
  }
  if (!lab) return;
  busy = true;
  try {
    if (m.type === "exec") {
      const result = await lab.exec(m.line);
      post({ type: "result", id: m.id, result, state: lab.state });
    } else if (m.type === "write") {
      lab.state.files[m.path] = m.content;
      post({ type: "result", id: m.id, result: { chunks: [], code: 0 }, state: lab.state });
    }
  } catch (err) {
    post({ type: "result", id: (m as { id: number }).id, result: { chunks: [{ text: `Something went wrong in the lab: ${err instanceof Error ? err.message : String(err)}\n`, stream: "err" }], code: 1 }, state: lab.state });
  } finally {
    busy = false;
  }
};

// Background delivery (SQS triggers) once a second.
setInterval(async () => {
  if (!lab || busy) return;
  busy = true;
  try {
    if (await lab.tick()) post({ type: "state", state: lab.state });
  } finally {
    busy = false;
  }
}, 1000);
