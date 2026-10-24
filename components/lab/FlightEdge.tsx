"use client";

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { flightBus } from "@/lib/flightBus";
import type { Flight } from "@/engine/model/types";

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
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
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
      el.setAttribute("class", "flight-dot");
      el.setAttribute("fill", f.ok ? "var(--signal)" : "var(--crit)");
      el.setAttribute("opacity", f.dir === "back" && f.ok ? "0.45" : "0.95");
      g.appendChild(el);
      // Stagger dots that arrive in the same snapshot so they read as a stream.
      dots.current.push({ el, start: performance.now() + Math.random() * 90, back: f.dir === "back" });
      if (raf.current === null) raf.current = requestAnimationFrame(step);
    };

    const unsub = flightBus.subscribe(id, onFlight);
    return () => {
      unsub();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      dots.current.forEach((d) => d.el.remove());
      dots.current = [];
      raf.current = null;
    };
  }, [id]);

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: selected ? "var(--accent)" : "var(--line)", strokeWidth: selected ? 2.5 : 2 }}
      />
      <path ref={pathRef} d={path} fill="none" stroke="none" />
      <g ref={groupRef} pointerEvents="none" />
    </>
  );
}
