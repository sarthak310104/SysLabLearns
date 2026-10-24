"use client";

import { useEffect, useRef, useState } from "react";
import type { Scenario } from "@/lib/scenarios";

/** "Throw an event at it": a menu of scenarios that test a design. */
export function EventsMenu({ scenarios, onRun, disabled }: { scenarios: Scenario[]; onRun: (s: Scenario) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="px-2.5 py-1.5 rounded-md border border-line hover:border-accent text-[13px] disabled:opacity-50"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? "Press Send traffic first" : "Test your design with an event"}
      >
        Events ▾
      </button>
      {open && (
        <div className="absolute z-30 mt-1 left-0 w-[300px] max-w-[calc(100vw-1.5rem)] rounded-lg border border-line bg-panel shadow-xl p-1" role="menu">
          {scenarios.map((sc) => (
            <button
              key={sc.id}
              role="menuitem"
              disabled={Boolean(sc.unavailable)}
              onClick={() => {
                onRun(sc);
                setOpen(false);
              }}
              className="w-full text-left rounded-md px-3 py-2 hover:bg-panel-2 disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span className="block text-[13px] font-medium">{sc.name}</span>
              <span className="block text-[12px] text-muted">{sc.unavailable ?? sc.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown over the canvas while a scenario runs. */
export function ScenarioBanner({ name, remainingMs, loadFactor, onStop }: { name: string; remainingMs: number; loadFactor: number; onStop: () => void }) {
  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-3 rounded-lg border bg-panel/95 px-3 py-1.5 text-[12px] shadow-lg" style={{ borderColor: "var(--h-strained)" }}>
      <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: "var(--h-strained)" }} />
      <span className="font-medium">{name}</span>
      {loadFactor !== 1 && <span className="num text-muted">traffic {loadFactor}x</span>}
      <span className="num text-muted">{Math.ceil(remainingMs / 1000)} s left</span>
      <button className="text-muted hover:text-text" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
