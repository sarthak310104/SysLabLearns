import { describe, expect, it } from "vitest";
import { runStage } from "@/engine/protocol/stages";
import { compileUserCode } from "@/engine/protocol/compile";
import { Runtime } from "@/engine/protocol/world";
import { B5, B5_STARTER } from "@/content/protocols/b5";
import { B6_STARTER } from "@/content/protocols/b6";
import { B7_STARTER } from "@/content/protocols/b7";
import { B8_STARTER } from "@/content/protocols/b8";
import {
  B5_NO_UPTODATE,
  B5_SOLUTION,
  B6_INSTALLS_LATE_COPIES,
  B6_NO_RESEND,
  B7_FORGETS_DECISIONS,
  B7_GIVES_UP,
  B8_MAX_TOTAL,
  B8_REMOVE_WINS,
} from "./solutions";

const fails = (lab: string, code: string, stage: string) => runStage(lab, code, stage).failure;

describe("the protocol engine's disk", () => {
  it("keeps what a node stored across a crash and restart, and nothing else", () => {
    const c = compileUserCode(B5_SOLUTION);
    const rt = new Runtime(B5, B5.roles(c.exports!));
    let w = rt.init("timed", 1);
    for (let i = 0; i < 400; i++) w = rt.apply(w, rt.nextTimed(w)!);
    const before = w.nodes.s1;
    expect(before.disk).toBeTruthy();
    w = rt.apply(w, { type: "crash", node: "s1" });
    w = rt.apply(w, { type: "restart", node: "s1" });
    const after = w.nodes.s1.state as { currentTerm: number; log: unknown[]; commitIndex: number };
    expect(after.currentTerm).toBe((before.disk as { currentTerm: number }).currentTerm);
    expect(after.log).toEqual((before.disk as { log: unknown[] }).log);
    expect(after.commitIndex).toBe(0);
  });
});

describe("B5 Raft", () => {
  it("each starter bug is caught by its stage", () => {
    expect(fails("b5-raft", B5_STARTER, "elect")?.name).toBe("At most one leader per term");
    const votesFixed = B5_SOLUTION.replace("ctx.store({ currentTerm: s.currentTerm, votedFor: s.votedFor, log: s.log });", "");
    expect(fails("b5-raft", votesFixed, "replicate")).toBeNull();
    expect(fails("b5-raft", votesFixed, "crashes")).not.toBeNull();
  }, 120000);
  it("electing a candidate with a shorter log loses committed entries under crashes", () => {
    expect(fails("b5-raft", B5_NO_UPTODATE, "crashes")).not.toBeNull();
  }, 120000);
});

describe("B6 sharded key-value store", () => {
  it("the starter loses appends when shards move", () => {
    expect(fails("b6-shardkv", B6_STARTER, "handoff")?.message).toMatch(/missing/);
  });
  it("catches handoffs sent only once, and late copies installed over newer data", () => {
    expect(fails("b6-shardkv", B6_NO_RESEND, "lossy")?.name).toBe("Work never finishes");
    expect(fails("b6-shardkv", B6_INSTALLS_LATE_COPIES, "lossy")?.name).toBe("Every append happens exactly once");
  }, 60000);
});

describe("B7 two-phase commit", () => {
  it("the starter commits a transfer one bank refused", () => {
    expect(fails("b7-2pc", B7_STARTER, "agree")?.name).toBe("Both banks agree on every transfer");
  });
  it("catches a bank that gives up waiting, and a coordinator that forgets its decisions", () => {
    expect(fails("b7-2pc", B7_GIVES_UP, "lossy")).not.toBeNull();
    expect(fails("b7-2pc", B7_FORGETS_DECISIONS, "lossy")).toBeNull();
    expect(fails("b7-2pc", B7_FORGETS_DECISIONS, "crashes")?.name).toBe("Both banks agree on every transfer");
  }, 60000);
});

describe("B8 CRDTs", () => {
  it("the starter's merges double count and resurrect removed items", () => {
    expect(fails("b8-crdt", B8_STARTER, "counter")?.name).toBe("The counter is right");
    expect(fails("b8-crdt", B8_STARTER, "set")?.name).toBe("The set is right");
  });
  it("catches max-of-totals counters and remove-wins sets", () => {
    expect(fails("b8-crdt", B8_MAX_TOTAL, "counter")).not.toBeNull();
    expect(fails("b8-crdt", B8_MAX_TOTAL, "set")).toBeNull();
    expect(fails("b8-crdt", B8_REMOVE_WINS, "set")?.message).toMatch(/add the remove never saw/);
  }, 60000);
});
