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
const MATCHES_TTL = 60;        // seconds - scores refresh at most once a minute
const TABLES_TTL = 5 * 60;     // league tables change less often
const NEWS_TTL = 15 * 60;

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
    try {
      let body;
      if (url.pathname === "/football") body = await football(env);
      else if (url.pathname === "/news") body = await news(env, url.searchParams.get("team") || "");
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

async function cached(env, key, ttl, loader) {
  const now = Date.now();
  let hit = mem.get(key);
  if (!hit && env.CACHE) {
    const raw = await env.CACHE.get(key);
    if (raw) { hit = JSON.parse(raw); mem.set(key, hit); }
  }
  if (hit && now - hit.at < ttl * 1000) return hit.value;
  try {
    const value = await loader();
    const entry = { at: now, value };
    mem.set(key, entry);
    if (env.CACHE) await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: 7 * 86400 });
    return value;
  } catch (e) {
    if (hit) return hit.value;     // serve stale rather than nothing (e.g. rate limited)
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

async function football(env) {
  const out = { updated: null, comps: {}, teams: {} };
  let oldest = Infinity;
  // Sequential on purpose: keeps us well inside the free tier's 10 requests/minute.
  for (const code of COMPS) {
    const m = await cached(env, `matches:${code}`, MATCHES_TTL, async () => compactMatches(await fd(env, `/competitions/${code}/matches`)));
    const t = await cached(env, `tables:${code}`, TABLES_TTL, async () => compactTables(await fd(env, `/competitions/${code}/standings`)));
    Object.assign(out.teams, m.teams, t.teams);
    out.comps[code] = { name: m.name, matches: m.matches, tables: t.tables };
    const at = mem.get(`matches:${code}`)?.at;
    if (at && at < oldest) oldest = at;
  }
  out.updated = new Date(oldest === Infinity ? Date.now() : oldest).toISOString();
  return out;
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
