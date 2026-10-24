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

export const B3_SOLUTION = `
export const server = {
  init(ctx) {
    ctx.setTimer("ping", 10);
    return {
      view: { num: 0, primary: null, backup: null },
      readyView: 0,
      data: {},
      last: {},
      synced: false,
      syncedView: 0,
      syncedFrom: null,
      syncing: false,
      pending: null,
    };
  },

  onTimer(s, t, ctx) {
    ctx.send("vs", { type: "ping", viewNum: s.readyView });
    if (s.syncing) sendSync(s, ctx);
    else if (s.pending) forward(s, ctx);
    ctx.setTimer("ping", 10);
  },

  onMessage(s, from, msg, ctx) {
    if (msg.type === "view" && msg.view.num > s.view.num) {
      const firstView = s.view.num === 0 && msg.view.num === 1;
      s.view = msg.view;
      if (s.view.primary === ctx.self) {
        if (firstView) s.synced = true;
        if (!s.synced) return;
        if (s.view.backup) { s.syncing = true; sendSync(s, ctx); }
        else { s.syncing = false; s.readyView = s.view.num; finishPending(s, ctx); }
      } else {
        s.syncing = false;
        s.pending = null;
        s.readyView = s.view.num;
      }
      return;
    }

    if (msg.type === "sync") {
      if (msg.view > s.syncedView) {
        s.data = msg.data;
        s.last = msg.last;
        s.synced = true;
        s.syncedView = msg.view;
        s.syncedFrom = from;
      }
      if (msg.view === s.syncedView) ctx.send(from, { type: "syncOk", view: msg.view });
      return;
    }

    if (msg.type === "syncOk") {
      if (s.syncing && msg.view === s.view.num && from === s.view.backup) {
        s.syncing = false;
        s.readyView = s.view.num;
        if (s.pending) forward(s, ctx);
      }
      return;
    }

    if (msg.type === "forward") {
      if (msg.view !== s.syncedView || from !== s.syncedFrom) return;
      const result = apply(s, msg.client, msg.seq, msg.cmd);
      ctx.send(from, { type: "forwardOk", view: msg.view, client: msg.client, seq: msg.seq, result });
      return;
    }

    if (msg.type === "forwardOk") {
      const p = s.pending;
      if (!p || msg.view !== s.view.num || p.client !== msg.client || p.seq !== msg.seq) return;
      finishPending(s, ctx);
      return;
    }

    if (msg.type === "request") {
      if (s.view.primary !== ctx.self || !s.synced) {
        ctx.send(from, { type: "reply", seq: msg.seq, error: "not primary" });
        return;
      }
      const prev = s.last[msg.client];
      if (prev && prev.seq === msg.seq) { ctx.send(from, { type: "reply", seq: msg.seq, result: prev.result }); return; }
      if (prev && prev.seq > msg.seq) return;
      if (s.syncing || s.readyView !== s.view.num || s.pending) return; // busy: the client will retry
      s.pending = { client: msg.client, seq: msg.seq, cmd: msg.cmd };
      if (s.view.backup) forward(s, ctx);
      else finishPending(s, ctx);
    }
  },
};

function apply(s, client, seq, cmd) {
  const prev = s.last[client];
  if (prev && prev.seq >= seq) return prev.result;
  s.data[cmd.key] = (s.data[cmd.key] ?? "") + cmd.value;
  s.last[client] = { seq, result: s.data[cmd.key] };
  return s.data[cmd.key];
}

function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: s.data, last: s.last });
}

function forward(s, ctx) {
  const p = s.pending;
  ctx.send(s.view.backup, { type: "forward", view: s.view.num, client: p.client, seq: p.seq, cmd: p.cmd });
}

function finishPending(s, ctx) {
  const p = s.pending;
  if (!p) return;
  s.pending = null;
  const result = apply(s, p.client, p.seq, p.cmd);
  ctx.send(p.client, { type: "reply", seq: p.seq, result });
}
`;

/** Forwards and dedups, but a new backup starts empty: no state transfer. */
export const B3_NO_SYNC = B3_SOLUTION.replace(
  `if (s.view.backup) { s.syncing = true; sendSync(s, ctx); }`,
  `if (s.view.backup) { ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: {}, last: {} }); s.syncing = true; }`,
).replace(`function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: s.data, last: s.last });`, `function sendSync(s, ctx) {
  ctx.send(s.view.backup, { type: "sync", view: s.view.num, data: {}, last: {} });`);
