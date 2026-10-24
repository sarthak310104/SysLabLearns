import { describe, expect, it } from "vitest";
import { annotate } from "@/engine/protocol/annotate";
import { replay } from "@/engine/protocol/check";
import { buildRuntime, runStage } from "@/engine/protocol/stages";
import { LABS } from "@/content/protocols";
import { B2_NO_DEDUP, B3_NO_SYNC, B4_IGNORES_ACCEPTED } from "./solutions";

function notesFor(labId: string, code: string, stageId: string) {
  const r = runStage(labId, code, stageId);
  expect(r.failure).not.toBeNull();
  const { rt, stage } = buildRuntime(labId, code, stageId);
  const frames = replay(rt, r.failure!);
  const stuck = r.failure!.name === "Work never finishes" ? r.failure!.message : null;
  return { notes: annotate(rt.spec, frames, { only: stage?.invariants ?? null, stuck }), frames, failure: r.failure! };
}

describe("trace notes", () => {
  it("B2 without duplicate detection: marks the repeat the server acted on, then the break", () => {
    const { notes, frames } = notesFor("b2-rpc", B2_NO_DEDUP, "lossy");
    const brk = notes.at(-1)!;
    expect(brk.kind).toBe("break");
    expect(brk.text).toMatch(/remember/);
    expect(brk.index).toBeLessThanOrEqual(frames.length - 1);
    expect(notes.some((n) => n.kind === "repeat" && n.title.startsWith("server"))).toBe(true);
    expect(notes.length).toBeLessThanOrEqual(6);
  }, 60000);

  it("B2 starter: a lost message that is never resent explains the stuck run", () => {
    const b2 = LABS.find((l) => l.slug === "b2-rpc")!;
    const r = runStage(b2.id, b2.starter, "lossy");
    const { rt } = buildRuntime(b2.id, b2.starter, "lossy");
    const frames = replay(rt, r.failure!);
    const notes = annotate(rt.spec, frames, { stuck: r.failure!.name === "Work never finishes" ? r.failure!.message : null });
    expect(notes.length).toBeGreaterThan(0);
    const last = notes.at(-1)!;
    expect(["break", "stuck"]).toContain(last.kind);
    if (last.kind === "stuck") expect(notes.some((n) => n.kind === "lost" && /nothing sends it again|Unless/.test(n.text))).toBe(true);
  }, 60000);

  it("B3 without state transfer: marks a crash before the break", () => {
    const { notes } = notesFor("b3-primary-backup", B3_NO_SYNC, "crashes");
    expect(notes.some((n) => n.kind === "crash")).toBe(true);
    expect(notes.at(-1)!.kind).toBe("break");
  }, 120000);

  it("B4 ignoring accepted values: the break explains what to adopt", () => {
    const { notes } = notesFor("b4-paxos", B4_IGNORES_ACCEPTED, "orderings");
    expect(notes.at(-1)!.text).toMatch(/highest accepted ballot|actually chosen/);
  }, 120000);
});
