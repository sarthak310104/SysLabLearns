"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerCommand, WorkerMessage } from "@/engine/worker";
import type { FaultAction, Graph, Incident, Snapshot } from "@/engine/model/types";
import { flightBus } from "./flightBus";

export interface HistoryPoint {
  t: number;
  ok: number;
  err: number;
  p99: number;
  util: number;
}

const HISTORY_POINTS = 150; // 15 seconds at 10 snapshots/s
const MAX_INCIDENTS = 30;

/** Structural identity of a graph: changing it restarts the simulation. */
function structureKey(g: Graph): string {
  const nodes = g.nodes.map((n) => `${n.id}:${n.kind}:${n.label}:${n.region ?? ""}`).sort();
  const edges = g.edges.map((e) => `${e.source}>${e.target}`).sort();
  return nodes.join(",") + "|" + edges.join(",");
}

/**
 * Drives the engine worker for a graph. Structural edits restart the run;
 * config edits apply live, so you can turn a knob and watch the effect.
 */
export function useSimulation(graph: Graph, seed = 42, ns = "") {
  const workerRef = useRef<Worker | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const historyRef = useRef(new Map<string, HistoryPoint[]>());
  const lastStructure = useRef<string>("");
  const lastConfigs = useRef(new Map<string, string>());
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const wantPlaying = useRef(false);

  const send = useCallback((cmd: WorkerCommand) => workerRef.current?.postMessage(cmd), []);

  const load = useCallback(
    (g: Graph) => {
      historyRef.current = new Map();
      setIncidents([]);
      lastStructure.current = structureKey(g);
      lastConfigs.current = new Map(g.nodes.map((n) => [n.id, JSON.stringify(n.config)]));
      send({ type: "load", graph: g, seed });
      if (wantPlaying.current) send({ type: "play" });
    },
    [send, seed],
  );

  useEffect(() => {
    // Bundled by `npm run worker` (esbuild) before dev and build; see package.json.
    const worker = new Worker("/engine-worker.js", { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const { snapshot: snap, playing: isPlaying } = e.data;
      flightBus.emit(snap.flights, ns);
      for (const s of Object.values(snap.nodes)) {
        let h = historyRef.current.get(s.id);
        if (!h) historyRef.current.set(s.id, (h = []));
        h.push({ t: snap.time, ok: s.okPerSec, err: s.errorsPerSec, p99: s.p99, util: s.utilization });
        if (h.length > HISTORY_POINTS) h.shift();
      }
      if (snap.incidents.length) setIncidents((prev) => [...snap.incidents.reverse(), ...prev].slice(0, MAX_INCIDENTS));
      setSnapshot(snap);
      setPlaying(isPlaying);
    };
    load(graphRef.current);
    return () => worker.terminate();
  }, [load]);

  // React to graph edits.
  useEffect(() => {
    if (!workerRef.current) return;
    if (structureKey(graph) !== lastStructure.current) {
      // Edits apply to the running system; only Restart starts from scratch.
      lastStructure.current = structureKey(graph);
      lastConfigs.current = new Map(graph.nodes.map((n) => [n.id, JSON.stringify(n.config)]));
      send({ type: "graph", graph });
      return;
    }
    for (const n of graph.nodes) {
      const cfg = JSON.stringify(n.config);
      if (lastConfigs.current.get(n.id) !== cfg) {
        lastConfigs.current.set(n.id, cfg);
        send({ type: "config", nodeId: n.id, config: n.config });
      }
    }
  }, [graph, load, send]);

  return {
    snapshot,
    playing,
    speed,
    incidents,
    history: historyRef.current,
    play: () => {
      wantPlaying.current = true;
      send({ type: "play" });
    },
    pause: () => {
      wantPlaying.current = false;
      send({ type: "pause" });
    },
    setSpeed: (s: number) => {
      setSpeedState(s);
      send({ type: "speed", speed: s });
    },
    reset: () => load(graphRef.current),
    fault: (action: FaultAction) => send({ type: "fault", action }),
  };
}

export type SimulationHandle = ReturnType<typeof useSimulation>;
