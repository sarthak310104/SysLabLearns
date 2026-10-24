import type { Flight } from "@/engine/model/types";

/**
 * Animation samples bypass React state: edges subscribe by id and draw
 * moving dots imperatively, so 10 snapshots a second never re-render the canvas.
 */
type Listener = (flight: Flight) => void;

const listeners = new Map<string, Set<Listener>>();

export const flightBus = {
  subscribe(edgeId: string, fn: Listener): () => void {
    let set = listeners.get(edgeId);
    if (!set) listeners.set(edgeId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  },
  emit(flights: Flight[]): void {
    for (const f of flights) listeners.get(f.edgeId)?.forEach((fn) => fn(f));
  },
};
