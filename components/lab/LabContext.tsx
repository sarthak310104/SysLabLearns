"use client";

import { createContext, useContext } from "react";
import type { Snapshot } from "@/engine/model/types";

export const SnapshotContext = createContext<Snapshot | null>(null);
export const useSnapshot = () => useContext(SnapshotContext);
