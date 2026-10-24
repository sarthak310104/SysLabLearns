"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canConnect, defaultConfig, KIND_LABEL, withDefaults } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, Snapshot } from "@/engine/model/types";
import { GoalTracker, type Goal } from "@/lib/goals";
import { useSimulation } from "@/lib/useSimulation";
import { FlightEdge } from "./FlightEdge";
import { HealthPanel } from "./HealthPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { EventsMenu, ScenarioBanner } from "./EventsMenu";
import { scenariosFor, type Scenario } from "@/lib/scenarios";
import { Inspector, type SelectedLink } from "./Inspector";
import { LabNode, type LabFlowNode } from "./LabNode";
import { SnapshotContext } from "./LabContext";
import { DRAG_MIME, Palette } from "./Palette";
import { Toolbar } from "./Toolbar";

export const nodeTypes = { lab: LabNode };
export const edgeTypes = { flight: FlightEdge };
const EDGE_DEFAULTS = { type: "flight", markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)" } };

export interface GoalUpdate {
  fraction: number;
  done: boolean;
}

export interface LabProps {
  graph: Graph;
  /** Components that can be added. Empty means the layout is fixed. */
  palette: ComponentKind[];
  layout: "wide" | "compact";
  goals?: Goal[];
  completedGoals?: Set<string>;
  onGoalUpdate?: (goalId: string, u: GoalUpdate) => void;
  onGraphChange?: (g: Graph) => void;
  /** Called with every snapshot, for pages that show live status outside the lab. */
  onSnapshot?: (snap: Snapshot, graph: Graph) => void;
  seed?: number;
  /** Show the Events menu (traffic spikes, crashes, outages). */
  events?: boolean;
  /** Show a Share button; this is the picture's default title. */
  shareName?: string;
}

export function toFlow(graph: Graph): { nodes: LabFlowNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "lab",
      position: n.position,
      data: { kind: n.kind, label: n.label, config: withDefaults(n.kind, n.config), region: n.region },
    })),
    edges: graph.edges.map((e) => ({ ...EDGE_DEFAULTS, id: e.id, source: e.source, target: e.target })),
  };
}

function toGraph(nodes: LabFlowNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, kind: n.data.kind, label: n.data.label, config: n.data.config, position: n.position, ...(n.data.region ? { region: n.data.region } : {}) })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

let idCounter = 0;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function LabInner(props: LabProps) {
  const initial = useMemo(() => toFlow(props.graph), [props.graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<LabFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const rf = useReactFlow<LabFlowNode, Edge>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const editable = props.palette.length > 0;

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const sim = useSimulation(graph, props.seed);

  const { onGraphChange } = props;
  useEffect(() => {
    onGraphChange?.(graph);
  }, [graph, onGraphChange]);

  /* ---------------- goals ---------------- */
  const tracker = useRef<GoalTracker | null>(null);
  if (!tracker.current && props.goals) tracker.current = new GoalTracker(props.goals, props.completedGoals ?? []);
  const sentRef = useRef(new Map<string, number>());
  useEffect(() => {
    const snap = sim.snapshot;
    if (snap) props.onSnapshot?.(snap, graph);
    if (!snap || !tracker.current) return;
    for (const [id, p] of tracker.current.update(snap, graph)) {
      // Only report meaningful changes, so the lesson column doesn't re-render 10 times a second.
      const rounded = Math.round(p.fraction * 10) / 10;
      if (sentRef.current.get(id) !== rounded || p.done) {
        sentRef.current.set(id, rounded);
        props.onGoalUpdate?.(id, p);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.snapshot]);

  /* ---------------- editing ---------------- */
  const kindOf = useCallback((id: string) => nodes.find((n) => n.id === id)?.data.kind, [nodes]);

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      const a = kindOf(c.source);
      const b = kindOf(c.target);
      if (!a || !b || c.source === c.target) return false;
      if (edges.some((e) => e.source === c.source && e.target === c.target)) return false;
      return canConnect(a, b);
    },
    [kindOf, edges],
  );

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, ...EDGE_DEFAULTS, id: `e-${c.source}-${c.target}` }, es)),
    [setEdges],
  );

  const addNode = useCallback(
    (kind: ComponentKind, screen?: { x: number; y: number }) => {
      let pos = screen;
      if (!pos) {
        const r = wrapperRef.current?.getBoundingClientRect();
        pos = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 };
      }
      const position = rf.screenToFlowPosition(pos);
      setNodes((ns) => {
        const count = ns.filter((n) => n.data.kind === kind).length;
        const node: LabFlowNode = {
          id: newId(kind),
          type: "lab",
          position: { x: position.x - 88, y: position.y - 40 },
          data: { kind, label: `${KIND_LABEL[kind]} ${count + 1}`, config: defaultConfig(kind) as AnyConfig },
          selected: true,
        };
        return [...ns.map((n) => ({ ...n, selected: false })), node];
      });
    },
    [rf, setNodes],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DRAG_MIME) as ComponentKind;
      if (kind && props.palette.includes(kind)) addNode(kind, { x: e.clientX, y: e.clientY });
    },
    [addNode, props.palette],
  );

  const updateData = useCallback(
    (id: string, patch: Partial<LabFlowNode["data"]>) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes],
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setSelectedId(null);
    },
    [setNodes, setEdges],
  );

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const selectedLink: SelectedLink | null = useMemo(() => {
    const e = edges.find((x) => x.id === selectedEdgeId);
    if (!e) return null;
    const label = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
    const twin = edges.find((x) => x.source === e.target && x.target === e.source);
    const fromKind = kindOf(e.source);
    const toKind = kindOf(e.target);
    return {
      id: e.id,
      from: label(e.source),
      to: label(e.target),
      pairIds: twin ? [e.id, twin.id] : [e.id],
      replication: fromKind === "database" && (toKind === "replica" || toKind === "database"),
    };
  }, [edges, nodes, selectedEdgeId, kindOf]);

  const removeLink = useCallback(
    (id: string) => {
      setEdges((es) => es.filter((e) => e.id !== id));
      setSelectedEdgeId(null);
    },
    [setEdges],
  );
  const [sharing, setSharing] = useState(false);
  const scenarios = useMemo(() => scenariosFor(graph), [graph]);
  const restoreRef = useRef<Scenario["restore"]>([]);
  const runScenario = useCallback(
    (sc: Scenario) => {
      // Undo whatever the previous scenario left behind before starting the next.
      for (const a of restoreRef.current) sim.fault(a);
      restoreRef.current = sc.restore;
      sim.fault({ type: "scenario", name: sc.name, steps: sc.steps });
    },
    [sim],
  );
  const stopScenario = useCallback(() => {
    sim.fault({ type: "scenario", name: "", steps: [] });
    sim.fault({ type: "endScenario" });
    for (const a of restoreRef.current) sim.fault(a);
    restoreRef.current = [];
  }, [sim]);

  const wide = props.layout === "wide";
  const labels = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.data.label])), [nodes]);
  const kinds = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.data.kind])) as Record<string, ComponentKind>, [nodes]);

  const canvas = (
    <div ref={wrapperRef} className="relative flex-1 min-h-[320px]" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {/* Fill the box absolutely: in a stacked (phone) layout it has a min-height but no fixed height. */}
      <div className="absolute inset-0">
      <ReactFlow<LabFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes) =>
          onNodesChange(editable ? changes : changes.filter((c) => c.type !== "remove"))
        }
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => {
          setSelectedId(n.id);
          setSelectedEdgeId(null);
        }}
        onEdgeClick={(_, e) => {
          setSelectedEdgeId(e.id);
          setSelectedId(null);
        }}
        onPaneClick={() => {
          setSelectedId(null);
          setSelectedEdgeId(null);
        }}
        onNodesDelete={() => setSelectedId(null)}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.75}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      </div>
      {sim.snapshot?.scenario && (
        <ScenarioBanner name={sim.snapshot.scenario.name} remainingMs={sim.snapshot.scenario.remainingMs} loadFactor={sim.snapshot.loadFactor ?? 1} onStop={stopScenario} />
      )}
      <HealthPanel
        snapshot={sim.snapshot}
        labels={labels}
        kinds={kinds}
        defaultOpen={wide}
        canAdd={props.palette}
        graph={graph}
        onSelect={(id) => {
          setSelectedId(id);
          setSelectedEdgeId(null);
        }}
      />
    </div>
  );

  const inspector = (
    <Inspector
      graph={graph}
      selected={selected}
      selectedLink={selectedLink}
      snapshot={sim.snapshot}
      history={sim.history}
      incidents={sim.incidents}
      canDelete={editable}
      onConfig={(id, config) => updateData(id, { config })}
      onRename={(id, label) => updateData(id, { label })}
      onRegion={(id, region) => updateData(id, { region })}
      onFault={sim.fault}
      onDelete={removeNode}
      onDeleteLink={removeLink}
    />
  );

  const toolbar = (
    <Toolbar
      extra={
        <>
          {props.events && <EventsMenu scenarios={scenarios} onRun={runScenario} disabled={!sim.playing} />}
          {props.shareName && (
            <button className="px-2.5 py-1.5 rounded-md border border-line hover:border-accent text-[13px]" onClick={() => setSharing(true)}>
              Share
            </button>
          )}
        </>
      }
      playing={sim.playing}
      speed={sim.speed}
      time={sim.snapshot?.time ?? 0}
      onPlay={sim.play}
      onPause={sim.pause}
      onSpeed={sim.setSpeed}
      onReset={sim.reset}
    />
  );

  return (
    <SnapshotContext.Provider value={sim.snapshot}>
      {sharing && props.shareName && <ShareDialog name={props.shareName} graph={graph} snapshot={sim.snapshot} onClose={() => setSharing(false)} />}
      {wide ? (
        // Three columns on a wide screen; stacked like a lesson lab on narrow ones.
        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          <div className="hidden lg:flex">
            <Palette kinds={props.palette} onAdd={(k) => addNode(k)} layout="column" />
          </div>
          <div className="flex flex-col flex-1 min-w-0 min-h-[420px]">
            {toolbar}
            <div className="lg:hidden">
              <Palette kinds={props.palette} onAdd={(k) => addNode(k)} layout="row" />
            </div>
            {canvas}
          </div>
          <aside className="h-80 lg:h-auto lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-line bg-panel overflow-y-auto" aria-label="Inspector">
            {inspector}
          </aside>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {toolbar}
          <Palette kinds={props.palette} onAdd={(k) => addNode(k)} layout="row" />
          {canvas}
          <aside className="h-72 shrink-0 border-t border-line bg-panel overflow-y-auto" aria-label="Inspector">
            {inspector}
          </aside>
        </div>
      )}
    </SnapshotContext.Provider>
  );
}

export function Lab(props: LabProps) {
  return (
    <ReactFlowProvider>
      <LabInner {...props} />
    </ReactFlowProvider>
  );
}
