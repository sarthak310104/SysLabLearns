import type { Frame } from "./check";
import type { InFlight, ProtocolSpec, World } from "./types";

/**
 * Notes for a failing trace: the step where the rule broke, with what that
 * usually means, plus the few earlier steps that set it up (a repeat that was
 * acted on, a lost message nobody resent, a crash). Long random runs have
 * hundreds of steps; these are the ones worth looking at first.
 */
export interface TraceNote {
  index: number;
  kind: "break" | "stuck" | "repeat" | "lost" | "crash" | "restart";
  title: string;
  text: string;
}

const MAX_KEY = 5;
const PRIORITY: Record<TraceNote["kind"], number> = { break: 9, stuck: 9, crash: 4, repeat: 3, restart: 3, lost: 1 };

const keyOf = (m: InFlight) => `${m.from}>${m.to}>${JSON.stringify(m.msg)}`;
const typeOf = (msg: unknown) => (msg && typeof msg === "object" && typeof (msg as { type?: unknown }).type === "string" ? `"${(msg as { type: string }).type}"` : "a message");

export function firstViolation(spec: ProtocolSpec, w: World, only: string[] | null = null): { name: string; message: string; why?: string } | null {
  if (w.error) return { name: "Your code threw an error", message: w.error, why: "The step highlighted ran your handler, and it threw. The state shown is what the node had just before." };
  for (const inv of spec.invariants) {
    if (only && !only.includes(inv.name)) continue;
    try {
      const m = inv.check(w);
      if (m) return { name: inv.name, message: m, why: inv.why };
    } catch {
      /* a checker that can't run on this world says nothing here */
    }
  }
  return null;
}

/** Did delivering this message change anything at the receiver: its state, what it sent, or a finished command? */
function actedOn(before: World, after: World, to: string): boolean {
  if (JSON.stringify(before.nodes[to]?.state) !== JSON.stringify(after.nodes[to]?.state)) return true;
  if (after.history.length !== before.history.length) return true;
  return false;
}

export function annotate(spec: ProtocolSpec, frames: Frame[], opts: { only?: string[] | null; stuck?: string | null } = {}): TraceNote[] {
  if (frames.length < 2) return [];
  let end = frames.findIndex((f) => firstViolation(spec, f.world, opts.only ?? null));
  const breaks = end >= 0;
  if (!breaks) {
    if (!opts.stuck) return [];
    end = frames.length - 1;
  }

  // The last frame each message content is in flight, to tell whether a lost one was ever sent again.
  const lastSeen = new Map<string, number>();
  frames.forEach((f, i) => {
    for (const m of f.world.msgs) lastSeen.set(keyOf(m), i);
  });

  const labRole = new Set(spec.labRoles ?? []);
  const roleOf = Object.fromEntries(spec.nodes.map((n) => [n.id, n.role]));
  const notes: TraceNote[] = [];
  const delivered = new Set<string>();
  for (let i = 1; i <= end; i++) {
    const before = frames[i - 1].world;
    const after = frames[i].world;
    const s = frames[i].step;
    if (!s) continue;
    // Timed runs lose messages as they're sent, so a loss shows up as the step during which it happened.
    if (after.lost > before.lost) {
      const by = s.type === "deliver" ? before.msgs.find((x) => x.seq === s.seq)?.to : s.type === "timer" ? before.timers.find((x) => x.seq === s.seq)?.node : null;
      if (by) {
        const n = after.lost - before.lost;
        notes.push({
          index: i,
          kind: "lost",
          title: `${by}'s message is lost`,
          text: `${by} sends ${n > 1 ? `${n} messages` : "a message"} while handling this step, and the network loses ${n > 1 ? "them" : "it"}. Unless ${by} sends again on a timer, whatever ${n > 1 ? "they were" : "it was"} for never happens.`,
        });
      }
    }
    if (s.type === "deliver") {
      const m = before.msgs.find((x) => x.seq === s.seq);
      if (!m) continue;
      const k = keyOf(m);
      if (delivered.has(k) && !labRole.has(roleOf[m.to]) && actedOn(before, after, m.to) && i !== end) {
        notes.push({
          index: i,
          kind: "repeat",
          title: `${m.to} acts on a repeat`,
          text: `${m.to} already received this exact ${typeOf(m.msg)} message from ${m.from}, and it arrived again (a retry or a duplicated copy). This time ${m.to} changed its state in response. If it should only act once, this is where it acted twice.`,
        });
      }
      delivered.add(k);
    } else if (s.type === "drop") {
      const m = before.msgs.find((x) => x.seq === s.seq);
      if (!m) continue;
      // Another copy still in flight after the loss, or one that already got through, means it isn't lost for good.
      const resent = (lastSeen.get(keyOf(m)) ?? -1) >= i || delivered.has(keyOf(m));
      notes.push({
        index: i,
        kind: "lost",
        title: `A ${typeOf(m.msg)} message is lost`,
        text: resent
          ? `The network loses ${m.from}'s ${typeOf(m.msg)} message to ${m.to}. ${m.from} sends it again later, so this one is recovered.`
          : `The network loses ${m.from}'s ${typeOf(m.msg)} message to ${m.to}, and nothing sends it again. Whatever it was for never happens unless ${m.from} resends on a timer.`,
      });
    } else if (s.type === "crash") {
      notes.push({ index: i, kind: "crash", title: `${s.node} crashes`, text: `${s.node} stops. Everything it held in memory is gone, and messages sent to it are lost. Anything it hadn't passed on yet exists nowhere else.` });
    } else if (s.type === "restart") {
      notes.push({ index: i, kind: "restart", title: `${s.node} restarts empty`, text: `${s.node} comes back with only what init gives it. It knows nothing it learned before the crash unless someone sends it a copy.` });
    }
  }
  // In a stuck run, lost messages that were recovered aren't the story.
  const key = notes
    .filter((n) => !(n.kind === "lost" && /recovered/.test(n.text)))
    .map((n) => ({ n, score: PRIORITY[n.kind] * 10000 + n.index }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_KEY)
    .map((x) => x.n);

  const last = frames[end];
  if (breaks) {
    const v = firstViolation(spec, last.world, opts.only ?? null)!;
    key.push({ index: end, kind: "break", title: `The rule breaks: ${v.name}`, text: `${v.message}${v.why ? ` ${v.why}` : ""}` });
  } else {
    key.push({
      index: end,
      kind: "stuck",
      title: "Nothing more can happen",
      text: `${opts.stuck} ${key.some((n) => n.kind === "lost") ? "Look at the lost messages marked earlier: each one needed a resend that never came." : ""}`.trim(),
    });
  }
  return key.sort((a, b) => a.index - b.index);
}
