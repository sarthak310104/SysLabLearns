import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LESSONS } from "@/content/curriculum";
import { QUIZZES } from "@/content/quizzes";

describe("lesson content", () => {
  it("every lesson has a well-formed quiz", () => {
    for (const l of LESSONS) {
      const qs = QUIZZES[l.slug];
      expect(qs, l.slug).toBeDefined();
      expect(qs.length).toBeGreaterThanOrEqual(4);
      for (const q of qs) {
        expect(q.answer).toBeGreaterThanOrEqual(0);
        expect(q.answer).toBeLessThan(q.options.length);
        expect(q.explain.length).toBeGreaterThan(20);
      }
    }
  });

  it("every lesson page shows its goals and quiz, without em dashes", () => {
    for (const l of LESSONS) {
      const text = readFileSync(`content/system-design/${l.slug}.mdx`, "utf8");
      expect(text, l.slug).toContain("<Goals />");
      expect(text, l.slug).toContain("<Quiz />");
      expect(text.includes("—"), `${l.slug} has an em dash`).toBe(false);
    }
  });
});
