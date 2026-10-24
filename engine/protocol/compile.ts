import { transform } from "sucrase";

export interface Compiled {
  exports: Record<string, unknown> | null;
  error: string | null;
}

const blocked = (what: string, instead: string) => () => {
  throw new Error(`${what} isn't available here: ${instead}`);
};

/**
 * Turns the learner's TypeScript into a module. Anything that would make runs
 * unrepeatable (wall-clock time, real randomness, real timers, the network)
 * is blocked, with a message saying what to use instead.
 */
export function compileUserCode(source: string): Compiled {
  let js: string;
  try {
    js = transform(source, { transforms: ["typescript", "imports"], production: true }).code;
  } catch (e) {
    return { exports: null, error: `Couldn't read your code: ${e instanceof Error ? e.message : String(e)}` };
  }
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const SafeMath = Object.create(Math) as Math;
  Object.defineProperty(SafeMath, "random", { value: blocked("Math.random", "use ctx.random() so every run can be replayed.") });
  const NoDate = function () {
    throw new Error("Date isn't available here: the simulation has its own clock. Use timers instead.");
  } as unknown as DateConstructor;
  (NoDate as unknown as { now: () => never }).now = blocked("Date.now", "the simulation has its own clock. Use timers instead.");
  try {
    const run = new Function(
      "exports",
      "module",
      "require",
      "Math",
      "Date",
      "setTimeout",
      "setInterval",
      "fetch",
      "performance",
      `"use strict";\n${js}`,
    );
    run(
      exports,
      module,
      blocked("require", "everything has to be in this one file."),
      SafeMath,
      NoDate,
      blocked("setTimeout", "use ctx.setTimer(name, ms) instead."),
      blocked("setInterval", "use ctx.setTimer(name, ms) instead."),
      blocked("fetch", "nodes can only talk with ctx.send()."),
      { now: blocked("performance.now", "the simulation has its own clock.") },
    );
  } catch (e) {
    return { exports: null, error: `Your code failed while loading: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { exports: module.exports as Record<string, unknown>, error: null };
}
