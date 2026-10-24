"use client";

/** Lets lesson text talk to the practice account: put a command in the terminal, or save a file. */
type Listener = (cmd: string) => void;
type FileListener = (name: string, content: string) => void;
const listeners = new Set<Listener>();
const fileListeners = new Set<FileListener>();

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
  saveFile(name: string, content: string) {
    for (const l of fileListeners) l(name, content);
  },
  onSaveFile(l: FileListener) {
    fileListeners.add(l);
    return () => {
      fileListeners.delete(l);
    };
  },
  /** True when a practice account is on the page to receive files. */
  hasAccount: () => fileListeners.size > 0,
};
