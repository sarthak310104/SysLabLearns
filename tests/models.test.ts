import { describe, expect, it } from "vitest";
import { erlangC, keysMoved, partitionConflicts, queueLatency, retryAmplification, ttlHitRatio, zipfHitRatio } from "@/lib/models";

describe("lesson models", () => {
  it("Erlang C: one worker waits with probability equal to utilization", () => {
    expect(erlangC(1, 0.7)).toBeCloseTo(0.7, 5);
    expect(erlangC(4, 4)).toBe(1);
  });

  it("latency rises steeply near capacity, and pooled workers wait less", () => {
    const at50 = queueLatency(50, 4, 40).p99;
    const at95 = queueLatency(95, 4, 40).p99;
    expect(at95).toBeGreaterThan(at50 * 3);
    expect(queueLatency(120, 4, 40).p99).toBe(Infinity);
    // Same utilization (90%), more workers sharing one queue: less waiting.
    expect(queueLatency(360, 16, 40).mean).toBeLessThan(queueLatency(22.5, 1, 40).mean);
  });

  it("skewed traffic makes small caches useful", () => {
    expect(zipfHitRatio(1000, 100000, 1.0)).toBeGreaterThan(0.5);
    expect(zipfHitRatio(1000, 100000, 0.2)).toBeLessThan(0.1);
  });

  it("TTL, retries and partitions behave as described in the lessons", () => {
    expect(ttlHitRatio(1, 9)).toBeCloseTo(0.9, 5);
    expect(retryAmplification(1, 3)).toBe(4);
    expect(retryAmplification(1, 3, 0.1)).toBeCloseTo(1.1, 5);
    expect(partitionConflicts(60, 45, 1000)).toBeGreaterThan(partitionConflicts(5, 45, 1000));
  });

  it("consistent hashing moves far fewer keys than mod N", () => {
    expect(keysMoved(4, "mod")).toBeGreaterThan(0.7);
    expect(keysMoved(4, "ring")).toBeLessThan(0.3);
  });
});
