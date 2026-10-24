import { describe, expect, it } from "vitest";
import { Simulation } from "@/engine/model/simulation";
import { A2 } from "@/content/system-design/presets";
import { buildPicture } from "@/lib/exportDesign";

const palette = { bg: "#000", panel: "#111", line: "#333", text: "#fff", muted: "#999", ideal: "#3d8bff", good: "#2fd27a", strained: "#ffd23f", failing: "#ff3b3b", accent: "#ff1f4b" };

describe("share picture", () => {
  it("draws every component and link, with moving dots for busy links", () => {
    const sim = new Simulation(structuredClone(A2.graph), 3);
    sim.runUntil(8000);
    const pic = buildPicture({ name: "Test <design>", graph: A2.graph, snapshot: sim.snapshot() }, palette);
    for (const n of A2.graph.nodes) expect(pic.animated).toContain(n.label.replace("(", "(").slice(0, 10));
    expect(pic.animated).toContain("Test &lt;design&gt;");
    expect((pic.animated.match(/<animateMotion/g) ?? []).length).toBeGreaterThan(A2.graph.edges.length);
    // A frame is a static picture: no SMIL, dots placed explicitly, and it changes over time.
    expect(pic.frame(0)).not.toContain("animateMotion");
    expect(pic.frame(0)).not.toBe(pic.frame(0.5));
  });
});
