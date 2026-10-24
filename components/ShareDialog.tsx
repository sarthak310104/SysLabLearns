"use client";

import { useEffect, useMemo, useState } from "react";
import type { Graph, Snapshot } from "@/engine/model/types";
import { animatedGif, animatedWebp, buildPicture, canEncodeWebp, download, fileSlug, pngBlob } from "@/lib/exportDesign";

/**
 * Share a design as a picture: the live state (health colors, traffic, stats)
 * frozen at the moment you press Share, with request dots still moving.
 */
export function ShareDialog({ name: initialName, graph, snapshot, onClose }: { name: string; graph: Graph; snapshot: Snapshot | null; onClose: () => void }) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [webp, setWebp] = useState<boolean | null>(null);
  // Freeze the run as it was when the dialog opened.
  const [frozen] = useState(snapshot);
  const pic = useMemo(() => buildPicture({ name, graph, snapshot: frozen }), [name, graph, frozen]);
  const previewUrl = useMemo(() => URL.createObjectURL(new Blob([pic.animated], { type: "image/svg+xml" })), [pic]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  useEffect(() => {
    canEncodeWebp().then(setWebp);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const done = (text: string) => {
    setBusy(null);
    setMsg({ ok: true, text });
  };
  const fail = (e: unknown) => {
    setBusy(null);
    setMsg({ ok: false, text: e instanceof Error ? e.message : "Something went wrong" });
  };
  const slug = fileSlug(name);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Share your design" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-4xl max-h-[92dvh] overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-line">
          <h2 className="font-semibold">Share your design</h2>
          <span className="flex-1" />
          <button className="text-muted hover:text-text" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="p-5">
          <label className="block text-[13px] text-muted mb-1" htmlFor="share-name">
            Title on the picture
          </label>
          <input id="share-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-line bg-panel-2 px-3 py-2 mb-4" />
          <div className="rounded-lg border border-line overflow-hidden bg-bg">
            {/* An <img> plays the SVG's animation, exactly as anyone you send it to will see it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt={`Animated picture of ${name}`} className="block max-w-full max-h-[52vh] w-auto h-auto mx-auto" />
          </div>
          <p className="text-[12px] text-muted mt-2">
            This is the run as it was when you pressed Share{frozen ? "" : " (not running yet: press Send traffic first to show live traffic)"}. Nothing is uploaded: the files are made in your browser.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button
              className="btn-accent rounded-md px-3 py-2 text-[14px]"
              disabled={Boolean(busy)}
              onClick={() => {
                download(new Blob([pic.animated], { type: "image/svg+xml" }), `${slug}.svg`);
                done("Saved an animated SVG. It plays in any browser.");
              }}
            >
              Download animated SVG
            </button>
            <button
              className="ctl px-3 py-2 text-[14px]"
              disabled={Boolean(busy) || webp === null}
              onClick={async () => {
                setMsg(null);
                setBusy("Making the animation: 0%");
                try {
                  const onProgress = (f: number) => setBusy(`Making the animation: ${Math.round(f * 100)}%`);
                  if (webp) {
                    download(await animatedWebp(pic, { onProgress }), `${slug}.webp`);
                    done("Saved an animated WebP. It works in WhatsApp, Slack, Notion and most apps.");
                  } else {
                    download(await animatedGif(pic, { onProgress }), `${slug}.gif`);
                    done("This browser can't make WebP, so you got an animated GIF instead.");
                  }
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {webp === false ? "Download animated GIF" : "Download animated WebP"}
            </button>
            <button
              className="ctl px-3 py-2 text-[14px]"
              disabled={Boolean(busy)}
              onClick={async () => {
                setMsg(null);
                try {
                  const blob = await pngBlob(pic);
                  if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
                    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                    done("Copied a still image. Paste it anywhere.");
                  } else {
                    download(blob, `${slug}.png`);
                    done("Your browser can't copy images, so it was downloaded as a PNG.");
                  }
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Copy still image
            </button>
            <button className="text-[13px] text-muted hover:text-text px-2" disabled={Boolean(busy)} onClick={async () => download(await pngBlob(pic), `${slug}.png`)}>
              Download PNG
            </button>
          </div>
          {busy && <p className="mt-3 text-[13px] text-muted num">{busy}</p>}
          {msg && (
            <p className="mt-3 text-[13px]" style={{ color: msg.ok ? "var(--h-good)" : "var(--h-failing)" }}>
              {msg.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
