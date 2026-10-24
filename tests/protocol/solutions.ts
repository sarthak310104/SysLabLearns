/**
 * Reference solutions, kept only in the tests so the app never shows them.
 * Each lab also has deliberately broken variants: the checker must catch them.
 */

export const B2_SOLUTION = `
export const client = {
  init: () => ({ seq: 0, cmd: null }),
  onCommand(s, cmd, ctx) {
    s.seq++;
    s.cmd = cmd;
    ctx.send(ctx.nodes("server")[0], { type: "request", seq: s.seq, cmd });
    ctx.setTimer("retry", 30, s.seq);
  },
  onMessage(s, from, msg, ctx) {
    if (msg.type === "reply" && msg.seq === s.seq && s.cmd) {
      s.cmd = null;
      ctx.reply(msg.result);
    }
  },
  onTimer(s, t, ctx) {
    if (t.data === s.seq && s.cmd) {
      ctx.send(ctx.nodes("server")[0], { type: "request", seq: s.seq, cmd: s.cmd });
      ctx.setTimer("retry", 30, s.seq);
    }
  },
};

export const server = {
  init: () => ({ data: {}, last: {} }),
  onMessage(s, from, msg, ctx) {
    if (msg.type !== "request") return;
    const prev = s.last[from];
    if (prev && prev.seq === msg.seq) {
      ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
      return;
    }
    if (prev && prev.seq > msg.seq) return;
    const { key, value } = msg.cmd;
    s.data[key] = (s.data[key] ?? "") + value;
    s.last[from] = { seq: msg.seq, result: s.data[key] };
    ctx.send(from, { type: "reply", seq: msg.seq, result: s.data[key] });
  },
};
`;

/** Retries, but the server applies every request it sees: duplicates get applied twice. */
export const B2_NO_DEDUP = B2_SOLUTION.replace(
  `    if (prev && prev.seq === msg.seq) {
      ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result });
      return;
    }
    if (prev && prev.seq > msg.seq) return;`,
  "",
);

/** Remembers requests, but keyed only by sequence number: two clients collide. */
export const B2_SHARED_DEDUP = B2_SOLUTION.replace(/s\.last\[from\]/g, "s.last.any").replace("const prev = s.last[from];", "const prev = s.last.any;");
