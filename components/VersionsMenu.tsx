"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Graph } from "@/engine/model/types";
import { deleteDesign, listDesigns, saveDesign } from "@/lib/progress";

type Row = Awaited<ReturnType<typeof listDesigns>>[number];

/** Save named versions of the sandbox design, reopen them, or go compare two. */
export function VersionsMenu({ current, onOpen }: { current: () => Graph | null; onOpen: (g: Graph) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const refresh = () => listDesigns().then(setRows);

  useEffect(() => {
    if (!open) return;
    refresh();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const fmt = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="relative" ref={ref}>
      <button className="text-muted hover:text-text" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Versions ▾
      </button>
      {note && <span className="ml-2 text-[12px]" style={{ color: "var(--h-good)" }}>{note}</span>}
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[320px] max-w-[calc(100vw-1.5rem)] rounded-lg border border-line bg-panel shadow-xl p-1 text-[13px]">
          <button
            className="w-full text-left rounded-md px-3 py-2 hover:bg-panel-2 font-medium"
            onClick={async () => {
              const g = current();
              if (!g) return;
              const name = window.prompt("Name this version", `Version ${rows.length + 1}`);
              if (!name) return;
              await saveDesign(`v-${Date.now().toString(36)}`, name.slice(0, 60), g);
              await refresh();
              setNote(`Saved "${name.slice(0, 30)}"`);
              setTimeout(() => setNote(null), 2000);
            }}
          >
            Save the current design as a version
          </button>
          {rows.length > 0 && <div className="border-t border-line my-1" />}
          <ul className="max-h-64 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-panel-2">
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{r.name}</span>
                  <span className="block text-[11px] text-muted">
                    {r.graph.nodes.length} components · {fmt(r.updatedAt)}
                  </span>
                </span>
                <button
                  className="text-accent text-[12px]"
                  onClick={() => {
                    if (!window.confirm(`Open "${r.name}"? It replaces what's on the canvas now (save that as a version first if you want to keep it).`)) return;
                    onOpen(r.graph);
                    setOpen(false);
                  }}
                >
                  Open
                </button>
                <button
                  className="text-muted hover:text-crit text-[12px]"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${r.name}"?`)) return;
                    await deleteDesign(r.id);
                    refresh();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line mt-1 pt-1">
            <Link href="/compare/" className="block rounded-md px-3 py-2 hover:bg-panel-2 text-accent">
              Compare two versions side by side
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
