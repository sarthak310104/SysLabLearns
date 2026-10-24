"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lab } from "@/components/lab/Lab";
import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, Graph } from "@/engine/model/types";
import { loadDesign, saveDesign } from "@/lib/progress";
import { VersionsMenu } from "@/components/VersionsMenu";

const DESIGN_ID = "sandbox";

const STARTER: Graph = {
  nodes: [
    { id: "users", kind: "client", label: "Users", position: { x: 0, y: 60 }, config: { ...defaultConfig("client"), rps: 80 } as AnyConfig },
    { id: "server-1", kind: "server", label: "Server 1", position: { x: 300, y: 40 }, config: defaultConfig("server") as AnyConfig },
  ],
  edges: [{ id: "e-users-server-1", source: "users", target: "server-1" }],
};

/** Free play: every component available, design saved in your browser. */
export function SandboxView() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [version, setVersion] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Graph | null>(null);

  useEffect(() => {
    loadDesign(DESIGN_ID).then((g) => setGraph(g ?? STARTER));
  }, []);

  const onGraphChange = useCallback((g: Graph) => {
    latest.current = g;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveDesign(DESIGN_ID, "Sandbox", g), 600);
  }, []);

  if (!graph) return null;
  return (
    <div className="flex flex-col flex-1 min-h-0 lg:h-[calc(100dvh-3rem)]">
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line text-[13px]">
        <span className="text-muted truncate">Your design saves automatically in this browser.</span>
        <span className="ml-auto" />
        <VersionsMenu
          current={() => latest.current ?? graph}
          onOpen={(g) => {
            saveDesign(DESIGN_ID, "Sandbox", g);
            setGraph(g);
            setVersion((v) => v + 1);
          }}
        />
        <button
          className="text-muted hover:text-text"
          onClick={() => {
            saveDesign(DESIGN_ID, "Sandbox", STARTER);
            setGraph(STARTER);
            setVersion((v) => v + 1);
          }}
        >
          Start over
        </button>
      </div>
      <Lab
        key={version}
        graph={graph}
        palette={["client", "loadBalancer", "server", "cache", "database", "replica", "queue"]}
        layout="wide"
        events
        shareName="My system design"
        onGraphChange={onGraphChange}
      />
    </div>
  );
}
