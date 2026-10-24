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

export const B1_SOLUTION = `
export const lamport = {
  init: () => ({ time: 0 }),
  localEvent(s) { s.time += 1; return s.time; },
  send(s) { s.time += 1; return s.time; },
  receive(s, stamp) { s.time = Math.max(s.time, stamp) + 1; return s.time; },
};
export const vector = {
  init(self, everyone) {
    const v = {};
    for (const p of everyone) v[p] = 0;
    return { self, v };
  },
  localEvent(s) { s.v[s.self] += 1; return { ...s.v }; },
  send(s) { s.v[s.self] += 1; return { ...s.v }; },
  receive(s, stamp) {
    for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);
    s.v[s.self] += 1;
    return { ...s.v };
  },
};
`;

/** Lamport right, but vector receive forgets to tick its own entry. */
export const B1_VECTOR_NO_TICK = B1_SOLUTION.replace(
  "for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);\n    s.v[s.self] += 1;",
  "for (const p of Object.keys(stamp)) s.v[p] = Math.max(s.v[p] ?? 0, stamp[p]);",
);

export const B4_SOLUTION = `
const majority = 2;
export const proposer = {
  init: () => ({ value: null, round: 0, ballot: 0, promises: {}, accepted: [], decided: false }),
  onCommand(s, cmd, ctx) { s.value = cmd.value; start(s, ctx); },
  onMessage(s, from, msg, ctx) {
    if (s.decided || msg.ballot !== s.ballot) return;
    if (msg.type === "promise" && !(from in s.promises)) {
      s.promises[from] = { ballot: msg.acceptedBallot, value: msg.acceptedValue };
      if (Object.keys(s.promises).length === majority) {
        let best = null;
        for (const p of Object.values(s.promises)) if (p.ballot > 0 && (!best || p.ballot > best.ballot)) best = p;
        const v = best ? best.value : s.value;
        s.proposing = v;
        for (const a of ctx.nodes("acceptor")) ctx.send(a, { type: "accept", ballot: s.ballot, value: v });
      }
    }
    if (msg.type === "accepted" && !s.accepted.includes(from)) {
      s.accepted.push(from);
      if (s.accepted.length === majority) { s.decided = true; ctx.reply(msg.value); }
    }
  },
  onTimer(s, t, ctx) { if (!s.decided && t.data === s.ballot) start(s, ctx); },
};
function start(s, ctx) {
  s.round += 1;
  s.ballot = s.round * 10 + Number(ctx.self.slice(1));
  s.promises = {};
  s.accepted = [];
  for (const a of ctx.nodes("acceptor")) ctx.send(a, { type: "prepare", ballot: s.ballot });
  ctx.setTimer("retry", 40 + ctx.random() * 40, s.ballot);
}
export const acceptor = {
  init: () => ({ promised: 0, acceptedBallot: 0, acceptedValue: null }),
  onMessage(s, from, msg, ctx) {
    if (msg.type === "prepare" && msg.ballot >= s.promised) {
      s.promised = msg.ballot;
      ctx.send(from, { type: "promise", ballot: msg.ballot, acceptedBallot: s.acceptedBallot, acceptedValue: s.acceptedValue });
    }
    if (msg.type === "accept" && msg.ballot >= s.promised) {
      s.promised = msg.ballot;
      s.acceptedBallot = msg.ballot;
      s.acceptedValue = msg.value;
      ctx.send(from, { type: "accepted", ballot: msg.ballot, value: msg.value });
    }
  },
};
`;

/** Counts acceptances correctly, but always proposes its own value. */
export const B4_IGNORES_ACCEPTED = B4_SOLUTION.replace("const v = best ? best.value : s.value;", "const v = s.value;");

/** Picks the right value, but counts a repeated "accepted" message twice. */
export const B4_COUNTS_DUPLICATES = B4_SOLUTION.replace(`if (msg.type === "accepted" && !s.accepted.includes(from)) {`, `if (msg.type === "accepted") {`);
