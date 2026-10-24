"use client";

/** Lets lesson text put a command into the terminal ("Try it" buttons). */
type Listener = (cmd: string) => void;
const listeners = new Set<Listener>();

export const awsBus = {
  insert(cmd: string) {
    for (const l of listeners) l(cmd);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
