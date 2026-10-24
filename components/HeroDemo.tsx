"use client";

import { Background, BackgroundVariant, MarkerType, ReactFlow, ReactFlowProvider, type Edge } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph } from "@/engine/model/types";
import { useSimulation } from "@/lib/useSimulation";
import { FlightEdge } from "./lab/FlightEdge";
import { SnapshotContext } from "./lab/LabContext";
import { LabNode, type LabFlowNode } from "./lab/LabNode";

const node = (id: string, kind: ComponentKind, label: string, x: number, y: number, cfg: Partial<AnyConfig> = {}) => ({
  id,
  kind,
  label,
  position: { x, y },
  config: { ...defaultConfig(kind), ...cfg } as AnyConfig,
});

// Spiky traffic into a balanced pair of servers: calm most of the time, strained every ten seconds.
const DEMO: Graph = {
  nodes: [
    node("users", "client", "Users", 0, 95, { rps: 110, pattern: "spike" }),
    node("lb", "loadBalancer", "Load balancer", 270, 95, { strategy: "leastConnections" }),
    node("s1", "server", "Server 1", 540, 0, { workers: 6 }),
    node("s2", "server", "Server 2", 540, 190, { workers: 6 }),
  ],
  edges: [
    { id: "d1", source: "users", target: "lb" },
    { id: "d2", source: "lb", target: "s1" },
    { id: "d3", source: "lb", target: "s2" },
  ],
};

const nodeTypes = { lab: LabNode };
const edgeTypes = { flight: FlightEdge };

function Demo() {
  const sim = useSimulation(DEMO, 3);
  const { play } = sim;
  useEffect(() => {
    play();
  }, [play]);

  const nodes: LabFlowNode[] = useMemo(
    () => DEMO.nodes.map((n) => ({ id: n.id, type: "lab", position: n.position, data: { kind: n.kind, label: n.label, config: n.config } })),
    [],
  );
  const edges: Edge[] = useMemo(
    () => DEMO.edges.map((e) => ({ ...e, type: "flight", markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)" } })),
    [],
  );

  return (
    <SnapshotContext.Provider value={sim.snapshot}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid)" />
      </ReactFlow>
    </SnapshotContext.Provider>
  );
}

export function HeroDemo() {
  return (
    <div className="h-[300px] sm:h-[340px] rounded-lg border border-line overflow-hidden" aria-label="Live simulation of traffic flowing through a load balancer to two servers">
      <ReactFlowProvider>
        <Demo />
      </ReactFlowProvider>
    </div>
  );
}
