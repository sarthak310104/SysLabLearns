import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AWS_LESSONS, LESSONS, PROTOCOL_LESSONS } from "@/content/curriculum";
import { QUIZZES } from "@/content/quizzes";

describe("lesson content", () => {
  it("every lesson has a well-formed quiz", () => {
    for (const l of [...LESSONS, ...PROTOCOL_LESSONS, ...AWS_LESSONS]) {
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
    const files = [...LESSONS.map((l) => [l.slug, `content/system-design/${l.slug}.mdx`]), ...PROTOCOL_LESSONS.map((l) => [l.slug, `content/protocols/${l.slug}.mdx`]), ...AWS_LESSONS.map((l) => [l.slug, `content/aws/${l.slug}.mdx`])];
    for (const [slug, file] of files) {
      const l = { slug };
      const text = readFileSync(file, "utf8");
      expect(text, l.slug).toContain("<Goals />");
      expect(text, l.slug).toContain("<Quiz />");
      expect(text.includes("—"), `${l.slug} has an em dash`).toBe(false);
    }
  });
});

describe("glossary", () => {
  it("every term points at a real lesson", async () => {
    const { GLOSSARY } = await import("@/content/glossary");
    const slugs = new Set([...LESSONS, ...PROTOCOL_LESSONS, ...AWS_LESSONS].map((l) => l.slug));
    for (const t of GLOSSARY) if (t.lesson) expect(slugs.has(t.lesson), t.term).toBe(true);
  });
});
