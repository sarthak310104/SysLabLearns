import type { ComponentKind, Graph, NodeStats, Snapshot } from "@/engine/model/types";
import { edgeHealth, edgeWidth, findings, nodeHealth, verdictOf, type Health } from "./health";
import { fmtDollars, monthlyCost } from "./cost";

/*
 * Turns a design and its live run into a picture you can share: an animated
 * SVG (requests travel along the links), a still PNG, or an animated WebP or
 * GIF made from rendered frames. Everything happens in the browser.
 */

const NODE_W = 176;
const PERIOD = 1.5; // seconds for a request dot to cross a link
const LOOP = 3; // the animation repeats every 3 seconds (a multiple of PERIOD)

const GLYPH: Record<ComponentKind, string> = {
  client: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="14" r="2"/><path d="M9 6h7M9 14h7M14 4l2 2-2 2M14 12l2 2-2 2"/>',
  loadBalancer: '<circle cx="4" cy="10" r="2"/><path d="M6 10h3M9 10l7-6M9 10h7M9 10l7 6"/>',
  server: '<rect x="3" y="3" width="14" height="6" rx="1.5"/><rect x="3" y="11" width="14" height="6" rx="1.5"/>',
  cache: '<path d="M11 2 4 11h5l-1 7 7-9h-5l1-7Z"/>',
  database: '<ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  replica: '<ellipse cx="10" cy="5" rx="6" ry="2.5" stroke-dasharray="2 2"/><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5" stroke-dasharray="2 2"/><path d="M8 11l2 2 2-2"/>',
  queue: '<rect x="2.5" y="6" width="4" height="8" rx="1"/><rect x="8" y="6" width="4" height="8" rx="1"/><rect x="13.5" y="6" width="4" height="8" rx="1"/>',
};

interface Palette {
  bg: string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  ideal: string;
  good: string;
  strained: string;
  failing: string;
  accent: string;
}

/** The current theme's colors, read from the page, so the picture matches what you see. */
export function themePalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    bg: v("--bg", "#050507"),
    panel: v("--panel", "#0c0c11"),
    line: v("--line", "#26262f"),
    text: v("--text", "#f3f2f5"),
    muted: v("--muted", "#8c8a97"),
    ideal: v("--h-ideal", "#3d8bff"),
    good: v("--h-good", "#2fd27a"),
    strained: v("--h-strained", "#ffd23f"),
    failing: v("--h-failing", "#ff3b3b"),
    accent: v("--accent", "#ff1f4b"),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rate = (n: number) => (n >= 100 ? `${Math.round(n)}/s` : `${n.toFixed(1)}/s`);
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const pct = (n: number) => `${(n * 100).toFixed(n > 0.999 || n < 0.001 ? 0 : 1)}%`;

function metrics(kind: ComponentKind, s: NodeStats | undefined): { label: string; value: string; warn?: boolean }[] {
  if (!s) return [{ label: "Not running", value: "" }];
  if (s.down) return [{ label: "Down: refusing requests", value: "", warn: true }];
  if (kind === "client") {
    const total = s.okPerSec + s.errorsPerSec;
    return [
      { label: "Sending", value: rate(s.sendingRps ?? 0) },
      { label: "Succeeding", value: pct(total ? s.okPerSec / total : 1), warn: s.errorRate > 0.01 },
      { label: "Slowest 1%", value: ms(s.p99) },
    ];
  }
  if (kind === "loadBalancer") return [
    { label: "Passing", value: rate(s.okPerSec) },
    { label: "Errors", value: rate(s.errorsPerSec), warn: s.errorRate > 0.01 },
  ];
  if (kind === "cache") return [
    { label: "Hit ratio", value: pct(s.hitRatio ?? 0) },
    { label: "Serving", value: rate(s.okPerSec) },
  ];
  if (kind === "queue") return [
    { label: "Waiting", value: String(s.queue), warn: s.queueLimit ? s.queue / s.queueLimit > 0.8 : false },
    { label: "Processed", value: rate(s.processedPerSec ?? 0) },
  ];
  return [
    { label: "Busy", value: `${s.busy}/${s.workers}`, warn: s.utilization > 0.95 },
    { label: "Queue", value: `${s.queue}/${s.queueLimit}`, warn: s.queueLimit ? s.queue / s.queueLimit > 0.8 : false },
    { label: "Rejecting", value: rate(s.errorsPerSec), warn: s.errorRate > 0.05 },
  ];
}

interface Laid {
  id: string;
  kind: ComponentKind;
  label: string;
  x: number;
  y: number;
  h: number;
  health: Health;
  stats?: NodeStats;
}

interface LaidEdge {
  id: string;
  d: string;
  pts: [number, number][];
  color: string;
  width: number;
  health: Health;
  dots: number;
  errDots: number;
  marching: boolean;
}

function colorOf(h: Health, p: Palette): string {
  return { idle: p.line, ideal: p.ideal, good: p.good, strained: p.strained, failing: p.failing, down: p.failing, cut: p.failing }[h];
}

/** React Flow's bezier between a right-hand handle and a left-hand handle. */
function bezier(sx: number, sy: number, tx: number, ty: number) {
  const off = (d: number) => (d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d));
  const c1: [number, number] = [sx + off(tx - sx), sy];
  const c2: [number, number] = [tx - off(tx - sx), ty];
  const at = (t: number): [number, number] => {
    const u = 1 - t;
    return [u * u * u * sx + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * tx, u * u * u * sy + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * ty];
  };
  const pts = Array.from({ length: 41 }, (_, i) => at(i / 40));
  return { d: `M${sx},${sy} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${tx},${ty}`, pts };
}

function pointAt(pts: [number, number][], f: number): [number, number] {
  const x = Math.max(0, Math.min(1, f)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(x));
  const k = x - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
}

export interface ExportInput {
  name: string;
  graph: Graph;
  snapshot: Snapshot | null;
}

export interface Picture {
  width: number;
  height: number;
  /** Animated (SMIL) SVG, for browsers. */
  animated: string;
  /** One still frame at time t (seconds), for rasterising. */
  frame: (t: number) => string;
}

/** Lay out the design and build the picture. */
export function buildPicture({ name, graph, snapshot }: ExportInput, p: Palette = themePalette()): Picture {
  const snap = snapshot;
  const nodes: Laid[] = graph.nodes.map((n) => {
    const s = snap?.nodes[n.id];
    const rows = metrics(n.kind, s).length;
    const pool = n.kind === "server" || n.kind === "database" || n.kind === "replica";
    return { id: n.id, kind: n.kind, label: n.label, x: n.position.x, y: n.position.y, h: 40 + rows * 17 + (pool ? 10 : 2), health: nodeHealth(s), stats: s };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Fit everything inside a frame with room for the caption.
  const minX = Math.min(...nodes.map((n) => n.x)) - 40;
  const minY = Math.min(...nodes.map((n) => n.y)) - 40;
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W)) + 40;
  const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + 30;
  const CAPTION = 74;
  const FOOT = 26;
  const width = Math.max(560, Math.round(maxX - minX));
  const extraX = (width - (maxX - minX)) / 2;
  const height = Math.round(maxY - minY + CAPTION + FOOT);
  const ox = -minX + extraX;
  const oy = -minY + CAPTION;

  const edges: LaidEdge[] = graph.edges.flatMap((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) return [];
    const sx = a.x + NODE_W + ox;
    const sy = a.y + a.h / 2 + oy;
    const tx = b.x + ox - 6;
    const ty = b.y + b.h / 2 + oy;
    const { d, pts } = bezier(sx, sy, tx, ty);
    const traffic = snap?.edges?.[e.id];
    const cut = snap?.cutEdges.includes(e.id) ?? false;
    const health = edgeHealth(traffic, snap?.nodes[e.target], cut);
    const per = traffic?.perSec ?? 0;
    const dots = per > 0 && !cut ? Math.max(1, Math.min(5, Math.round(Math.log2(per + 1) / 1.6))) : 0;
    const errDots = dots && (traffic?.errorRate ?? 0) > 0.05 ? Math.max(1, Math.round(dots * Math.min(1, traffic!.errorRate * 1.5))) : 0;
    return [{ id: e.id, d, pts, color: colorOf(health, p), width: edgeWidth(per), health, dots, errDots, marching: health === "failing" || health === "down" || cut }];
  });

  // Caption: name, verdict, headline numbers.
  const clients = Object.values(snap?.nodes ?? {}).filter((s) => s.kind === "client");
  const ok = clients.reduce((x, c) => x + c.okPerSec, 0);
  const err = clients.reduce((x, c) => x + c.errorsPerSec, 0);
  const sending = clients.reduce((x, c) => x + (c.sendingRps ?? 0), 0);
  const p99 = Math.max(0, ...clients.map((c) => c.p99));
  const labels = Object.fromEntries(graph.nodes.map((n) => [n.id, n.label]));
  const kinds = Object.fromEntries(graph.nodes.map((n) => [n.id, n.kind]));
  const verdict = snap ? verdictOf(snap.nodes, findings(snap.nodes, labels, kinds, snap.cutEdges.length)) : "idle";
  const vText = { idle: "Not running", healthy: "Healthy", improve: "Could be better", failing: "Failing" }[verdict];
  const vColor = { idle: p.muted, healthy: p.good, improve: p.strained, failing: p.failing }[verdict];
  const cost = monthlyCost(graph, snap).total;
  const stats = snap
    ? `${Math.round(sending)} req/s sent · ${pct(ok + err ? ok / (ok + err) : 1)} succeed · slowest 1% ${ms(p99)} · ${fmtDollars(cost)}/month`
    : `${graph.nodes.length} components · ${fmtDollars(cost)}/month`;

  const font = `font-family="IBM Plex Sans, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`;
  const mono = `font-family="IBM Plex Mono, Consolas, 'SFMono-Regular', Menlo, monospace"`;

  const nodeSvg = (n: Laid) => {
    const x = n.x + ox;
    const y = n.y + oy;
    const c = n.health === "idle" ? p.line : colorOf(n.health, p);
    const rows = metrics(n.kind, n.stats);
    const pool = n.kind === "server" || n.kind === "database" || n.kind === "replica";
    const util = n.stats?.utilization ?? 0;
    const glow = n.health === "failing" || n.health === "down" ? `<rect x="${x - 3}" y="${y - 3}" width="${NODE_W + 6}" height="${n.h + 6}" rx="11" fill="none" stroke="${p.failing}" stroke-opacity="0.25" stroke-width="4"/>` : "";
    return `${glow}<g>
<rect x="${x}" y="${y}" width="${NODE_W}" height="${n.h}" rx="8" fill="${p.panel}" stroke="${c}" stroke-width="2"${n.stats?.down ? ' stroke-dasharray="5 4"' : ""}/>
<svg x="${x + 12}" y="${y + 11}" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="${n.health === "idle" ? p.muted : c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${GLYPH[n.kind]}</svg>
<text x="${x + 36}" y="${y + 24}" ${font} font-size="13" font-weight="600" fill="${p.text}">${esc(n.label.length > 18 ? n.label.slice(0, 17) + "…" : n.label)}</text>
${rows
  .map(
    (r, i) =>
      `<text x="${x + 12}" y="${y + 46 + i * 17}" ${font} font-size="11" fill="${r.warn && !r.value ? p.failing : p.muted}">${esc(r.label)}</text>` +
      (r.value ? `<text x="${x + NODE_W - 12}" y="${y + 46 + i * 17}" text-anchor="end" ${mono} font-size="11" fill="${r.warn ? p.failing : p.text}">${esc(r.value)}</text>` : ""),
  )
  .join("\n")}
${pool ? `<rect x="${x + 12}" y="${y + n.h - 12}" width="${NODE_W - 24}" height="3" rx="1.5" fill="${p.line}"/><rect x="${x + 12}" y="${y + n.h - 12}" width="${Math.max(0, Math.min(1, util)) * (NODE_W - 24)}" height="3" rx="1.5" fill="${c}"/>` : ""}
</g>`;
  };

  const header = `<rect width="${width}" height="${height}" fill="${p.bg}"/>
<text x="24" y="34" ${font} font-size="18" font-weight="600" fill="${p.text}">${esc(name)}</text>
<circle cx="${width - 24 - 8 - vText.length * 7.2}" cy="29" r="5" fill="${vColor}"/>
<text x="${width - 24}" y="34" text-anchor="end" ${font} font-size="14" font-weight="600" fill="${vColor}">${vText}</text>
<text x="24" y="56" ${font} font-size="12" fill="${p.muted}">${esc(stats)}</text>
<line x1="24" x2="${width - 24}" y1="${CAPTION - 8}" y2="${CAPTION - 8}" stroke="${p.line}"/>`;
  const footer = `<text x="${width - 24}" y="${height - 10}" text-anchor="end" ${font} font-size="11" fill="${p.muted}">Made with SysLabLearns · blue: room to spare · green: healthy · yellow: near a limit · red: failing</text>`;

  const arrow = (e: LaidEdge) => {
    const [ex, ey] = e.pts[e.pts.length - 1];
    return `<path d="M${ex + 6},${ey} l-9,-5 v10 z" fill="${e.color}"/>`;
  };

  const animated = () => {
    const edgeSvg = edges
      .map((e) => {
        const march = e.marching ? `<animate attributeName="stroke-dashoffset" from="0" to="-24" dur="0.8s" repeatCount="indefinite"/>` : "";
        const line = `<path d="${e.d}" fill="none" stroke="${e.color}" stroke-width="${e.width.toFixed(1)}"${e.marching ? ' stroke-dasharray="8 4"' : ""}>${march}</path>${arrow(e)}`;
        const dots = Array.from({ length: e.dots }, (_, k) => {
          const errDot = k < e.errDots;
          const begin = -((k / e.dots) * PERIOD);
          return `<circle r="3.2" fill="${errDot ? p.failing : e.color}"><animateMotion dur="${PERIOD}s" begin="${begin.toFixed(3)}s" repeatCount="indefinite" path="${e.d}"/></circle>`;
        }).join("");
        const back = Array.from({ length: Math.ceil(e.dots / 2) }, (_, k) => {
          const begin = -((k / Math.ceil(e.dots / 2)) * PERIOD + PERIOD / 3);
          return `<circle r="2.6" fill="${e.color}" opacity="0.45"><animateMotion dur="${PERIOD}s" begin="${begin.toFixed(3)}s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path="${e.d}"/></circle>`;
        }).join("");
        return line + dots + back;
      })
      .join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<title>${esc(name)}: ${vText}</title>
${header}
${edgeSvg}
${nodes.map(nodeSvg).join("\n")}
${footer}
</svg>`;
  };

  const frame = (t: number) => {
    const edgeSvg = edges
      .map((e) => {
        const off = e.marching ? -(((t / 0.8) * 24) % 24) : 0;
        const line = `<path d="${e.d}" fill="none" stroke="${e.color}" stroke-width="${e.width.toFixed(1)}"${e.marching ? ` stroke-dasharray="8 4" stroke-dashoffset="${off.toFixed(2)}"` : ""}/>${arrow(e)}`;
        const fwd = Array.from({ length: e.dots }, (_, k) => {
          const [x, y] = pointAt(e.pts, (t / PERIOD + k / e.dots) % 1);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${k < e.errDots ? p.failing : e.color}"/>`;
        }).join("");
        const nb = Math.ceil(e.dots / 2);
        const back = Array.from({ length: nb }, (_, k) => {
          const [x, y] = pointAt(e.pts, 1 - ((t / PERIOD + k / nb + 1 / 3) % 1));
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${e.color}" opacity="0.45"/>`;
        }).join("");
        return line + fwd + back;
      })
      .join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${header}
${edgeSvg}
${nodes.map(nodeSvg).join("\n")}
${footer}
</svg>`;
  };

  return { width, height, animated: animated(), frame };
}

/* ------------------------------------------------------------------ */
/* Rasterising and encoding                                            */
/* ------------------------------------------------------------------ */

async function svgToCanvas(svg: string, w: number, h: number, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Couldn't draw the picture"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));

export async function pngBlob(pic: Picture, scale = 2): Promise<Blob> {
  const c = await svgToCanvas(pic.frame(0.4), pic.width, pic.height, scale);
  const b = await toBlob(c, "image/png");
  if (!b) throw new Error("Couldn't make a PNG");
  return b;
}

/** Can this browser encode WebP from a canvas? (Chrome and Edge can; Safari can't.) */
export async function canEncodeWebp(): Promise<boolean> {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const b = await toBlob(c, "image/webp", 0.8);
  return b?.type === "image/webp";
}

/* Animated WebP: encode each frame as a still WebP, then wrap the frames in an animated container. */

function chunks(buf: Uint8Array): { id: string; data: Uint8Array }[] {
  const out: { id: string; data: Uint8Array }[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 12; // after "RIFF" size "WEBP"
  while (i + 8 <= buf.length) {
    const id = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    const size = dv.getUint32(i + 4, true);
    out.push({ id, data: buf.subarray(i + 8, i + 8 + size) });
    i += 8 + size + (size & 1);
  }
  return out;
}

function chunk(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let k = 0; k < 4; k++) out[k] = id.charCodeAt(k);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

const u24 = (arr: Uint8Array, at: number, v: number) => {
  arr[at] = v & 255;
  arr[at + 1] = (v >> 8) & 255;
  arr[at + 2] = (v >> 16) & 255;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function animatedWebp(pic: Picture, opts: { fps?: number; scale?: number; quality?: number; onProgress?: (f: number) => void } = {}): Promise<Blob> {
  const fps = opts.fps ?? 12;
  // Keep big designs to a sensible file size.
  const scale = opts.scale ?? Math.min(1.25, 1400 / pic.width);
  const n = Math.round(LOOP * fps);
  const frames: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  let alpha = false;
  for (let i = 0; i < n; i++) {
    const c = await svgToCanvas(pic.frame(i / fps), pic.width, pic.height, scale);
    w = c.width;
    h = c.height;
    const b = await toBlob(c, "image/webp", opts.quality ?? 0.82);
    if (!b || b.type !== "image/webp") throw new Error("This browser can't make WebP images");
    const cs = chunks(new Uint8Array(await b.arrayBuffer())).filter((x) => x.id === "VP8 " || x.id === "VP8L" || x.id === "ALPH");
    if (cs.some((x) => x.id === "ALPH" || x.id === "VP8L")) alpha = true;
    frames.push(concat(cs.map((x) => chunk(x.id, x.data))));
    opts.onProgress?.((i + 1) / n);
  }
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (alpha ? 0x10 : 0); // animation (+ alpha)
  u24(vp8x, 4, w - 1);
  u24(vp8x, 7, h - 1);
  const anim = new Uint8Array(6); // background colour 0, loop forever
  const anmf = frames.map((f) => {
    const head = new Uint8Array(16);
    u24(head, 0, 0);
    u24(head, 3, 0);
    u24(head, 6, w - 1);
    u24(head, 9, h - 1);
    u24(head, 12, Math.round(1000 / fps));
    head[15] = 0x02; // don't blend with the previous frame
    return chunk("ANMF", concat([head, f]));
  });
  const body = concat([new TextEncoder().encode("WEBP"), chunk("VP8X", vp8x), chunk("ANIM", anim), ...anmf]);
  const riff = new Uint8Array(8);
  riff.set(new TextEncoder().encode("RIFF"));
  new DataView(riff.buffer).setUint32(4, body.length, true);
  return new Blob([concat([riff, body]) as BlobPart], { type: "image/webp" });
}

/** Fallback for browsers that can't encode WebP: an animated GIF. */
export async function animatedGif(pic: Picture, opts: { fps?: number; scale?: number; onProgress?: (f: number) => void } = {}): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const fps = opts.fps ?? 12;
  const scale = opts.scale ?? Math.min(1, 1000 / pic.width);
  const n = Math.round(LOOP * fps);
  const gif = GIFEncoder();
  for (let i = 0; i < n; i++) {
    const c = await svgToCanvas(pic.frame(i / fps), pic.width, pic.height, scale);
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const palette = quantize(data, 128);
    gif.writeFrame(applyPalette(data, palette), c.width, c.height, { palette, delay: Math.round(1000 / fps) });
    opts.onProgress?.((i + 1) / n);
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";
