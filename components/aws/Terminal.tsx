"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AwsState } from "@/engine/aws/state";
import { awsBus } from "@/lib/awsBus";
import type { TermLine } from "@/lib/useAwsLab";

const BUILTINS = ["aws", "ls", "cd", "pwd", "cat", "echo", "printf", "mkdir", "touch", "rm", "cp", "mv", "edit", "zip", "unzip", "curl", "jq", "grep", "head", "tail", "wc", "base64", "sleep", "date", "whoami", "env", "export", "unset", "clear", "help"];

const shortCwd = (cwd: string) => (cwd.startsWith("/home/you") ? "~" + cwd.slice("/home/you".length) : cwd);

function commonPrefix(xs: string[]): string {
  if (!xs.length) return "";
  let p = xs[0];
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export function Terminal({
  lines,
  busy,
  state,
  commands,
  history,
  onRun,
  onInfo,
}: {
  lines: TermLine[];
  busy: boolean;
  state: AwsState | null;
  commands: Record<string, string[]>;
  history: string[];
  onRun: (line: string) => void;
  onInfo: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const [pendingLines, setPendingLines] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cwd = state?.cwd ?? "/home/you";

  // Lesson "Try it" buttons put a command in the input, ready to edit or run.
  useEffect(
    () =>
      awsBus.subscribe((cmd) => {
        setInput(cmd);
        setHistIdx(null);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(cmd.length, cmd.length);
        });
      }),
    [],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pendingLines, busy]);

  // Grow the input with its content.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const files = useMemo(() => Object.keys(state?.files ?? {}), [state]);

  function complete() {
    const el = inputRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const before = input.slice(0, pos);
    const words = before.split(/\s+/);
    const cur = words[words.length - 1];
    const prev = words.slice(0, -1).filter(Boolean);
    let options: string[] = [];
    let fragment = cur;
    let prefix = "";
    if (prev.length === 0) options = BUILTINS;
    else if (prev[0] === "aws" && prev.length === 1) options = [...Object.keys(commands), "configure", "help"];
    else if (prev[0] === "aws" && prev.length === 2 && !cur.startsWith("-")) options = commands[prev[1]] ?? [];
    else {
      const m = cur.match(/^(fileb?:\/\/)(.*)$/);
      if (m) {
        prefix = m[1];
        fragment = m[2];
      }
      const dir = cwd.endsWith("/") ? cwd : cwd + "/";
      const slash = fragment.lastIndexOf("/");
      const sub = slash >= 0 ? fragment.slice(0, slash + 1) : "";
      const base = dir + sub;
      options = [
        ...new Set(
          files
            .filter((f) => f.startsWith(base))
            .map((f) => {
              const rest = f.slice(base.length);
              const i = rest.indexOf("/");
              return sub + (i >= 0 ? rest.slice(0, i + 1) : rest);
            })
            .filter((n) => !n.endsWith(".keep")),
        ),
      ];
    }
    const matches = options.filter((o) => o.startsWith(fragment)).sort();
    if (!matches.length) return;
    const common = matches.length === 1 ? matches[0] + (matches[0].endsWith("/") ? "" : " ") : commonPrefix(matches);
    if (matches.length > 1 && common === fragment) onInfo(matches.join("   ") + "\n");
    const replaced = before.slice(0, before.length - cur.length) + prefix + common;
    setInput(replaced + input.slice(pos));
    requestAnimationFrame(() => el.setSelectionRange(replaced.length, replaced.length));
  }

  function submit() {
    if (busy) return;
    if (/\\\s*$/.test(input)) {
      // Line continuation: keep collecting, like a real shell.
      setPendingLines((p) => [...p, input.replace(/\\\s*$/, "")]);
      setInput("");
      return;
    }
    const full = [...pendingLines, input].join(" ");
    setPendingLines([]);
    setInput("");
    setHistIdx(null);
    onRun(full);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      complete();
    } else if (e.key === "ArrowUp" && !input.slice(0, el.selectionStart).includes("\n")) {
      if (!history.length) return;
      e.preventDefault();
      const i = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setInput(history[i]);
    } else if (e.key === "ArrowDown" && !input.slice(el.selectionEnd).includes("\n")) {
      if (histIdx === null) return;
      e.preventDefault();
      const i = histIdx + 1;
      if (i >= history.length) {
        setHistIdx(null);
        setInput("");
      } else {
        setHistIdx(i);
        setInput(history[i]);
      }
    } else if (e.key === "c" && e.ctrlKey && el.selectionStart === el.selectionEnd) {
      e.preventDefault();
      onInfo("^C\n");
      setInput("");
      setPendingLines([]);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      onRun("clear");
    }
  }

  const prompt = (dir: string) => (
    <span className="select-none">
      <span style={{ color: "var(--h-good)" }}>you@aws-lab</span>
      <span className="text-muted">:</span>
      <span style={{ color: "var(--h-ideal)" }}>{shortCwd(dir)}</span>
      <span className="text-muted">$ </span>
    </span>
  );

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto bg-bg px-3 py-2 font-mono text-[12.5px] leading-[1.55] cursor-text"
      onClick={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus();
      }}
      role="log"
      aria-label="Terminal output"
    >
      {lines.length === 0 && (
        <p className="text-muted whitespace-pre-wrap">
          {"Practice AWS account ready (region ap-south-1, Mumbai). Nothing here costs money.\nType help for the commands this terminal knows, or click a command in the lesson.\n"}
        </p>
      )}
      {lines.map((l) =>
        l.kind === "cmd" ? (
          <div key={l.id} className="whitespace-pre-wrap break-all">
            {prompt(l.cwd ?? cwd)}
            <span className="text-text">{l.text}</span>
          </div>
        ) : (
          <pre key={l.id} className="whitespace-pre-wrap break-words m-0 font-mono" style={{ color: l.kind === "err" ? "var(--h-failing)" : l.kind === "info" ? "var(--muted)" : "var(--text)" }}>
            {l.text}
          </pre>
        ),
      )}
      {pendingLines.map((p, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          {i === 0 ? prompt(cwd) : <span className="text-muted select-none">{"> "}</span>}
          {p} \
        </div>
      ))}
      <div className="flex items-start">
        {busy ? (
          <span className="text-muted">running...</span>
        ) : (
          <>
            {pendingLines.length ? <span className="text-muted select-none">{"> "}</span> : prompt(cwd)}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setHistIdx(null);
              }}
              onKeyDown={onKey}
              rows={1}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Command"
              className="flex-1 min-w-0 resize-none overflow-hidden bg-transparent outline-none text-text font-mono p-0 m-0 border-0 leading-[1.55]"
              style={{ caretColor: "var(--accent)" }}
            />
          </>
        )}
      </div>
    </div>
  );
}
