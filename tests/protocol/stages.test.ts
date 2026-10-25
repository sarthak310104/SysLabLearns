import { describe, expect, it } from "vitest";
import { LABS } from "@/content/protocols";
import { runStage } from "@/engine/protocol/stages";
import { B0_SHARED_COUNT, B0_SOLUTION, B0_STAGE1, B1_SOLUTION, B2_SOLUTION, B3_SOLUTION, B4_SOLUTION, B5_SOLUTION, B6_SOLUTION, B7_SOLUTION, B8_SOLUTION } from "./solutions";

const SOLUTIONS: Record<string, string> = {
  "b0-foundations": B0_SOLUTION,
  "b1-clocks": B1_SOLUTION,
  "b2-rpc": B2_SOLUTION,
  "b3-primary-backup": B3_SOLUTION,
  "b4-paxos": B4_SOLUTION,
  "b5-raft": B5_SOLUTION,
  "b6-shardkv": B6_SOLUTION,
  "b7-2pc": B7_SOLUTION,
  "b8-crdt": B8_SOLUTION,
};

describe("lab stages, as the workbench runs them", () => {
  for (const lab of LABS) {
    it(`${lab.slug}: the reference passes every stage`, () => {
      for (const stage of lab.stages) {
        const r = runStage(lab.id, SOLUTIONS[lab.slug], stage.id);
        expect(r.failure, `${lab.slug}/${stage.id}: ${r.failure?.message}`).toBeNull();
      }
    }, 180000);
    it(`${lab.slug}: the starter fails some stage`, () => {
      const failed = lab.stages.some((s) => !runStage(lab.id, lab.starter, s.id).ok);
      expect(failed).toBe(true);
    }, 180000);
  }
});

describe("B0 warm-up", () => {
  it("stage 1 code passes stage 1 and fails stage 2", () => {
    expect(runStage("b0-warmup", B0_STAGE1, "capitals").ok).toBe(true);
    expect(runStage("b0-warmup", B0_STAGE1, "numbered").ok).toBe(false);
  });
  it("a shared counter is caught", () => {
    expect(runStage("b0-warmup", B0_SHARED_COUNT, "numbered").failure?.message).toMatch(/separately/);
  });
});
