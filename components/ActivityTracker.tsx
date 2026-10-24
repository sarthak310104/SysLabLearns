"use client";

import { useEffect } from "react";
import { bumpActivity } from "@/lib/progress";

/**
 * Counts active minutes: a minute counts when the tab is visible and you've
 * clicked, typed or scrolled in it during that minute. Leaving a tab open
 * overnight doesn't count as studying.
 */
export function ActivityTracker() {
  useEffect(() => {
    let last = 0;
    const touch = () => {
      last = Date.now();
    };
    const evs = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - last < 60000) bumpActivity({ minutes: 1 });
    }, 60000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
    };
  }, []);
  return null;
}
