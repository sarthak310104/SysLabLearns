"use client";

import { useRef, useState } from "react";
import { exportProgress, importProgress } from "@/lib/progress";

/** Save everything this browser knows about your progress to a file, or load it back. */
export function ProgressBackup() {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const download = async () => {
    const data = await exportProgress();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `syslablearns-progress-${data.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const rows = Object.values(data.tables).reduce((n, t) => n + t.length, 0);
    setMsg({ ok: true, text: `Saved ${rows} items to a file.` });
  };

  const restore = async (file: File) => {
    try {
      const n = await importProgress(JSON.parse(await file.text()));
      setMsg({ ok: true, text: `Restored ${n} items. Reloading...` });
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't read that file." });
    }
  };

  return (
    <section className="mt-12 rounded-lg border border-line bg-panel px-4 py-4" aria-labelledby="backup">
      <h2 id="backup" className="font-semibold">
        Your progress
      </h2>
      <p className="text-[14px] text-muted mt-1 max-w-[70ch]">
        Progress, quiz scores, your lab code and your sandbox design are saved in this browser only. They survive reloads, but not clearing site data, private windows, or
        switching browsers. Keep a backup file to move them or keep them safe.
      </p>
      <div className="flex flex-wrap items-center gap-3 mt-3 text-[14px]">
        <button className="btn-accent rounded-md px-3 py-1.5" onClick={download}>
          Download backup
        </button>
        <button className="ctl px-3 py-1.5" onClick={() => input.current?.click()}>
          Restore from a backup
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) restore(f);
            e.target.value = "";
          }}
        />
        {msg && <span style={{ color: msg.ok ? "var(--h-good)" : "var(--h-failing)" }}>{msg.text}</span>}
      </div>
    </section>
  );
}
