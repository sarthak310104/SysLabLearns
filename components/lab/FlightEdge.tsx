"use client";

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useContext, useEffect, useRef } from "react";
import { flightBus } from "@/lib/flightBus";
import type { Flight } from "@/engine/model/types";
import { FlightNsContext, useSnapshot } from "./LabContext";
import { edgeHealth, edgeWidth, HEALTH_COLOR, HEALTH_LABEL, type Health } from "@/lib/health";

const DURATION_MS = 750;
const MAX_DOTS = 24;
const SVG_NS = "http://www.w3.org/2000/svg";

interface Dot {
  el: SVGCircleElement;
  start: number;
  back: boolean;
}

/**
 * An edge that draws sampled requests as dots travelling along it.
 * Dots are created and moved imperatively, outside React, for smooth animation.
 */
export function FlightEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const snap = useSnapshot();
  const ns = useContext(FlightNsContext);
  const isCut = snap?.cutEdges.includes(id) ?? false;
  const traffic = snap?.edges?.[id];
  const health = edgeHealth(traffic, snap?.nodes[target], isCut);
  const color = HEALTH_COLOR[health];
  const width = edgeWidth(traffic?.perSec ?? 0);
  // The dots read the latest color without restarting the animation loop.
  const colorRef = useRef<{ color: string; health: Health }>({ color, health });
  colorRef.current = { color, health };
  void source;
  const pathRef = useRef<SVGPathElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const dots = useRef<Dot[]>([]);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const step = () => {
      const p = pathRef.current;
      if (!p) return;
      const len = p.getTotalLength();
      const now = performance.now();
      dots.current = dots.current.filter((d) => {
        const t = (now - d.start) / DURATION_MS;
        if (t >= 1) {
          d.el.remove();
          return false;
        }
        const pt = p.getPointAtLength(len * (d.back ? 1 - t : t));
        d.el.setAttribute("cx", String(pt.x));
        d.el.setAttribute("cy", String(pt.y));
        return true;
      });
      raf.current = dots.current.length ? requestAnimationFrame(step) : null;
    };

    const onFlight = (f: Flight) => {
      const g = groupRef.current;
      if (!g || dots.current.length >= MAX_DOTS) return;
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("r", f.ok ? "3" : "3.5");
      el.setAttribute("class", f.ok ? "flight-dot" : "flight-dot err");
      const c = colorRef.current;
      const fill = f.ok ? (c.health === "idle" ? "var(--h-ideal)" : c.color) : "var(--h-failing)";
      el.setAttribute("fill", fill);
      el.style.color = fill;
      el.setAttribute("opacity", f.dir === "back" && f.ok ? "0.45" : "0.95");
      g.appendChild(el);
      // Stagger dots that arrive in the same snapshot so they read as a stream.
      dots.current.push({ el, start: performance.now() + Math.random() * 90, back: f.dir === "back" });
      if (raf.current === null) raf.current = requestAnimationFrame(step);
    };

    const unsub = flightBus.subscribe(ns + id, onFlight);
    return () => {
      unsub();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      dots.current.forEach((d) => d.el.remove());
      dots.current = [];
      raf.current = null;
    };
  }, [id, ns]);

  return (
    <>
      <defs>
        <marker id={`arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={color} />
        </marker>
      </defs>
      {selected && <path d={path} fill="none" stroke="var(--text)" strokeOpacity={0.35} strokeWidth={width + 5} strokeLinecap="round" />}
      <BaseEdge
        path={path}
        markerEnd={`url(#arrow-${id})`}
        interactionWidth={18}
        className={health === "failing" || health === "down" ? "edge-failing" : undefined}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeDasharray: isCut ? "6 6" : undefined,
          transition: "stroke 300ms, stroke-width 300ms",
        }}
      >
        <title>{HEALTH_LABEL[health]}</title>
      </BaseEdge>
      <path ref={pathRef} d={path} fill="none" stroke="none" />
      <g ref={groupRef} pointerEvents="none" />
      {isCut && (
        <g transform={`translate(${labelX}, ${labelY})`} pointerEvents="none">
          <rect x={-18} y={-10} width={36} height={20} rx={4} fill="var(--panel)" stroke="var(--h-failing)" />
          <text textAnchor="middle" dy="4" fontSize="11" fill="var(--h-failing)">
            Cut
          </text>
        </g>
      )}
    </>
  );
}
