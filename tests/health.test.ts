import { describe, expect, it } from "vitest";
import type { NodeStats } from "@/engine/model/types";
import { edgeHealth, findings, nodeHealth, verdictOf } from "@/lib/health";

const base = (o: Partial<NodeStats>): NodeStats => ({
  id: "x",
  kind: "server",
  status: "ok",
  down: false,
  slowFactor: 1,
  okPerSec: 100,
  errorsPerSec: 0,
  errorRate: 0,
  p50: 10,
  p99: 40,
  queue: 0,
  queueLimit: 100,
  busy: 1,
  workers: 4,
  utilization: 0.3,
  workUtilization: 0.3,
  bottleneck: false,
  ...o,
});

describe("health colors and verdict", () => {
  it("maps load to the four colors", () => {
    expect(nodeHealth(base({ utilization: 0.3 }))).toBe("ideal");
    expect(nodeHealth(base({ utilization: 0.7 }))).toBe("good");
    expect(nodeHealth(base({ status: "warning", utilization: 0.9 }))).toBe("strained");
    expect(nodeHealth(base({ status: "critical" }))).toBe("failing");
    expect(edgeHealth({ perSec: 50, errorRate: 0.2 }, base({}), false)).toBe("failing");
    expect(edgeHealth(undefined, base({}), true)).toBe("cut");
  });

  it("only suggests components you can add", () => {
    const db = base({ id: "db", kind: "database", status: "critical", errorRate: 0.3, utilization: 1 });
    const withCache = findings({ db }, { db: "Database" }, { db: "database" }, 0, ["cache", "server"]);
    expect(withCache[0].text).toMatch(/cache/);
    const fixed = findings({ db }, { db: "Database" }, { db: "database" }, 0, []);
    expect(fixed[0].text).not.toMatch(/cache|replica/);
    expect(fixed[0].text).toMatch(/connections/);
    expect(verdictOf({ db }, fixed)).toBe("failing");
  });
});
