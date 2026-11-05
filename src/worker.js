// Midline backend: static site + /api/* on Cloudflare Workers.
// Stats  (one global Durable Object, SQLite): daily scores, answer counts, misses, players, friends, live counts.
// Room   (one Durable Object per room code): online Grid Party over WebSockets.
import { DurableObject } from "cloudflare:workers";

const EPOCH = Date.UTC(2026, 10, 5);           // drive #1
const serverDay = () => Math.floor((Date.now() - EPOCH) / 864e5) + 1;
const json = (d, s = 200, extra = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const clean = (s, n = 14) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ']/g, "").trim().slice(0, 40);
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
const okPid = p => typeof p === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(p);
async function body(req) { try { return await req.json(); } catch { return {}; } }

// same tiering as the client
const PTS = { mid: 100, close: 70, drift: 40, far: 10, stall: 0 };
function tierOf(rank, n) {
  if (!(rank >= 0) || !(n > 0) || rank >= n) return "stall";
  const pos = n > 1 ? rank / (n - 1) : 0.5, d = Math.abs(pos - 0.5);
  return d <= 0.1 ? "mid" : d <= 0.22 ? "close" : d <= 0.36 ? "drift" : "far";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      // rooms
      const m = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4})\/(ws|info)$/);
      if (m) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
      if (url.pathname === "/api/room/new" && req.method === "POST") {
        for (let i = 0; i < 6; i++) {
          const c = code(4), stub = env.ROOMS.get(env.ROOMS.idFromName(c));
          const r = await stub.fetch(`https://room/api/room/${c}/init`, { method: "POST" });
          if (r.ok) return json({ code: c });
        }
        return json({ error: "busy, try again" }, 503);
      }
      // everything else lives in the global stats object
      return env.STATS.get(env.STATS.idFromName("global")).fetch(req);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ======================================================================
   STATS
   ====================================================================== */
export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS scores(day INTEGER, pid TEXT, pts INTEGER, metres INTEGER, sq TEXT, ts INTEGER, PRIMARY KEY(day,pid));
      CREATE TABLE IF NOT EXISTS answers(q TEXT, a TEXT, n INTEGER, PRIMARY KEY(q,a));
      CREATE TABLE IF NOT EXISTS misses(q TEXT, a TEXT, n INTEGER, PRIMARY KEY(q,a));
      CREATE TABLE IF NOT EXISTS players(pid TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, ts INTEGER);
      CREATE TABLE IF NOT EXISTS friends(a TEXT, b TEXT, PRIMARY KEY(a,b));
      CREATE TABLE IF NOT EXISTS seen(day INTEGER, pid TEXT, PRIMARY KEY(day,pid));
      CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, players INTEGER, live INTEGER, ts INTEGER);
    `);
  }
  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  one(q, ...a) { return this.rows(q, ...a)[0]; }

  dist(day, mine) {
    const pts = this.rows("SELECT pts FROM scores WHERE day=?", day).map(r => r.pts);
    const hist = new Array(71).fill(0);
    pts.forEach(p => hist[Math.max(0, Math.min(70, Math.round(p / 10)))]++);
    let better = null;
    if (mine != null && pts.length > 1) better = Math.round(pts.filter(p => p < mine).length / (pts.length - 1) * 100);
    return { day, count: pts.length, hist, better };
  }
  player(pid, name) {
    let p = this.one("SELECT * FROM players WHERE pid=?", pid);
    if (!p) {
      let c; do { c = code(6); } while (this.one("SELECT 1 AS x FROM players WHERE code=?", c));
      this.sql.exec("INSERT INTO players(pid,name,code,ts) VALUES(?,?,?,?)", pid, clean(name) || "Driver", c, Date.now());
      p = this.one("SELECT * FROM players WHERE pid=?", pid);
    } else if (name && clean(name) !== p.name) {
      this.sql.exec("UPDATE players SET name=?, ts=? WHERE pid=?", clean(name), Date.now(), pid);
      p.name = clean(name);
    }
    return p;
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname, POST = req.method === "POST";
    const today = serverDay();
    const dayOk = d => Number.isInteger(d) && d >= 1 && Math.abs(d - today) <= 1;

    if (path === "/api/score" && POST) {
      const b = await body(req);
      if (!okPid(b.pid) || !dayOk(b.day)) return json({ error: "bad request" }, 400);
      const pts = Math.max(0, Math.min(700, b.pts | 0)), metres = pts * 4;
      const sq = String(b.sq || "").replace(/[^a-z,]/g, "").slice(0, 60);
      this.sql.exec("INSERT OR IGNORE INTO scores(day,pid,pts,metres,sq,ts) VALUES(?,?,?,?,?,?)", b.day, b.pid, pts, metres, sq, Date.now());
      const row = this.one("SELECT pts FROM scores WHERE day=? AND pid=?", b.day, b.pid);
      return json(this.dist(b.day, row.pts));
    }
    if (path === "/api/day") {
      const d = parseInt(url.searchParams.get("d")) || today;
      const mine = url.searchParams.get("pid");
      const row = mine ? this.one("SELECT pts FROM scores WHERE day=? AND pid=?", d, mine) : null;
      return json(this.dist(d, row ? row.pts : null));
    }
    if (path === "/api/ping" && POST) {
      const b = await body(req);
      if (okPid(b.pid) && dayOk(b.day)) this.sql.exec("INSERT OR IGNORE INTO seen(day,pid) VALUES(?,?)", b.day, b.pid);
      return this.live(b.day || today);
    }
    if (path === "/api/live") return this.live(parseInt(url.searchParams.get("d")) || today);

    if (path === "/api/answer" && POST) {
      const b = await body(req), list = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
      for (const it of list) {
        const q = clean(it.q, 60), a = norm(it.a);
        if (!q || !a) continue;
        const table = it.miss ? "misses" : "answers";
        this.sql.exec(`INSERT INTO ${table}(q,a,n) VALUES(?,?,1) ON CONFLICT(q,a) DO UPDATE SET n=n+1`, q, a);
      }
      return json({ ok: true });
    }
    if (path === "/api/pop") {
      const out = {};
      for (const r of this.rows("SELECT q,a,n FROM answers")) (out[r.q] ||= {})[r.a] = r.n;
      return json(out, 200, { "cache-control": "public, max-age=300" });
    }
    if (path === "/api/misses") {
      if (!this.env.ADMIN_KEY || url.searchParams.get("key") !== this.env.ADMIN_KEY) return json({ error: "set ADMIN_KEY and pass ?key=" }, 403);
      return json(this.rows("SELECT q,a,n FROM misses ORDER BY n DESC LIMIT 500"));
    }

    if (path === "/api/me" && POST) {
      const b = await body(req);
      if (!okPid(b.pid)) return json({ error: "bad request" }, 400);
      const p = this.player(b.pid, b.name);
      return json({ name: p.name, code: p.code });
    }
    if (path === "/api/friends/add" && POST) {
      const b = await body(req);
      if (!okPid(b.pid)) return json({ error: "bad request" }, 400);
      const me = this.player(b.pid, b.name);
      const f = this.one("SELECT pid,name,code FROM players WHERE code=?", String(b.code || "").toUpperCase().trim());
      if (!f) return json({ error: "No driver with that code" }, 404);
      if (f.pid === me.pid) return json({ error: "That's your own code" }, 400);
      this.sql.exec("INSERT OR IGNORE INTO friends(a,b) VALUES(?,?)", me.pid, f.pid);
      this.sql.exec("INSERT OR IGNORE INTO friends(a,b) VALUES(?,?)", f.pid, me.pid);
      return json({ ok: true, name: f.name });
    }
    if (path === "/api/friends/remove" && POST) {
      const b = await body(req);
      const f = this.one("SELECT pid FROM players WHERE code=?", String(b.code || ""));
      if (okPid(b.pid) && f) { this.sql.exec("DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)", b.pid, f.pid, f.pid, b.pid); }
      return json({ ok: true });
    }
    if (path === "/api/friends") {
      const pid = url.searchParams.get("pid"), d = parseInt(url.searchParams.get("d")) || today;
      if (!okPid(pid)) return json({ error: "bad request" }, 400);
      const list = this.rows(`
        SELECT p.pid, p.name, p.code, s.pts, s.sq,
          (SELECT COUNT(*) FROM scores x WHERE x.pid=p.pid) AS drives
        FROM players p LEFT JOIN scores s ON s.pid=p.pid AND s.day=?
        WHERE p.pid=? OR p.pid IN (SELECT b FROM friends WHERE a=?)`, d, pid, pid);
      return json(list.map(r => ({ me: r.pid === pid, name: r.name, code: r.code, pts: r.pts, sq: r.sq, drives: r.drives })));
    }

    if (path === "/api/_room" && POST) {          // registry updates from Room objects
      const b = await body(req);
      if (/^[A-Z0-9]{4}$/.test(b.code)) this.sql.exec("INSERT INTO rooms(code,players,live,ts) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET players=excluded.players, live=excluded.live, ts=excluded.ts",
        b.code, b.players | 0, b.live ? 1 : 0, Date.now());
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
  live(day) {
    const cutoff = Date.now() - 15 * 60e3;
    this.sql.exec("DELETE FROM rooms WHERE ts < ?", Date.now() - 24 * 3600e3);
    const r = this.one("SELECT COUNT(*) AS rooms, COALESCE(SUM(players),0) AS players FROM rooms WHERE live=1 AND ts>?", cutoff);
    return json({
      day,
      drivers: this.one("SELECT COUNT(*) AS n FROM seen WHERE day=?", day).n,
      finished: this.one("SELECT COUNT(*) AS n FROM scores WHERE day=?", day).n,
      rooms: r.rooms, partyPlayers: r.players,
    });
  }
}

/* ======================================================================
   ROOM  (online Grid Party)
   phases: lobby → countdown → answer → reveal → (countdown …) → final
   ====================================================================== */
const COUNTDOWN_MS = 3500, ANSWER_MS = 25000, REVEAL_MS = 25000;
export class Room extends DurableObject {
  async load() { return (await this.ctx.storage.get("s")) || null; }
  async save(s) { s.ts = Date.now(); await this.ctx.storage.put("s", s); }
  sockets() { return this.ctx.getWebSockets(); }
  online() { return new Set(this.sockets().map(ws => (ws.deserializeAttachment() || {}).pid)); }

  view(s) {
    const on = this.online(), showAnswers = s.phase === "reveal" || s.phase === "final";
    return {
      t: "state", now: Date.now(), code: s.code, host: s.host, phase: s.phase, rounds: s.rounds, round: s.round,
      prompt: s.phase === "lobby" ? null : s.order[s.round], deadline: s.deadline,
      players: s.players.map(p => ({ pid: p.pid, name: p.name, ci: p.ci, pts: p.pts, metres: p.pts * 4, online: on.has(p.pid), answered: !!s.answers[p.pid], res: p.res })),
      reveal: showAnswers ? s.last : null,
    };
  }
  broadcast(s) {
    const msg = JSON.stringify(this.view(s));
    for (const ws of this.sockets()) { try { ws.send(msg); } catch {} }
  }
  async registry(s) {
    try {
      await this.env.STATS.get(this.env.STATS.idFromName("global")).fetch("https://stats/api/_room", {
        method: "POST", body: JSON.stringify({ code: s.code, players: s.players.length, live: s.phase !== "final" && this.sockets().length > 0 }),
      });
    } catch {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/init")) {
      const s = await this.load();
      if (s && Date.now() - s.ts < 6 * 3600e3) return json({ error: "taken" }, 409);
      const c = url.pathname.split("/")[3];
      await this.ctx.storage.deleteAll();
      await this.save({ code: c, host: null, players: [], phase: "lobby", rounds: 5, round: 0, order: [], answers: {}, last: null, deadline: 0 });
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/info")) {
      const s = await this.load();
      return json(s ? { exists: true, phase: s.phase, players: s.players.length } : { exists: false });
    }
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);

    const pid = url.searchParams.get("pid"), name = clean(url.searchParams.get("name")) || "Driver";
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const fail = msg => { server.send(JSON.stringify({ t: "error", msg })); server.close(4000, msg); return new Response(null, { status: 101, webSocket: client }); };
    if (!okPid(pid)) return fail("Bad player id");
    const s = await this.load();
    if (!s) return fail("Room not found. Check the code.");
    server.serializeAttachment({ pid });
    let p = s.players.find(x => x.pid === pid);
    if (p) p.name = name;
    else {
      if (s.phase !== "lobby") return fail("That race has already started.");
      if (s.players.length >= 6) return fail("Room is full (6 drivers).");
      const used = new Set(s.players.map(x => x.ci));
      p = { pid, name, ci: [0, 1, 2, 3, 4, 5].find(i => !used.has(i)), pts: 0, res: [] };
      s.players.push(p);
    }
    if (!s.host || !s.players.some(x => x.pid === s.host)) s.host = pid;
    await this.save(s); this.broadcast(s); this.ctx.waitUntil(this.registry(s));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const { pid } = ws.deserializeAttachment() || {};
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "ping") { ws.send(JSON.stringify({ t: "pong", now: Date.now() })); return; }
    const s = await this.load(); if (!s) return;
    const isHost = pid === s.host;
    switch (m.t) {
      case "rounds":
        if (isHost && s.phase === "lobby" && [3, 5, 7].includes(m.rounds)) s.rounds = m.rounds;
        break;
      case "start": {
        if (!isHost || s.phase !== "lobby" || s.players.length < 2) return;
        const order = Array.isArray(m.order) ? m.order.map(n => n | 0).slice(0, s.rounds) : [];
        if (order.length < s.rounds) return;
        s.order = order; s.round = 0; s.last = null;
        s.players.forEach(p => { p.pts = 0; p.res = []; });
        this.countdown(s);
        break;
      }
      case "answer": {
        if (s.phase !== "answer" || s.answers[pid] || !s.players.some(p => p.pid === pid)) return;
        s.answers[pid] = { rank: m.rank | 0, n: m.n | 0, a: clean(m.a, 40), text: clean(m.text, 40) };
        const on = this.online();
        if (s.players.filter(p => on.has(p.pid)).every(p => s.answers[p.pid])) this.reveal(s);
        break;
      }
      case "next":
        if (isHost && s.phase === "reveal") this.advance(s);
        break;
      case "rematch":
        if (isHost && s.phase === "final") { s.phase = "lobby"; s.round = 0; s.last = null; s.answers = {}; s.players.forEach(p => { p.pts = 0; p.res = []; }); }
        break;
      case "leave":
        this.drop(s, pid); try { ws.close(1000, "left"); } catch {}
        break;
      default: return;
    }
    await this.save(s); this.broadcast(s); this.ctx.waitUntil(this.registry(s));
  }

  async webSocketClose(ws) {
    const { pid } = ws.deserializeAttachment() || {};
    const s = await this.load(); if (!s) return;
    const stillOn = this.sockets().some(x => x !== ws && (x.deserializeAttachment() || {}).pid === pid);
    if (!stillOn && s.phase === "lobby") this.drop(s, pid);
    else if (!stillOn && s.host === pid) { const on = this.online(); on.delete(pid); const nh = s.players.find(p => on.has(p.pid)); if (nh) s.host = nh.pid; }
    await this.save(s); this.broadcast(s); this.ctx.waitUntil(this.registry(s));
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  drop(s, pid) {
    if (s.phase === "lobby") s.players = s.players.filter(p => p.pid !== pid);
    if (s.host === pid) { const on = this.online(); on.delete(pid); s.host = (s.players.find(p => on.has(p.pid)) || s.players[0] || {}).pid || null; }
  }
  countdown(s) { s.phase = "countdown"; s.answers = {}; s.deadline = Date.now() + COUNTDOWN_MS; this.ctx.storage.setAlarm(s.deadline); }
  answering(s) { s.phase = "answer"; s.deadline = Date.now() + ANSWER_MS; this.ctx.storage.setAlarm(s.deadline + 400); }
  reveal(s) {
    const counts = {};
    for (const a of Object.values(s.answers)) if (a.rank >= 0 && a.n > 0) counts[a.a] = (counts[a.a] || 0) + 1;
    s.last = s.players.map(p => {
      const a = s.answers[p.pid] || { rank: -1, n: 0, a: "", text: "" };
      const t = tierOf(a.rank, a.n), shunt = t !== "stall" && counts[a.a] > 1;
      const pts = shunt ? Math.floor(PTS[t] / 2) : PTS[t];
      p.pts += pts; p.res.push({ t, pts, shunt });
      return { pid: p.pid, a: a.a, t, pts, shunt, pos: a.n > 1 ? a.rank / (a.n - 1) : null };
    });
    s.phase = "reveal"; s.deadline = Date.now() + REVEAL_MS; this.ctx.storage.setAlarm(s.deadline);
  }
  advance(s) {
    if (s.round + 1 >= s.rounds) { s.phase = "final"; s.deadline = 0; this.ctx.storage.deleteAlarm(); }
    else { s.round++; this.countdown(s); }
  }
  async alarm() {
    const s = await this.load(); if (!s) return;
    if (s.phase === "countdown") this.answering(s);
    else if (s.phase === "answer") this.reveal(s);
    else if (s.phase === "reveal") this.advance(s);
    else return;
    await this.save(s); this.broadcast(s); await this.registry(s);
  }
}
