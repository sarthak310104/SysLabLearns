import type { Frame } from "@/engine/protocol/check";
import type { InFlight, ProtocolSpec, World } from "@/engine/protocol/types";

export interface Placed {
  id: string;
  role: string;
  label: string;
  x: number;
  y: number;
}

export const VIEW_W = 640;
export const VIEW_H = 340;

/**
 * Nodes on an ellipse, in the order the lab lists them. Clients sit on the
 * left, everything else fans out to the right, so arrows read left to right.
 */
export function placeNodes(spec: ProtocolSpec): Placed[] {
  const n = spec.nodes.length;
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const rx = VIEW_W / 2 - 70;
  const ry = VIEW_H / 2 - 50;
  return spec.nodes.map((node, i) => {
    const a = Math.PI + (2 * Math.PI * i) / n + Math.PI / n;
    return { id: node.id, role: node.role, label: node.label ?? node.id, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

const ROLE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
export function roleColors(spec: ProtocolSpec): Record<string, string> {
  const roles = [...new Set(spec.nodes.map((n) => n.role))];
  return Object.fromEntries(roles.map((r, i) => [r, ROLE_COLORS[i % ROLE_COLORS.length]]));
}

/** The first broken invariant in a world, like the runtime's own check. */
export function violationOf(spec: ProtocolSpec, w: World, only: string[] | null = null): { name: string; message: string } | null {
  if (w.error) return { name: "Your code threw an error", message: w.error };
  for (const inv of spec.invariants) {
    if (only && !only.includes(inv.name)) continue;
    try {
      const m = inv.check(w);
      if (m) return { name: inv.name, message: m };
    } catch (e) {
      return { name: inv.name, message: `checking failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return null;
}

/** When each timed message was sent: the clock of the first frame it shows up in. */
export function sentTimes(frames: Frame[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of frames) for (const m of f.world.msgs) if (!out.has(m.seq)) out.set(m.seq, f.world.clock);
  return out;
}

/** The message a step delivered, looked up in the world before it. */
export function stepMessage(before: World | undefined, frame: Frame): InFlight | null {
  const s = frame.step;
  if (!before || !s || (s.type !== "deliver" && s.type !== "drop" && s.type !== "duplicate")) return null;
  return before.msgs.find((m) => m.seq === s.seq) ?? null;
}

/** Short text for a message: its type plus the most telling fields. */
export function msgLabel(msg: unknown): string {
  if (!msg || typeof msg !== "object") return JSON.stringify(msg);
  const o = msg as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  const rest = Object.entries(o)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => `${k}:${short(v)}`)
    .join(" ");
  const s = `${type}${rest ? " " + rest : ""}`;
  return s.length > 64 ? s.slice(0, 61) + "..." : s;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 18 ? s.slice(0, 15) + "..." : s;
}

export const fmtMs = (t: number) => `${t < 10 ? t.toFixed(1) : Math.round(t)} ms`;
