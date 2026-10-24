/// <reference lib="webworker" />
/**
 * Runs the simulation off the UI thread. The UI sends commands and receives
 * snapshots every 100ms of real time.
 */
import { Simulation } from "./model/simulation";
import type { AnyConfig, FaultAction, Graph, Snapshot } from "./model/types";

export type WorkerCommand =
  | { type: "load"; graph: Graph; seed: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "speed"; speed: number }
  | { type: "config"; nodeId: string; config: AnyConfig }
  | { type: "fault"; action: FaultAction };

export type WorkerMessage = { type: "snapshot"; snapshot: Snapshot; playing: boolean };

const TICK_MS = 50;

let sim: Simulation | null = null;
let playing = false;
let speed = 1;
let ticks = 0;

function post() {
  if (!sim) return;
  const msg: WorkerMessage = { type: "snapshot", snapshot: sim.snapshot(), playing };
  postMessage(msg);
}

setInterval(() => {
  if (!sim || !playing) return;
  sim.runUntil(sim.now + TICK_MS * speed);
  if (++ticks % 2 === 0) post();
}, TICK_MS);

onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  switch (cmd.type) {
    case "load":
      sim = new Simulation(cmd.graph, cmd.seed);
      post();
      break;
    case "play":
      playing = true;
      post();
      break;
    case "pause":
      playing = false;
      post();
      break;
    case "speed":
      speed = Math.max(0.25, Math.min(10, cmd.speed));
      break;
    case "config":
      sim?.updateConfig(cmd.nodeId, cmd.config);
      break;
    case "fault":
      sim?.applyFault(cmd.action);
      if (!playing) post();
      break;
  }
};
