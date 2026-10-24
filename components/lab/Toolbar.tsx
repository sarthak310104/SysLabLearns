"use client";

import { fmtTime } from "./format";

const SPEEDS = [1, 2, 5];

export function Toolbar(props: {
  playing: boolean;
  speed: number;
  time: number;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (s: number) => void;
  onReset: () => void;
  /** Extra controls, such as the Events menu. */
  extra?: React.ReactNode;
}) {
  const { playing, speed, time } = props;
  return (
    <div className="flex items-center gap-2 px-3 h-11 border-b border-line bg-panel text-[13px]">
      <button
        onClick={playing ? props.onPause : props.onPlay}
        className={`px-3.5 py-1.5 rounded-md font-medium min-w-[92px] ${playing ? "bg-panel-2 text-text" : "bg-accent text-accent-ink neon"}`}
      >
        {playing ? "Pause" : "Send traffic"}
      </button>
      <div className="flex rounded-md border border-line overflow-hidden" role="group" aria-label="Simulation speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => props.onSpeed(s)}
            aria-pressed={speed === s}
            className={`px-2.5 py-1.5 num ${speed === s ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
          >
            {s}x
          </button>
        ))}
      </div>
      <button onClick={props.onReset} className="px-2.5 py-1.5 rounded-md text-muted hover:text-text">
        Restart
      </button>
      {props.extra}
      <span className="ml-auto num text-muted" aria-label="Simulated time">
        {fmtTime(time)}
      </span>
    </div>
  );
}
