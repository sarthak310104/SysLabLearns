"use client";

import { KIND_LABEL } from "@/engine/model/defaults";
import type { ComponentKind } from "@/engine/model/types";
import { KIND_BLURB } from "./controls";
import { Glyph } from "./glyphs";

export const DRAG_MIME = "application/x-syslab-kind";

/** Components you can drag onto the canvas (or click to add in the middle). */
export function Palette({
  kinds,
  onAdd,
  layout,
}: {
  kinds: ComponentKind[];
  onAdd: (kind: ComponentKind) => void;
  layout: "column" | "row";
}) {
  if (!kinds.length) return null;
  return (
    <div
      className={
        layout === "column"
          ? "flex flex-col gap-1.5 p-3 border-r border-line bg-panel w-52 shrink-0 overflow-y-auto"
          : "flex gap-1.5 px-3 py-2 border-b border-line bg-panel overflow-x-auto"
      }
    >
      {layout === "column" && <p className="text-[12px] text-muted mb-1">Drag onto the canvas, or click to add.</p>}
      {kinds.map((k) => (
        <button
          key={k}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_MIME, k);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onAdd(k)}
          title={`Add ${KIND_LABEL[k].toLowerCase()}`}
          className="flex items-center gap-2.5 text-left rounded-md border border-line bg-panel-2/60 hover:border-accent neon-hover px-2.5 py-2 cursor-grab active:cursor-grabbing shrink-0"
        >
          <span className="text-signal">
            <Glyph kind={k} size={16} />
          </span>
          <span className="text-[13px] leading-tight">
            <span className="block font-medium">{KIND_LABEL[k]}</span>
            {layout === "column" && <span className="block text-[12px] text-muted">{KIND_BLURB[k]}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
