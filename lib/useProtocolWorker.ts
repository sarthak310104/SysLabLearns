"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProtocolJob, ProtocolReply } from "@/engine/protocolWorker";

/** If the worker says nothing for this long, the learner's code is probably stuck in a loop. */
const SILENCE_MS = 10000;

type JobInput = ProtocolJob extends infer J ? (J extends { jobId: number } ? Omit<J, "jobId"> : never) : never;

interface Pending {
  resolve: (r: ProtocolReply) => void;
  onProgress?: (text: string, fraction?: number) => void;
}

/**
 * One worker for protocol jobs. Jobs run one at a time; starting a new one
 * cancels the old by restarting the worker, which is also how a stuck job
 * (an infinite loop in a handler) gets stopped.
 */
export function useProtocolWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef<Map<number, Pending>>(new Map());
  const nextId = useRef(1);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);

  const clearWatchdog = () => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
  };

  const spawn = useCallback(() => {
    workerRef.current?.terminate();
    const w = new Worker("/protocol-worker.js", { type: "module" });
    w.onmessage = (e: MessageEvent<ProtocolReply>) => {
      const m = e.data;
      const p = pending.current.get(m.jobId);
      if (!p) return;
      if (m.type === "progress") {
        armWatchdog(m.jobId);
        p.onProgress?.(m.text, m.fraction);
        return;
      }
      clearWatchdog();
      pending.current.delete(m.jobId);
      setBusy(pending.current.size > 0);
      p.resolve(m);
    };
    w.onerror = (e) => {
      for (const [id, p] of pending.current) p.resolve({ type: "error", jobId: id, message: e.message || "The protocol worker crashed." });
      pending.current.clear();
      setBusy(false);
    };
    workerRef.current = w;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failAll = useCallback((message: string) => {
    for (const [id, p] of pending.current) p.resolve({ type: "error", jobId: id, message });
    pending.current.clear();
    setBusy(false);
  }, []);

  function armWatchdog(jobId: number) {
    clearWatchdog();
    watchdog.current = setTimeout(() => {
      if (!pending.current.has(jobId)) return;
      failAll(
        "Your code stopped responding for 10 seconds, so the run was stopped. A handler is probably stuck in a loop that never ends (check while loops and recursion).",
      );
      spawn();
    }, SILENCE_MS);
  }

  useEffect(() => {
    spawn();
    return () => {
      clearWatchdog();
      workerRef.current?.terminate();
    };
  }, [spawn]);

  /** Start a job. Any job already running is cancelled. */
  const run = useCallback(
    (job: JobInput, onProgress?: (text: string, fraction?: number) => void): Promise<ProtocolReply> => {
      if (pending.current.size) {
        failAll("Cancelled.");
        spawn();
      }
      const jobId = nextId.current++;
      return new Promise((resolve) => {
        pending.current.set(jobId, { resolve, onProgress });
        setBusy(true);
        armWatchdog(jobId);
        workerRef.current?.postMessage({ ...job, jobId } as ProtocolJob);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spawn, failAll],
  );

  const cancel = useCallback(() => {
    if (!pending.current.size) return;
    clearWatchdog();
    failAll("Cancelled.");
    spawn();
  }, [failAll, spawn]);

  return { run, cancel, busy };
}
