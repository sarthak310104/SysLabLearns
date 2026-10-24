"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "@/components/protocol/CodeEditor";
import { HOME, type AwsState } from "@/engine/aws/state";

const rel = (p: string) => (p.startsWith(HOME + "/") ? p.slice(HOME.length + 1) : p);

/** Your home folder: pick a file to edit it. Changes save as you type. */
export function FilesPanel({ state, selected, onSelect, onWrite }: { state: AwsState | null; selected: string | null; onSelect: (p: string) => void; onWrite: (p: string, c: string) => void }) {
  const files = useMemo(() => Object.keys(state?.files ?? {}).filter((f) => !f.endsWith("/.keep")).sort(), [state]);
  const [resetKey, setResetKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = selected && state ? state.files[selected] : undefined;
  const isZip = current?.startsWith("PK\u0003\u0004");

  // Reload the editor when you pick another file (not on every save).
  useEffect(() => setResetKey((k) => k + 1), [selected]);

  return (
    <div className="h-full flex flex-col sm:flex-row min-h-0">
      <div className="sm:w-48 shrink-0 border-b sm:border-b-0 sm:border-r border-line overflow-y-auto max-h-32 sm:max-h-none">
        <div className="flex items-center px-3 py-1.5 text-[12px] text-muted">
          <span className="font-mono">~/</span>
          <button
            className="ml-auto hover:text-text"
            onClick={() => {
              const name = window.prompt("New file name (for example index.mjs or policy.json)");
              if (!name) return;
              const path = name.startsWith("/") ? name : `${state?.cwd ?? HOME}/${name}`;
              onWrite(path, "");
              onSelect(path);
            }}
          >
            + New file
          </button>
        </div>
        <ul className="text-[12.5px] font-mono">
          {files.map((f) => (
            <li key={f}>
              <button className={`w-full text-left px-3 py-1 truncate ${f === selected ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`} onClick={() => onSelect(f)}>
                {rel(f)}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-h-0 min-w-0">
        {!selected || current === undefined ? (
          <p className="p-3 text-[13px] text-muted">Pick a file to edit it, or type edit index.mjs in the terminal.</p>
        ) : isZip ? (
          <p className="p-3 text-[13px] text-muted">{rel(selected)} is a zip archive. Run unzip -l {rel(selected)} to see what's inside.</p>
        ) : (
          <CodeEditor
            value={current}
            resetKey={resetKey}
            onChange={(c) => {
              if (timer.current) clearTimeout(timer.current);
              const path = selected;
              timer.current = setTimeout(() => onWrite(path, c), 250);
            }}
          />
        )}
      </div>
    </div>
  );
}
