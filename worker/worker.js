// FOOTEXT API - Cloudflare Worker
//
// GET /football          -> PL, Championship, Champions League matches + tables (compact JSON)
// GET /news?team=<name>  -> confirmed transfer headlines from BBC Sport for one club
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   FOOTBALL_DATA_KEY  (secret, required)  your football-data.org API key
//   ALLOWED_ORIGIN     (optional)          e.g. https://yourname.github.io  (default: *)
//   CACHE              (optional KV binding) makes caching survive between requests

const API = "https://api.football-data.org/v4";
const COMPS = ["PL", "ELC", "CL"];
const MATCHES_TTL = 60;        // seconds - live scores refresh at most once a minute
const SEASON_TTL = 30 * 60;    // full fixture lists
const TABLES_TTL = 5 * 60;     // league tables change less often
const NEWS_TTL = 15 * 60;
const KV_WRITE_EVERY = 10 * 60;  // seconds between KV backups of the same key

const mem = new Map();         // in-memory cache, lives as long as the Worker instance

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // If ALLOWED_ORIGIN is set, only answer requests made by the FOOTEXT app itself.
    // Bots and crawlers that hit the URL directly get a 403 and use none of your API quota.
    // (Add ?key=<ACCESS_KEY> to test in a normal browser tab, if you set ACCESS_KEY.)
    if (env.ALLOWED_ORIGIN) {
      const fromApp = request.headers.get("Origin") === env.ALLOWED_ORIGIN;
      const testing = env.ACCESS_KEY && url.searchParams.get("key") === env.ACCESS_KEY;
      if (!fromApp && !testing) return json({ error: "Forbidden" }, 403, { ...cors, "X-Robots-Tag": "noindex" });
    }

    try {
      let body;
      if (url.pathname === "/football") body = await football(env);
      else if (url.pathname === "/news") body = await news(env, url.searchParams.get("team") || "");
      else if (url.pathname === "/events") body = await matchEvents(env, url.searchParams);
      else return json({ error: "Not found" }, 404, cors);
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/* ---------- caching: memory first, then KV, then fetch. Stale copy used if fetch fails ---------- */

// Only football-data results are worth sharing through KV (they protect the 10 calls/minute limit).
// ESPN and BBC data stays in memory, which keeps KV writes far below the free 1,000/day.
const useKV = (env, key) => env.CACHE && /^(season|tables|live)\b/.test(key);

async function cached(env, key, ttl, loader, report) {
  const now = Date.now();
  let hit = mem.get(key);
  if (!hit && useKV(env, key)) {
    const raw = await env.CACHE.get(key);
    if (raw) { try { hit = JSON.parse(raw); mem.set(key, hit); } catch {} }
  }
  if (hit && now - hit.at < ttl * 1000) return hit.value;
  try {
    const value = await loader();
    const entry = { at: now, value, kvAt: hit?.kvAt || 0 };
    // KV free tier allows 1,000 writes/day, so only copy to KV every few minutes per key.
    // Memory is the main cache; KV is a shared backup between Worker instances.
    if (useKV(env, key) && now - entry.kvAt > KV_WRITE_EVERY * 1000) {
      entry.kvAt = now;
      try { await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: 7 * 86400 }); }
      catch (e) { console.warn("KV write skipped:", e.message); }   // e.g. daily limit reached
    }
    mem.set(key, entry);
    return value;
  } catch (e) {
    console.warn(`Refresh of ${key} failed: ${e.message}`);
    if (hit) {                     // serve stale rather than nothing (e.g. rate limited)
      if (report) report.push({ key, error: e.message, since: new Date(hit.at).toISOString() });
      return hit.value;
    }
    throw e;
  }
}

/* ---------- football-data.org ---------- */

async function fd(env, path) {
  if (!env.FOOTBALL_DATA_KEY) throw new Error("FOOTBALL_DATA_KEY is not set on the Worker");
  const res = await fetch(API + path, { headers: { "X-Auth-Token": env.FOOTBALL_DATA_KEY } });
  if (!res.ok) throw new Error(`football-data ${res.status} for ${path}`);
  return res.json();
}

const NAME_FIX = {
  "Wolverhampton": "Wolves", "Nottingham": "Nott'm Forest", "Brighton Hove": "Brighton",
  "Man United": "Man Utd", "Sheffield Utd": "Sheff Utd", "Sheffield Wed": "Sheff Wed",
  "Paris Saint-Germain": "Paris SG", "PSG": "Paris SG",
};

function compactTeam(t) {
  if (!t || t.id == null) return null;
  let s = t.shortName || t.name || "TBC";
  s = NAME_FIX[s] || s;
  return { id: t.id, n: t.name, s, t: t.tla || s.slice(0, 3).toUpperCase() };
}

function compactMatches(json) {
  const teams = {};
  const add = (t) => { const c = compactTeam(t); if (c) teams[c.id] = c; return c ? c.id : null; };
  const matches = json.matches.map((m) => {
    const s = m.score || {};
    return {
      id: m.id, d: m.utcDate, st: m.status, md: m.matchday ?? null, sg: m.stage || null,
      h: add(m.homeTeam), a: add(m.awayTeam),
      ft: [s.fullTime?.home ?? null, s.fullTime?.away ?? null],
      ht: [s.halfTime?.home ?? null, s.halfTime?.away ?? null],
      du: s.duration && s.duration !== "REGULAR" ? s.duration : undefined,
      pn: s.penalties && s.penalties.home != null ? [s.penalties.home, s.penalties.away] : undefined,
      mn: m.minute ?? undefined,
    };
  });
  return { name: json.competition?.name, matches, teams };
}

function compactTables(json) {
  const teams = {};
  const tables = (json.standings || []).filter((s) => s.type === "TOTAL").map((s) => ({
    name: s.group || s.stage || "",
    rows: s.table.map((r) => {
      const c = compactTeam(r.team); if (c) teams[c.id] = c;
      return { p: r.position, id: r.team.id, pl: r.playedGames, w: r.won, d: r.draw, l: r.lost,
        gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, pts: r.points };
    }),
  }));
  return { tables, teams };
}

// Dates as YYYY-MM-DD, offset in days from today (UTC)
const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

async function football(env) {
  const out = { updated: null, comps: {}, teams: {}, stale: [] };
  // Sequential on purpose: keeps us well inside the free tier's 10 requests/minute.
  // Whole-season fixture lists change rarely: refresh every 30 min (3 calls).
  // Tables: every 5 min (3 calls).
  // Live window: ONE call a minute covering all three competitions, yesterday to tomorrow.
  for (const code of COMPS) {
    const m = await cached(env, `season:${code}`, SEASON_TTL, async () => compactMatches(await fd(env, `/competitions/${code}/matches`)), out.stale);
    const t = await cached(env, `tables:${code}`, TABLES_TTL, async () => compactTables(await fd(env, `/competitions/${code}/standings`)), out.stale);
    Object.assign(out.teams, m.teams, t.teams);
    out.comps[code] = { name: m.name, matches: [...m.matches], tables: t.tables };
  }
  const live = await cached(env, "live", MATCHES_TTL, async () => {
    const j = await fd(env, `/matches?competitions=${COMPS.join(",")}&dateFrom=${day(-1)}&dateTo=${day(1)}`);
    return { ...compactMatches(j), codes: Object.fromEntries(j.matches.map((m) => [m.id, m.competition?.code])) };
  }, out.stale);

  // Overlay the fresh live-window results onto the season lists
  Object.assign(out.teams, live.teams);
  for (const lm of live.matches) {
    const comp = out.comps[live.codes[lm.id]];
    if (!comp) continue;
    const i = comp.matches.findIndex((m) => m.id === lm.id);
    // Copies, so the ESPN overlay below never alters the cached football-data values
    if (i >= 0) comp.matches[i] = { ...lm }; else comp.matches.push({ ...lm });
  }
  const at = mem.get("live")?.at || Date.now();
  out.updated = new Date(at).toISOString();

  // football-data's free tier is ~5 minutes behind and has no match minute.
  // For games happening right now, take the score and minute from ESPN instead.
  try { await espnLiveOverlay(env, out); }
  catch (e) { console.warn("ESPN live overlay failed:", e.message); }
  return out;
}

const DONE = new Set(["FINISHED", "AWARDED", "POSTPONED", "CANCELLED", "SUSPENDED"]);

async function espnLiveOverlay(env, out) {
  const now = Date.now();
  // Only games from 5 minutes before kick-off to 3.5 hours after, not already final
  const groups = new Map();   // "CL|20261125" -> [match]
  for (const [code, comp] of Object.entries(out.comps)) {
    for (const m of comp.matches) {
      const ko = Date.parse(m.d);
      if (DONE.has(m.st) || ko > now + 5 * 60e3 || ko < now - 3.5 * 3600e3) continue;
      const key = `${code}|${ymd(new Date(ko))}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
  }
  for (const [key, matches] of groups) {
    const [code, dayStr] = key.split("|");
    const events = await espnScoreboard(env, ESPN_LEAGUE[code], dayStr, true);
    for (const m of matches) {
      const T = out.teams;
      const home = [T[m.h]?.n, T[m.h]?.s].filter(Boolean), away = [T[m.a]?.n, T[m.a]?.s].filter(Boolean);
      let best = null, bestScore = 0;
      for (const e of events) {
        const h = e.teams.find((t) => t.side === "h"), a = e.teams.find((t) => t.side === "a");
        if (!h || !a) continue;
        const sh = similarity(home, h.team), sa = similarity(away, a.team);
        if (sh > 0 && sa > 0 && sh + sa > bestScore) { best = e; bestScore = sh + sa; }
      }
      if (!best || best.state === "pre") continue;
      const score = ["h", "a"].map((side) => {
        const v = best.teams.find((t) => t.side === side)?.score;
        return v == null || v === "" ? null : Number(v);
      });
      const detail = (best.status || "").toUpperCase();
      if (best.state === "in") {
        m.st = /^HT|HALF/.test(detail) ? "PAUSED" : "IN_PLAY";
        // "59'" -> "59", "90'+2'" -> "90+2"
        const min = (best.status || "").match(/^(\d+)'?(?:\s*\+\s*(\d+))?/);
        m.mn = m.st === "IN_PLAY" && min ? (min[2] ? `${min[1]}+${min[2]}` : min[1]) : undefined;
      } else if (best.state === "post") {
        m.st = "FINISHED";
        m.mn = undefined;
        if (/PEN/.test(detail)) m.du = "PENALTY_SHOOTOUT";
        else if (/AET|EXTRA/.test(detail)) m.du = "EXTRA_TIME";
      }
      if (score[0] != null && score[1] != null) m.ft = score;
      m.src = "espn";
    }
  }
}

/* ---------- transfer news (BBC Sport RSS, filtered to confirmed moves) ---------- */

// Words that suggest a deal has actually happened
const CONFIRMED = /\b(signs?|signed|re-signs?|joins?|joined|completes?|completed|seals?|sealed|captures?|unveil(s|ed)?|loaned|on loan|loan (move|deal|spell)|new (contract|deal)|extends?|extension|contract until|departs?|leaves?|left|released|retires?|sold|permanent (move|deal)|confirm(s|ed)? (the )?(signing|departure|deal|transfer))\b/i;
// Words that suggest rumour, speculation or an unfinished deal
const RUMOUR = /\b(gossip|rumou?rs?|linked|links?|target(s|ing)?|bid(s)?|talks|interest(ed)?|eye(s|ing)?|keen|want(s|ed)?|could|may|might|set to|close to|closing in|nearing|near|poised|consider(s|ing)?|monitor(s|ing)?|track(s|ing)?|approach(es)?|enquir(y|ies)|offer(s|ed)?|reject(s|ed)?|subject to|medical|weigh(s|ing)?|scout(s|ing)?|tipped|expected|plans?|hopes?|wants?|chase|pursuit|race for|battle for|swoop|agree(s|d)? (terms|fee)|in line)\b/i;
// Men's football only
const WOMENS = /\b(women'?s?|wsl|lionesses|girls|u21|u18|under-21|under-18|academy)\b/i;

function slug(name) {
  return name
    .replace(/&/g, "and")
    .replace(/\b(F\.?C\.?|A\.?F\.?C\.?)$/i, "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Words used to check that a general-feed story is about this club
function teamWords(name) {
  const clean = name.replace(/\b(F\.?C\.?|A\.?F\.?C\.?|CF|SC|SL|AC|SSC|FK|SK|PSV|1\.)\b/g, "").replace(/&/g, "and").trim();
  const words = new Set([clean]);
  const extra = {
    "Manchester United": ["Man Utd", "Man United"], "Manchester City": ["Man City"],
    "Tottenham Hotspur": ["Tottenham", "Spurs"], "Wolverhampton Wanderers": ["Wolves"],
    "Brighton and Hove Albion": ["Brighton"], "Nottingham Forest": ["Forest"],
    "West Ham United": ["West Ham"], "Newcastle United": ["Newcastle"], "Leeds United": ["Leeds"],
    "AFC Bournemouth": ["Bournemouth"], "Queens Park Rangers": ["QPR"], "West Bromwich Albion": ["West Brom"],
    "Sheffield United": ["Sheffield United", "Sheff Utd"], "Sheffield Wednesday": ["Sheffield Wednesday", "Sheff Wed"],
  };
  for (const [k, v] of Object.entries(extra)) if (clean.includes(k)) v.forEach((x) => words.add(x));
  // First word if distinctive (e.g. "Arsenal", "Chelsea", "Everton")
  const first = clean.split(/\s+/)[0];
  if (first.length > 4 && !/^(manchester|sheffield|bristol|west|real|athletic|sporting|club|olympique|borussia|bayer|inter|paris)$/i.test(first)) words.add(first);
  return [...words];
}

function parseRss(xml) {
  const items = [];
  for (const block of xml.match(/<item[\s\S]*?<\/item>/g) || []) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim() : "";
    };
    items.push({ title: get("title"), desc: get("description"), link: get("link") || get("guid"), date: get("pubDate") });
  }
  return items;
}

async function getFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": "FOOTEXT personal app" }, cf: { cacheTtl: 600 } });
  if (!res.ok) return [];
  return parseRss(await res.text());
}

async function news(env, team) {
  team = team.slice(0, 80);
  if (!team) throw new Error("Missing team");
  return cached(env, `news:${slug(team)}`, NEWS_TTL, async () => {
    const words = teamWords(team);
    const mentions = (i) => words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(i.title + " " + i.desc));

    const teamFeed = await getFeed(`https://feeds.bbci.co.uk/sport/football/teams/${slug(team)}/rss.xml`);
    const general = (await Promise.all([
      getFeed("https://feeds.bbci.co.uk/sport/football/rss.xml"),
      getFeed("https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml"),
      getFeed("https://feeds.bbci.co.uk/sport/football/championship/rss.xml"),
      getFeed("https://feeds.bbci.co.uk/sport/football/european/rss.xml"),
    ])).flat().filter(mentions);

    const seen = new Set();
    const items = [...teamFeed, ...general]
      .filter((i) => {
        if (!i.link || seen.has(i.link)) return false;
        seen.add(i.link);
        const text = i.title + " " + i.desc;
        if (/gossip/i.test(i.link) || /\/womens?\//i.test(i.link)) return false;
        return CONFIRMED.test(i.title) && !RUMOUR.test(i.title) && !WOMENS.test(text);
      })
      .map((i) => ({ title: i.title, link: i.link, date: i.date ? new Date(i.date).toISOString() : null }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 15);

    return { team, teamFeed: teamFeed.length > 0, items, updated: new Date().toISOString() };
  });
}

/* ---------- goal scorers & red cards (ESPN's public, unofficial scores feed) ----------
 * GET /events?comp=PL&date=<ISO kick-off>&home=<name>&away=<name>
 * Unofficial: ESPN could change this at any time. If it does, only the match detail page breaks. */

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_LEAGUE = { PL: "eng.1", ELC: "eng.2", CL: "uefa.champions" };

const ALIAS = {
  utd: "united", man: "manchester", "nottm": "nottingham", spurs: "tottenham", wolves: "wolverhampton",
  brighton: "brighton", qpr: "queens park rangers", "west brom": "west bromwich", psg: "paris saint germain",
  sheff: "sheffield", munchen: "munich", internazionale: "inter", "inter milan": "inter",
};
const STOP = new Set(["fc", "afc", "cf", "sc", "the", "club", "de", "ac", "cp", "sk", "fk", "and"]);

function tokens(name) {
  let s = (name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/['’.]/g, "").replace(/[^a-z0-9 ]+/g, " ");
  for (const [k, v] of Object.entries(ALIAS)) s = s.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  return s.split(/\s+/).filter((t) => t && !STOP.has(t));
}

function similarity(names, team) {
  const theirs = [team.displayName, team.shortDisplayName, team.name, team.location].filter(Boolean);
  let best = 0;
  for (const a of names) for (const b of theirs) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) continue;
    const common = ta.filter((t) => tb.includes(t)).length;
    // Mostly "how much of the shorter name matches", with a tie-break for exact-length matches
    // (so "Man City" prefers "Manchester City" over "Manchester United").
    best = Math.max(best, common / Math.min(ta.length, tb.length) + 0.1 * (common / Math.max(ta.length, tb.length)));
  }
  return best;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function espnScoreboard(env, league, day, live) {
  return cached(env, `espn:${league}:${day}`, live ? 60 : 6 * 3600, async () => {
    const res = await fetch(`${ESPN}/${league}/scoreboard?dates=${day}`, { headers: { "User-Agent": "FOOTEXT personal app" } });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const j = await res.json();
    // Keep only what we need so the cache stays small
    return (j.events || []).map((e) => {
      const c = e.competitions?.[0] || {};
      return {
        id: e.id,
        status: c.status?.type?.shortDetail || e.status?.type?.shortDetail || "",
        state: c.status?.type?.state || e.status?.type?.state || "",
        teams: (c.competitors || []).map((t) => ({
          side: t.homeAway === "home" ? "h" : "a",
          id: String(t.team?.id ?? t.id),
          score: t.score ?? null,
          team: { displayName: t.team?.displayName, shortDisplayName: t.team?.shortDisplayName, name: t.team?.name, location: t.team?.location },
        })),
        details: (c.details || []).map(detail),
      };
    });
  });
}

function detail(d) {
  const text = (d.type?.text || "").toLowerCase();
  const p = d.athletesInvolved?.[0] || {};
  const kind = d.ownGoal || /own goal/.test(text) ? "og"
    : (d.penaltyKick || /penalty/.test(text)) && (d.scoringPlay || /scored|goal/.test(text)) ? "pen"
    : d.scoringPlay || /goal/.test(text) ? "goal"
    : d.redCard || /red card/.test(text) ? "red"
    : d.yellowCard || /yellow/.test(text) ? "yellow" : null;
  return {
    kind,
    min: d.clock?.displayValue || "",
    team: String(d.team?.id ?? ""),
    name: p.shortName || p.displayName || "",
    shootout: !!d.shootout,
  };
}

async function matchEvents(env, q) {
  const league = ESPN_LEAGUE[q.get("comp")];
  const kickoff = new Date(q.get("date") || "");
  const home = [q.get("home"), q.get("homeShort")].filter(Boolean);
  const away = [q.get("away"), q.get("awayShort")].filter(Boolean);
  if (!league || isNaN(kickoff) || !home.length || !away.length) throw new Error("Missing comp, date, home or away");

  const live = Math.abs(Date.now() - kickoff) < 4 * 3600e3;
  // ESPN groups games by US time, so also try the neighbouring days
  for (const offset of [0, -1, 1]) {
    const day = ymd(new Date(kickoff.getTime() + offset * 86400e3));
    const events = await espnScoreboard(env, league, day, live);
    let best = null, bestScore = 0;
    for (const e of events) {
      const h = e.teams.find((t) => t.side === "h"), a = e.teams.find((t) => t.side === "a");
      if (!h || !a) continue;
      const sh = similarity(home, h.team), sa = similarity(away, a.team);
      if (sh > 0 && sa > 0 && sh + sa > bestScore) { best = e; bestScore = sh + sa; }
    }
    if (best) {
      const side = {};
      best.teams.forEach((t) => (side[t.id] = t.side));
      // Stats once the game has started; line-ups from about an hour before kick-off
      let extra = {};
      if (best.state !== "pre" || kickoff - Date.now() < 75 * 60e3) {
        try { extra = await espnSummary(env, league, best.id, best.state, side); }
        catch (e) { console.warn("ESPN summary failed:", e.message); }
      }
      return {
        found: true,
        source: "ESPN",
        status: best.status,
        state: best.state,
        score: ["h", "a"].map((s) => best.teams.find((t) => t.side === s)?.score ?? null),
        events: best.details
          .filter((d) => d.kind && d.kind !== "yellow")
          .map((d) => ({ ...d, side: side[d.team] || null })),
        stats: extra.stats || [],
        lineups: extra.lineups || null,
        ...(q.has("debug") ? { debug: extra.debug || null } : {}),
      };
    }
  }
  return { found: false, events: [] };
}

/* ---------- match stats & line-ups (ESPN match summary) ---------- */

// ESPN stat name -> label shown in the app, in display order
const STAT_LABELS = [
  ["possessionPct", "Possession"],
  ["totalShots", "Shots"],
  ["shotsOnTarget", "On target"],
  ["wonCorners", "Corners"],
  ["foulsCommitted", "Fouls"],
  ["yellowCards", "Yellow cards"],
  ["redCards", "Red cards"],
  ["offsides", "Offsides"],
  ["saves", "Saves"],
];

async function espnSummary(env, league, eventId, state, sideById) {
  // Finished games are cached for 6 hours, but only once ESPN has actually filled in the
  // stats/line-ups. ESPN often adds them a while after the final whistle, and its feed can lag,
  // so an empty result is retried every 2 minutes instead of being stuck for hours.
  const key = `sum:${eventId}`;
  const prev = mem.get(key)?.value;
  const complete = prev && prev.stats.length && prev.lineups;
  const ttl = state === "post" && complete ? 6 * 3600 : state === "post" ? 120 : 60;
  return cached(env, key, ttl, async () => {
    const res = await fetch(`${ESPN}/${league}/summary?event=${eventId}`, { headers: { "User-Agent": "FOOTEXT personal app" } });
    if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
    const j = await res.json();
    const sideOf = (x) => (x?.homeAway === "home" ? "h" : x?.homeAway === "away" ? "a" : sideById[String(x?.team?.id)] || null);

    // Team stats. Before kick-off ESPN puts season totals here, so only use them once the game is on.
    let stats = [];
    if (state !== "pre") {
      const bySide = {};
      for (const t of j.boxscore?.teams || []) {
        const sd = sideOf(t);
        if (!sd) continue;
        bySide[sd] = Object.fromEntries((t.statistics || []).map((x) => [x.name, x.displayValue ?? x.value]));
      }
      if (bySide.h && bySide.a) {
        stats = STAT_LABELS
          .filter(([k]) => bySide.h[k] != null && bySide.a[k] != null)
          .map(([k, label]) => {
            let h = String(bySide.h[k]), a = String(bySide.a[k]);
            if (k === "possessionPct") { h = `${Math.round(parseFloat(h))}%`; a = `${Math.round(parseFloat(a))}%`; }
            return [label, h, a];
          });
      }
    }

    // Line-ups
    let lineups = null;
    for (const r of j.rosters || []) {
      const sd = sideOf(r);
      const players = (r.roster || []).map((p) => ({
        n: p.athlete?.lastName || p.athlete?.shortName || p.athlete?.displayName || "?",
        no: p.jersey ?? p.athlete?.jersey ?? "",
        pos: p.position?.abbreviation || "",
        start: !!p.starter,
        on: !!p.subbedIn,
        off: !!p.subbedOut,
        place: Number(p.formationPlace) || 99,
      }));
      if (!sd || !players.length) continue;
      lineups = lineups || {};
      lineups[sd] = {
        formation: r.formation || null,
        starters: players.filter((p) => p.start).sort((x, y) => x.place - y.place),
        subsUsed: players.filter((p) => !p.start && p.on),
      };
    }
    if (lineups && !(lineups.h && lineups.a)) lineups = null;
    // Small diagnostic block: what ESPN actually sent (see /events?...&debug)
    const debug = {
      summaryState: j.header?.competitions?.[0]?.status?.type?.state || null,
      statNames: (j.boxscore?.teams?.[0]?.statistics || []).map((x) => x.name).slice(0, 30),
      rosterSizes: (j.rosters || []).map((r) => (r.roster || []).length),
    };
    return { stats, lineups, debug };
  });
}
