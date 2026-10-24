"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AwsCommand, AwsReply } from "@/engine/awsWorker";
import type { ExecResult } from "@/engine/aws/shell";
import { freshState, upgradeState, type AwsState } from "@/engine/aws/state";
import type { HistoryEntry } from "@/content/aws/labs";
import { loadAwsAccount, saveAwsAccount } from "./progress";

export interface TermLine {
  id: number;
  kind: "cmd" | "out" | "err" | "info";
  text: string;
  /** For commands: the folder they ran in, shown in the prompt. */
  cwd?: string;
}

/** A command that hasn't answered in this long is stuck (usually a Lambda function in an endless loop). */
const STUCK_MS = 15000;
const MAX_LINES = 600;

/**
 * The emulated AWS account: one per browser, shared by every AWS lesson.
 * Runs in a worker; saved after every command.
 */
export function useAwsLab() {
  const worker = useRef<Worker | null>(null);
  const [state, setState] = useState<AwsState | null>(null);
  const stateRef = useRef<AwsState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyRef = useRef<HistoryEntry[]>([]);
  const [lines, setLines] = useState<TermLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<Record<string, string[]>>({});
  const [editPath, setEditPath] = useState<string | null>(null);
  const nextId = useRef(1);
  const pending = useRef(new Map<number, (r: { result: ExecResult; state: AwsState }) => void>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addLines = useCallback((ls: Omit<TermLine, "id">[]) => {
    setLines((prev) => [...prev, ...ls.map((l) => ({ ...l, id: nextId.current++ }))].slice(-MAX_LINES));
  }, []);

  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (stateRef.current) saveAwsAccount(stateRef.current, historyRef.current);
    }, 300);
  }, []);

  const adopt = useCallback(
    (s: AwsState) => {
      stateRef.current = s;
      setState(s);
      persist();
    },
    [persist],
  );

  const spawn = useCallback(
    (s: AwsState) => {
      worker.current?.terminate();
      const w = new Worker("/aws-worker.js", { type: "module" });
      w.onmessage = (e: MessageEvent<AwsReply>) => {
        const m = e.data;
        if (m.type === "ready") setCommands(m.commands);
        else if (m.type === "state") adopt(m.state);
        else if (m.type === "result") {
          const cb = pending.current.get(m.id);
          pending.current.delete(m.id);
          cb?.({ result: m.result, state: m.state });
        }
      };
      w.postMessage({ type: "init", state: s } satisfies AwsCommand);
      worker.current = w;
    },
    [adopt],
  );

  useEffect(() => {
    let alive = true;
    loadAwsAccount().then((saved) => {
      if (!alive) return;
      const s = (saved?.state as AwsState | undefined)?.version === 1 ? upgradeState(saved!.state as AwsState) : freshState();
      historyRef.current = (saved?.history as HistoryEntry[] | undefined) ?? [];
      setHistory(historyRef.current);
      // Show the end of the last session, so a reload doesn't lose your place.
      const recent = historyRef.current.slice(-12);
      if (recent.length) {
        const restored: TermLine[] = [];
        for (const h of recent) {
          restored.push({ id: nextId.current++, kind: "cmd", text: h.line, cwd: s.cwd });
          if (h.out) restored.push({ id: nextId.current++, kind: "out", text: h.out.length >= 4000 ? h.out + "\n(output shortened)\n" : h.out });
          if (h.err) restored.push({ id: nextId.current++, kind: "err", text: h.err });
        }
        restored.push({ id: nextId.current++, kind: "info", text: "(Above: your last commands from before. Your resources are as you left them.)\n" });
        setLines(restored);
      }
      stateRef.current = s;
      setState(s);
      spawn(s);
    });
    // Save straight away if the page is closed mid-delay.
    const flush = () => {
      if (saveTimer.current && stateRef.current) saveAwsAccount(stateRef.current, historyRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      alive = false;
      flush();
      window.removeEventListener("pagehide", flush);
      worker.current?.terminate();
    };
  }, [spawn]);

  const send = useCallback(
    (cmd: AwsCommand & { id: number }) =>
      new Promise<{ result: ExecResult; state: AwsState } | null>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.current.has(cmd.id)) return;
          pending.current.delete(cmd.id);
          resolve(null);
        }, STUCK_MS);
        pending.current.set(cmd.id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        worker.current?.postMessage(cmd);
      }),
    [],
  );

  const exec = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      const cwd = stateRef.current?.cwd ?? "/home/you";
      addLines([{ kind: "cmd", text: line, cwd }]);
      if (!trimmed) return;
      setBusy(true);
      const id = nextId.current++;
      const r = await send({ type: "exec", id, line });
      setBusy(false);
      if (!r) {
        addLines([{ kind: "err", text: "The command didn't finish in 15 seconds, so the lab stopped it. A Lambda function may be stuck in a loop that never ends. Your resources are as they were before this command.\n" }]);
        if (stateRef.current) spawn(stateRef.current);
        return;
      }
      if (r.result.clear) setLines([]);
      else addLines(r.result.chunks.map((c) => ({ kind: c.stream === "err" ? "err" : "out", text: c.text })));
      if (r.result.edit) setEditPath(r.result.edit);
      const out = r.result.chunks.filter((c) => c.stream === "out").map((c) => c.text).join("");
      const err = r.result.chunks.filter((c) => c.stream === "err").map((c) => c.text).join("");
      historyRef.current = [...historyRef.current, { line, code: r.result.code, out: out.slice(0, 4000), err: err.slice(0, 1000), t: Date.now() }].slice(-300);
      setHistory(historyRef.current);
      adopt(r.state);
    },
    [addLines, adopt, send, spawn],
  );

  const writeFile = useCallback(
    async (path: string, content: string) => {
      const id = nextId.current++;
      const r = await send({ type: "write", id, path, content });
      if (r) adopt(r.state);
    },
    [adopt, send],
  );

  const reset = useCallback(() => {
    const s = freshState();
    historyRef.current = [];
    setHistory([]);
    setLines([]);
    adopt(s);
    spawn(s);
  }, [adopt, spawn]);

  return { state, history, lines, busy, commands, exec, writeFile, reset, editPath, setEditPath, addLines };
}
