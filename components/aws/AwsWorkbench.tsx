"use client";

import { useEffect, useState } from "react";
import { awsBus } from "@/lib/awsBus";
import type { useAwsLab } from "@/lib/useAwsLab";
import { FilesPanel } from "./FilesPanel";
import { ResourcesPanel } from "./ResourcesPanel";
import { Terminal } from "./Terminal";

type Lab = ReturnType<typeof useAwsLab>;

/** Terminal on top; your account's resources and your files below. */
export function AwsWorkbench({ lab }: { lab: Lab }) {
  const [tab, setTab] = useState<"resources" | "files">("resources");
  const [selected, setSelected] = useState<string | null>(null);
  const { editPath, setEditPath } = lab;

  // "Save as" buttons in the lesson write the file here and open it.
  const { writeFile, state } = lab;
  useEffect(
    () =>
      awsBus.onSaveFile((name, content) => {
        const path = `${state?.cwd ?? "/home/you"}/${name}`;
        writeFile(path, content);
        setSelected(path);
        setTab("files");
      }),
    [writeFile, state?.cwd],
  );

  // `edit file` in the terminal opens it here.
  useEffect(() => {
    if (!editPath) return;
    setSelected(editPath);
    setTab("files");
    setEditPath(null);
  }, [editPath, setEditPath]);

  const tabBtn = (t: typeof tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={`px-3 py-1.5 text-[13px] border-b-2 ${tab === t ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel">
      <div className="flex-[3] min-h-[260px] border-b border-line">
        <Terminal
          lines={lab.lines}
          busy={lab.busy}
          state={lab.state}
          commands={lab.commands}
          history={lab.history.map((h) => h.line)}
          onRun={lab.exec}
          onInfo={(text) => lab.addLines([{ kind: "info", text }])}
        />
      </div>
      <div className="flex-[2] min-h-[220px] flex flex-col">
        <div className="flex items-center gap-1 px-2 border-b border-line" role="tablist">
          {tabBtn("resources", "Your AWS account")}
          {tabBtn("files", "Files")}
        </div>
        <div className="flex-1 min-h-0">
          {tab === "resources" ? (
            <ResourcesPanel state={lab.state} onReset={lab.reset} />
          ) : (
            <FilesPanel state={lab.state} selected={selected} onSelect={setSelected} onWrite={lab.writeFile} />
          )}
        </div>
      </div>
    </div>
  );
}
