import { describe, expect, it } from "vitest";
import { INTERVALS, nextBox } from "@/lib/progress";

describe("spaced review (Leitner boxes)", () => {
  const now = 1_000_000;
  it("starts new cards in box 1 when right, box 0 when wrong", () => {
    expect(nextBox(undefined, true, false, now)).toBe(1);
    expect(nextBox(undefined, false, false, now)).toBe(0);
  });
  it("sends any wrong answer back to box 0", () => {
    expect(nextBox({ box: 4, due: now - 1 }, false, true, now)).toBe(0);
  });
  it("moves due cards up one box, capped at the last", () => {
    expect(nextBox({ box: 2, due: now - 1 }, true, false, now)).toBe(3);
    expect(nextBox({ box: INTERVALS.length - 1, due: now }, true, true, now)).toBe(INTERVALS.length - 1);
  });
  it("doesn't skip ahead when a lesson quiz is retaken early", () => {
    expect(nextBox({ box: 2, due: now + 5000 }, true, false, now)).toBe(2);
    expect(nextBox({ box: 2, due: now + 5000 }, true, true, now)).toBe(3);
  });
  it("spaces boxes further apart each time", () => {
    for (let i = 1; i < INTERVALS.length; i++) expect(INTERVALS[i]).toBeGreaterThan(INTERVALS[i - 1]);
  });
});
