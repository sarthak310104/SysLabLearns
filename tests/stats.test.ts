import { describe, expect, it } from "vitest";
import { badges, shiftDay, streak, totals } from "@/lib/stats";

const row = (day: string, minutes = 5) => ({ day, minutes, answers: 2, correct: 1, goals: 0 });

describe("progress stats", () => {
  it("shifts days across month ends", () => {
    expect(shiftDay("2026-03-01", 1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", 1)).toBe("2025-12-31");
  });
  it("counts a streak ending today or yesterday", () => {
    const rows = [row("2026-10-22"), row("2026-10-23"), row("2026-10-24")];
    expect(streak(rows, "2026-10-24").current).toBe(3);
    expect(streak(rows, "2026-10-25").current).toBe(3);
    expect(streak(rows, "2026-10-26").current).toBe(0);
  });
  it("remembers the best streak after a gap", () => {
    const rows = [row("2026-10-01"), row("2026-10-02"), row("2026-10-03"), row("2026-10-04"), row("2026-10-20")];
    expect(streak(rows, "2026-10-20")).toEqual({ current: 1, best: 4 });
  });
  it("ignores empty days", () => {
    expect(streak([{ day: "2026-10-24", minutes: 0, answers: 0, correct: 0, goals: 0 }], "2026-10-24").current).toBe(0);
  });
  it("totals time and accuracy, with this week separate", () => {
    const t = totals([row("2026-10-24", 30), row("2026-10-01", 60)], "2026-10-24");
    expect(t).toMatchObject({ minutes: 90, weekMinutes: 30, answers: 4, correct: 2, accuracy: 0.5 });
  });
  it("awards badges from the inputs", () => {
    const b = badges({
      activity: [row("2026-10-22"), row("2026-10-23"), row("2026-10-24")],
      cards: [],
      tracks: [{ id: "aws", title: "AWS", done: 8, total: 8 }, { id: "protocols", title: "P", done: 1, total: 5 }],
      challenges: { passed: 1, resilient: 0, total: 4 },
      goalsDone: 3,
      today: "2026-10-24",
    });
    const got = (id: string) => b.find((x) => x.id === id)!.earned;
    expect(got("first-goal")).toBe(true);
    expect(got("streak-3")).toBe(true);
    expect(got("streak-7")).toBe(false);
    expect(got("aws")).toBe(true);
    expect(got("protocols")).toBe(false);
    expect(got("challenge")).toBe(true);
    expect(got("unbreakable")).toBe(false);
  });
});
