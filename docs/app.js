/* FOOTEXT - teletext-style football scores.
 * Data comes from data/football.json, refreshed by a GitHub Action. */
"use strict";

const W = 40;                       // teletext width in characters
const TZ = "Europe/London";
const API = (window.FOOTEXT_API || "").replace(/\/$/, "");
const DATA_URL = API ? `${API}/football` : "data/football.json";
const REFRESH_MS = 60 * 1000;
const FAV_KEY = "footext.favTeam";

const COMPS = {
  PL:  { label: "PREMIER LEAGUE",   tag: "PL", bg: "bg-m", base: 310 },
  ELC: { label: "CHAMPIONSHIP",     tag: "CH", bg: "bg-c", base: 320 },
  CL:  { label: "CHAMPIONS LEAGUE", tag: "CL", bg: "bg-b", base: 330 },
};

let data = null;
let loadError = null;
let current = 300;
let typed = "";
let pageArg;                        // e.g. the match id on page 390

/* ---------- small text helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const fit = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s).padEnd(n));
const rfit = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s).padStart(n));
const centre = (s, n) => { s = String(s).slice(0, n); const l = Math.floor((n - s.length) / 2); return " ".repeat(l) + s + " ".repeat(n - s.length - l); };
const seg = (text, cls = "") => (cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));

function row(html, opts = {}) {
  const attrs = [];
  const cls = ["row"];
  if (opts.cls) cls.push(opts.cls);
  if (opts.goto) attrs.push(`data-goto="${opts.goto}"`);
  if (opts.team != null) attrs.push(`data-team="${opts.team}"`);
  if (opts.href) attrs.push(`data-href="${esc(opts.href)}"`);
  if (opts.match != null) attrs.push(`data-match="${opts.match}"`);
  return `<div class="${cls.join(" ")}" ${attrs.join(" ")}>${html}</div>`;
}
const blank = () => row(" ".repeat(W));
const text = (s, cls) => row(seg(fit(s, W), cls));

function title(label, bg) {
  // Double-height coloured title band
  return `<div class="row dh ${bg}"><span class="dhtext k">${esc(centre(label, W))}</span></div>`;
}

/* ---------- dates ---------- */

const fmt = (opts) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts });
const fTime = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const fDayKey = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
const fLongDay = fmt({ weekday: "long", day: "numeric", month: "long" });
const fShortDay = fmt({ weekday: "short", day: "2-digit", month: "short" });
const fHeaderDay = fmt({ weekday: "short", day: "2-digit", month: "short" });
const fClock = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const dayKey = (d) => fDayKey.format(new Date(d)).split("/").reverse().join("-");
const todayKey = () => dayKey(Date.now());
const DAY = 86400000;

/* ---------- data access ---------- */

const teamName = (id) => (data?.teams?.[id]?.s) || "TBC";
const favId = () => { const v = localStorage.getItem(FAV_KEY); return v ? Number(v) : null; };

function allMatches(codes = Object.keys(COMPS)) {
  const out = [];
  for (const c of codes) for (const m of data?.comps?.[c]?.matches || []) out.push({ ...m, comp: c });
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

const isLive = (m) => m.st === "IN_PLAY" || m.st === "PAUSED";
const isDone = (m) => m.st === "FINISHED" || m.st === "AWARDED";
const isUpcoming = (m) => m.st === "SCHEDULED" || m.st === "TIMED";

function statusTag(m) {
  switch (m.st) {
    case "IN_PLAY": return m.mn ? `${m.mn}'` : "LIVE";
    case "PAUSED": return "HT";
    case "FINISHED": return m.du === "PENALTY_SHOOTOUT" ? "PENS" : m.du === "EXTRA_TIME" ? "AET" : "FT";
    case "AWARDED": return "AWD";
    case "POSTPONED": return "P-P";
    case "SUSPENDED": return "SUSP";
    case "CANCELLED": return "CANC";
    default: return fTime.format(new Date(m.d));
  }
}

function scoreText(m) {
  if (isDone(m) || isLive(m)) {
    const [h, a] = m.ft;
    return h == null ? " v " : `${h}-${a}`;
  }
  return " v ";
}

const STAGES = {
  LEAGUE_STAGE: "League phase", PLAYOFFS: "Knockout play-offs", LAST_16: "Round of 16",
  QUARTER_FINALS: "Quarter-finals", SEMI_FINALS: "Semi-finals", FINAL: "Final",
  PLAYOFF_ROUND_1: "Play-offs", PLAYOFF_ROUND_2: "Play-offs",
};

/* A match line: home(14) score(5) away(13) status(5) = 40 cols */
function matchRow(m, showComp = false) {
  const fav = favId();
  const isFav = fav != null && (m.h === fav || m.a === fav);
  const live = isLive(m);
  let home = teamName(m.h), away = teamName(m.a);
  const tag = statusTag(m);
  const tagCls = live ? "g flash" : isDone(m) ? "c" : (m.st === "POSTPONED" || m.st === "CANCELLED") ? "r" : "w";
  let pre = "";
  if (showComp) { pre = seg(COMPS[m.comp].tag + " ", "m"); home = home; }
  const homeW = showComp ? 11 : 14;
  const html =
    pre +
    seg(fit(home, homeW), "w") + " " +
    seg(centre(scoreText(m), 5), live ? "g" : "y") + " " +
    seg(fit(away, 13), "w") + " " +
    seg(rfit(tag, 5), tagCls);
  return row(html, { cls: isFav ? "fav" : "", match: isLive(m) || isDone(m) ? m.id : null });
}

function groupByDay(matches) {
  const groups = new Map();
  for (const m of matches) {
    const k = dayKey(m.d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return groups;
}

function dayHeader(m, extra = "") {
  const label = fLongDay.format(new Date(m.d));
  return text(extra ? `${label} - ${extra}` : label, "y");
}

/* ---------- pages ---------- */

const pages = {};
function page(num, def) { pages[num] = def; }

// The league table your favourite team plays in (domestic league first), else the Prem
function homeLeague() {
  const id = favId();
  const code = id && ["PL", "ELC", "CL"].find((c) => data?.comps?.[c]?.tables?.some((t) => t.rows.some((r) => r.id === id)));
  const label = { PL: "Prem", ELC: "Champ", CL: "UCL" }[code || "PL"];
  return [label, COMPS[code || "PL"].base + 3];
}

page(300, {
  fastext: [["Scores", 301], ["My team", 302], ["Prem", 313], ["Teams", 399]],
  fastextDynamic() { return [["Scores", 301], ["My team", 302], homeLeague(), ["Teams", 399]]; },
  render() {
    const L = [];
    L.push(title("FOOTEXT  FOOTBALL", "bg-g"));
    L.push(blank());
    const item = (num, label, cls = "w") =>
      row(seg(fit(" " + label, W - 5), cls) + seg(rfit(num, 4) + " ", "y"), { goto: num });
    L.push(item(301, "Latest scores", "c"));
    L.push(item(302, "My team", "c"));
    L.push(item(303, "My team: transfers", "c"));
    L.push(blank());
    for (const [code, c] of Object.entries(COMPS)) {
      L.push(text(" " + c.label, "g"));
      L.push(item(c.base + 1, "  Results"));
      L.push(item(c.base + 2, "  Fixtures"));
      L.push(item(c.base + 3, c.code === "CL" ? "  League phase table" : "  Table"));
      L.push(blank());
    }
    L.push(item(399, "Choose favourite team", "m"));
    L.push(blank());
    if (data?.updated) L.push(text(` Updated ${fShortDay.format(new Date(data.updated))} ${fTime.format(new Date(data.updated))}`, "b"));
    L.push(text(" Tap a line or key in a page number", "b"));
    return L;
  },
});

page(301, {
  fastext: [["Index", 300], ["My team", 302], ["Prem", 311], ["Champ", 321]],
  render() {
    const L = [title("LATEST SCORES", "bg-y")];
    const ms = allMatches();
    const tk = todayKey();
    let shown = ms.filter((m) => isLive(m) || dayKey(m.d) === tk);
    let heading = "Today";
    if (!shown.length) {
      // Most recent day with results, then the next day with fixtures
      const past = ms.filter(isDone);
      const lastDay = past.length ? dayKey(past[past.length - 1].d) : null;
      shown = lastDay ? past.filter((m) => dayKey(m.d) === lastDay) : [];
      heading = shown.length ? fLongDay.format(new Date(shown[0].d)) : "";
      L.push(blank());
      L.push(text(" No matches today", "c"));
    }
    if (shown.length) {
      L.push(blank());
      L.push(text(heading, "y"));
      for (const code of Object.keys(COMPS)) {
        const cm = shown.filter((m) => m.comp === code);
        if (!cm.length) continue;
        L.push(text(COMPS[code].label, "g"));
        cm.forEach((m) => L.push(matchRow(m)));
      }
    }
    const next = ms.find((m) => isUpcoming(m) && dayKey(m.d) > tk);
    if (next) {
      const nk = dayKey(next.d);
      const nm = ms.filter((m) => dayKey(m.d) === nk);
      L.push(blank());
      L.push(text(`Next: ${fLongDay.format(new Date(next.d))}`, "y"));
      nm.slice(0, 14).forEach((m) => L.push(matchRow(m, true)));
      if (nm.length > 14) L.push(text(` ...and ${nm.length - 14} more`, "c"));
    }
    return L;
  },
});

page(302, {
  fastext: [["Index", 300], ["Table", null], ["Transfers", 303], ["Teams", 399]],
  fastextDynamic() {
    const id = favId();
    const comp = id && ["PL", "ELC", "CL"].find((c) => data?.comps?.[c]?.tables?.some((t) => t.rows.some((r) => r.id === id)));
    return [["Index", 300], ["Table", comp ? COMPS[comp].base + 3 : null], ["Transfers", 303], ["Teams", 399]];
  },
  render() {
    const id = favId();
    if (!id || !data?.teams?.[id]) {
      return [title("MY TEAM", "bg-b"), blank(), text(" No favourite team chosen yet.", "w"), blank(),
        row(seg(fit(" Choose one on page", W - 5), "c") + seg("399  ", "y"), { goto: 399 })];
    }
    const L = [title(teamName(id).toUpperCase(), "bg-b")];
    // League positions
    for (const code of Object.keys(COMPS)) {
      for (const t of data.comps[code]?.tables || []) {
        const r = t.rows.find((x) => x.id === id);
        if (r) L.push(row(
          seg(fit(` ${COMPS[code].label}`, 20), "g") +
          seg(fit(`${ordinal(r.p)}`, 6), "y") +
          seg(rfit(`${r.pts} pts`, 8), "w") + seg(rfit(`P${r.pl}`, 5), "c") + " ",
          { goto: COMPS[code].base + 3 }));
      }
    }
    const mine = allMatches().filter((m) => m.h === id || m.a === id);
    const live = mine.filter(isLive);
    if (live.length) {
      L.push(blank());
      L.push(text("LIVE", "g flash"));
      live.forEach((m) => L.push(matchRow(m, true)));
    }
    const done = mine.filter(isDone).slice(-6).reverse();
    L.push(blank());
    L.push(text("RESULTS", "y"));
    if (!done.length) L.push(text(" None yet", "c"));
    done.forEach((m) => L.push(teamLine(m, id)));
    const form = mine.filter(isDone).slice(-5).map((m) => outcome(m, id)).join(" ");
    if (form) L.push(row(seg(" Form: ", "c") + form.split(" ").map((x) => seg(x, x === "W" ? "g" : x === "L" ? "r" : "y")).join(" ") + " ".repeat(Math.max(0, W - 7 - form.length))));
    const next = mine.filter((m) => !isDone(m) && !isLive(m) && new Date(m.d) > Date.now() - 3 * 3600e3).slice(0, 8);
    L.push(blank());
    L.push(text("FIXTURES", "y"));
    if (!next.length) L.push(text(" None scheduled", "c"));
    next.forEach((m) => L.push(teamLine(m, id)));
    return L;
  },
});

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function outcome(m, id) {
  const [h, a] = m.ft;
  if (h == null) return "-";
  const us = m.h === id ? h : a, them = m.h === id ? a : h;
  if (us > them) return "W";
  if (us < them) return "L";
  if (m.pn) { const [ph, pa] = m.pn; const pu = m.h === id ? ph : pa, pt = m.h === id ? pa : ph; return pu > pt ? "W" : "L"; }
  return "D";
}

/* Team-centric line: date(10) comp(2) H/A opponent(15) result(8) */
function teamLine(m, id) {
  const home = m.h === id;
  const opp = teamName(home ? m.a : m.h);
  let res, cls = "w";
  if (isDone(m)) {
    const o = outcome(m, id);
    const [h, a] = m.ft;
    res = `${o} ${home ? h : a}-${home ? a : h}`;
    cls = o === "W" ? "g" : o === "L" ? "r" : "y";
  } else if (isLive(m)) {
    res = `${m.ft[0] ?? 0}-${m.ft[1] ?? 0} ${statusTag(m)}`;
    cls = "g";
  } else {
    res = statusTag(m);
  }
  return row(
    seg(fit(fShortDay.format(new Date(m.d)).replace(",", ""), 10), "c") + " " +
    seg(COMPS[m.comp].tag, "m") + " " +
    seg(home ? "H" : "A", "b") + " " +
    seg(fit(opp, 15), "w") + " " +
    seg(rfit(res, 7), cls) + " ", { match: isLive(m) || isDone(m) ? m.id : null });
}

/* Competition pages: x1 results, x2 fixtures, x3 table */
for (const [code, c] of Object.entries(COMPS)) {
  c.code = code;
  const fx = (active) => {
    const items = [["Results", c.base + 1], ["Fixtures", c.base + 2], ["Table", c.base + 3], ["Index", 300]];
    return items.map(([l, n]) => (n === active ? [l, null] : [l, n]));
  };

  page(c.base + 1, {
    fastext: fx(c.base + 1),
    render() {
      const L = [title(c.label, c.bg), text("RESULTS", "y")];
      const ms = allMatches([code]).filter((m) => isDone(m) || isLive(m) || m.st === "POSTPONED" && new Date(m.d) < Date.now());
      // Show the last 14 days of action, or at least the last 2 matchdays' worth
      const cutoff = Date.now() - 14 * DAY;
      let recent = ms.filter((m) => new Date(m.d) >= cutoff);
      if (recent.length < 10) recent = ms.slice(-20);
      if (!recent.length) return [...L, blank(), text(" No results yet this season", "c")];
      const groups = [...groupByDay(recent).values()].reverse();
      for (const g of groups) {
        L.push(blank());
        L.push(dayHeader(g[0], code === "CL" ? STAGES[g[0].sg] : ""));
        g.forEach((m) => L.push(matchRow(m)));
      }
      return L;
    },
  });

  page(c.base + 2, {
    fastext: fx(c.base + 2),
    render() {
      const L = [title(c.label, c.bg), text("FIXTURES", "y")];
      const ms = allMatches([code]).filter((m) => (isUpcoming(m) || isLive(m) || m.st === "POSTPONED") && new Date(m.d) > Date.now() - 3 * 3600e3);
      let upcoming = ms.filter((m) => new Date(m.d) < Date.now() + 28 * DAY);
      if (upcoming.length < 10) upcoming = ms.slice(0, 20);
      if (!upcoming.length) return [...L, blank(), text(" No fixtures scheduled", "c")];
      for (const g of groupByDay(upcoming).values()) {
        L.push(blank());
        L.push(dayHeader(g[0], code === "CL" ? STAGES[g[0].sg] : ""));
        g.forEach((m) => L.push(matchRow(m)));
      }
      return L;
    },
  });

  page(c.base + 3, {
    fastext: fx(c.base + 3),
    render() {
      const L = [title(c.label, c.bg)];
      const tables = data?.comps?.[code]?.tables || [];
      if (!tables.length) return [...L, blank(), text(" Table not available", "c")];
      const fav = favId();
      for (const t of tables) {
        if (tables.length > 1 && t.name) L.push(text(t.name.replace(/_/g, " "), "y"));
        // pos(2) team(16) P W D L GD Pts = 39
        L.push(row(seg(rfit("#", 2) + " " + fit("Team", 16) + " " + [" P", " W", " D", " L"].join(" ") + " " + rfit("GD", 3) + " " + rfit("Pts", 3) + " ", "c")));
        const n = t.rows.length;
        for (const r of t.rows) {
          const zone = zoneColour(code, r.p, n);
          L.push(row(
            seg(rfit(r.p, 2), zone) + " " +
            seg(fit(teamName(r.id), 16), "w") + " " +
            seg(rfit(r.pl, 2) + " " + rfit(r.w, 2) + " " + rfit(r.d, 2) + " " + rfit(r.l, 2), "w") + " " +
            seg(rfit((r.gd > 0 ? "+" : "") + r.gd, 3), "c") + " " +
            seg(rfit(r.pts, 3), "y") + " ",
            { cls: r.id === fav ? "fav" : "" }));
        }
      }
      L.push(blank());
      L.push(...legend(code));
      return L;
    },
  });
}

function zoneColour(code, p, n) {
  if (code === "PL") return p <= 4 ? "g" : p <= 5 ? "c" : p > n - 3 ? "r" : "w";
  if (code === "ELC") return p <= 2 ? "g" : p <= 6 ? "c" : p > n - 3 ? "r" : "w";
  if (code === "CL") return p <= 8 ? "g" : p <= 24 ? "c" : "r";
  return "w";
}

function legend(code) {
  const l = (cls, s) => seg("##", cls) + seg(" " + s, "w");
  if (code === "PL") return [row(l("g", "Champions League ") + l("c", "Europe  ") + l("r", "Down "))];
  if (code === "ELC") return [row(l("g", "Promoted  ") + l("c", "Play-offs  ") + l("r", "Down   "))];
  return [row(l("g", "Last 16  ") + l("c", "Play-offs  ") + l("r", "Out       "))];
}

page(399, {
  fastext: [["Index", 300], ["My team", 302], ["Clear", "clear"], [" ", null]],
  render() {
    const L = [title("CHOOSE YOUR TEAM", "bg-m"), text(" Tap a team to set it as your favourite", "c")];
    if (!data) return L;
    const fav = favId();
    const seen = new Set();
    for (const [code, c] of Object.entries(COMPS)) {
      const ids = (data.comps[code]?.tables?.flatMap((t) => t.rows.map((r) => r.id)) || [])
        .filter((id) => !seen.has(id));
      if (!ids.length) continue;
      ids.sort((a, b) => teamName(a).localeCompare(teamName(b)));
      L.push(blank());
      L.push(text(code === "CL" ? "EUROPE" : c.label, "y"));
      for (const id of ids) {
        seen.add(id);
        const on = id === fav;
        L.push(row(seg(fit(`  ${data.teams[id].n}`, W - 3), on ? "y" : "w") + seg(on ? " * " : "   ", "y"),
          { team: id, cls: on ? "fav" : "" }));
      }
    }
    return L;
  },
});

/* ---------- 303: transfers for the favourite team ----------
 * Confirmed deals: the club's Wikipedia season article ("Transfers" tables only list completed moves).
 * News: BBC Sport headlines, filtered by the Worker to confirmed moves only. */

const transfers = {};        // teamId -> { status, wiki, news, error }
const TRANSFER_TTL = 3 * 3600e3;

function seasonLabel(d = new Date()) {
  const y = d.getUTCFullYear(), start = d.getUTCMonth() >= 6 ? y : y - 1;   // season starts in July
  return `${start}–${String(start + 1).slice(2)}`;
}

const cleanClub = (n) => n.replace(/\b(F\.?C\.?|A\.?F\.?C\.?)$/i, "").trim();

async function wikiJson(params) {
  const q = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${q}`);
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

async function findSeasonArticle(club) {
  const season = seasonLabel();
  const r = await wikiJson({ action: "query", list: "search", srlimit: "8",
    srsearch: `intitle:"${season}" intitle:season ${club}` });
  const hits = (r.query?.search || []).map((h) => h.title)
    .filter((t) => t.startsWith(season) && /season$/i.test(t) && !/women/i.test(t));
  const words = club.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  hits.sort((a, b) => score(b) - score(a));
  function score(t) { t = t.toLowerCase(); return words.filter((w) => t.includes(w)).length; }
  return hits.length && score(hits[0]) > 0 ? hits[0] : null;
}

// Turn an HTML table into a grid, expanding rowspan/colspan
function tableGrid(table) {
  const grid = [];
  [...table.rows].forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c] !== undefined) c++;
      cell.querySelectorAll("sup, .reference, style, .sortkey").forEach((x) => x.remove());
      const txt = cell.textContent.replace(/\s+/g, " ").trim();
      const rs = Number(cell.rowSpan) || 1, cs = Number(cell.colSpan) || 1;
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) {
        grid[r + i] = grid[r + i] || [];
        grid[r + i][c + j] = { txt, th: cell.tagName === "TH" };
      }
      c += cs;
    }
  });
  return grid;
}

function parseTransfers(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const heads = [];                                   // heading stack by level
  const deals = [];
  for (const el of doc.querySelectorAll("h2, h3, h4, h5, table")) {
    if (/^H\d$/.test(el.tagName)) {
      const lvl = Number(el.tagName[1]);
      heads.length = lvl - 1;
      heads[lvl - 1] = el.textContent.replace(/\[edit\]/g, "").trim();
      continue;
    }
    const ctx = heads.filter(Boolean).join(" / ");
    if (!/transfer/i.test(ctx) || !el.classList.contains("wikitable")) continue;
    const grid = tableGrid(el);
    const hi = grid.findIndex((row) => row && row.some((c) => c?.th && /player|name/i.test(c.txt)));
    if (hi < 0) continue;
    const H = grid[hi].map((c) => (c?.txt || "").toLowerCase());
    const col = (re) => H.findIndex((h) => re.test(h));
    const iPlayer = col(/player|name/), iFee = col(/fee|price|cost/), iDate = col(/date/);
    const iFrom = col(/^from$|transferred from|from club|previous/), iTo = col(/^to$|transferred to|to club|new club|destination/);
    const iClub = iFrom >= 0 ? iFrom : iTo >= 0 ? iTo : col(/club|team/);
    let dir = iFrom >= 0 ? "in" : iTo >= 0 ? "out" : null;
    const last = (heads.filter(Boolean).pop() || "").toLowerCase();
    if (!dir) dir = /\bout\b|depart|outgoing|released|left/.test(last) ? "out" : /\bin\b|arriv|incoming|signing/.test(last) ? "in" : null;
    if (!dir || iPlayer < 0) continue;
    const loan = /loan/i.test(last) || /loan/i.test(ctx.split(" / ").pop() || "");
    for (const row of grid.slice(hi + 1)) {
      if (!row || !row[iPlayer] || row[iPlayer].th) continue;
      const player = row[iPlayer].txt;
      if (!player || /^total/i.test(player)) continue;
      deals.push({
        dir, loan, player,
        club: iClub >= 0 ? row[iClub]?.txt || "" : "",
        fee: loan ? "Loan" : iFee >= 0 ? row[iFee]?.txt || "" : "",
        date: iDate >= 0 ? row[iDate]?.txt || "" : "",
      });
    }
  }
  return deals;
}

function shortFee(f) {
  if (!f) return "";
  const t = f.replace(/\(.*?\)/g, "").trim();
  if (/loan/i.test(t)) return "Loan";
  if (/free/i.test(t)) return "Free";
  if (/undisclosed/i.test(t)) return "Undiscl";
  if (/released|end of contract|contract expir/i.test(t)) return "Rel'd";
  const m = t.match(/([£€$])\s?([\d.,]+)\s*(million|m\b|bn|k)?/i);
  if (m) {
    let n = parseFloat(m[2].replace(/,/g, ""));
    if (/million|m/i.test(m[3] || "")) n *= 1e6;
    if (/k/i.test(m[3] || "")) n *= 1e3;
    if (n >= 1e6) return `${m[1]}${+(n / 1e6).toFixed(1)}m`;
    if (n >= 1e3) return `${m[1]}${Math.round(n / 1e3)}k`;
    return `${m[1]}${n}`;
  }
  return t;
}

async function loadTransfers(id) {
  const key = `footext.transfers.${id}`;
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (c && Date.now() - c.at < TRANSFER_TTL) { transfers[id] = { status: "done", ...c }; if (current === 303) render(); return; }
    if (c) transfers[id] = { status: "loading", ...c };     // show old copy while refreshing
  } catch {}
  if (!transfers[id]) transfers[id] = { status: "loading" };
  const club = cleanClub(data.teams[id].n);
  const [wiki, news] = await Promise.all([
    (async () => {
      try {
        const title = await findSeasonArticle(club);
        if (!title) return { title: null, deals: [] };
        const p = await wikiJson({ action: "parse", page: title, prop: "text", redirects: "1" });
        return { title, deals: parseTransfers(p.parse.text) };
      } catch (e) { return { error: String(e.message || e), deals: [] }; }
    })(),
    (async () => {
      if (!API) return { error: "Needs the Cloudflare Worker (see README)", items: [] };
      try {
        const r = await fetch(`${API}/news?team=${encodeURIComponent(data.teams[id].n)}`);
        if (!r.ok) throw new Error(`news ${r.status}`);
        return await r.json();
      } catch (e) { return { error: String(e.message || e), items: [] }; }
    })(),
  ]);
  const entry = { at: Date.now(), wiki, news };
  transfers[id] = { status: "done", ...entry };
  if (!wiki.error && !news.error) try { localStorage.setItem(key, JSON.stringify(entry)); } catch {}
  if (current === 303) render();
}

function wrap(s, width) {
  const out = []; let line = "";
  for (const w of s.split(/\s+/)) {
    if ((line + " " + w).trim().length > width) { if (line) out.push(line); line = w.slice(0, width); }
    else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out;
}

page(303, {
  fastext: [["Index", 300], ["My team", 302], ["Scores", 301], ["Teams", 399]],
  render() {
    const id = favId();
    if (!id || !data?.teams?.[id]) {
      return [title("TRANSFERS", "bg-r"), blank(), text(" No favourite team chosen yet.", "w"), blank(),
        row(seg(fit(" Choose one on page", W - 5), "c") + seg("399  ", "y"), { goto: 399 })];
    }
    const L = [title(`${teamName(id).toUpperCase()} TRANSFERS`.slice(0, W), "bg-r")];
    const t = transfers[id];
    if (!t || (t.status === "loading" && !t.wiki)) {
      if (!t) setTimeout(() => loadTransfers(id), 0);
      return [...L, blank(), text(" Searching...", "g flash")];
    }
    if (t.status === "loading") L.push(text(" Refreshing...", "g flash"));

    // Confirmed deals from Wikipedia
    const deals = t.wiki?.deals || [];
    const section = (label, list) => {
      L.push(blank());
      L.push(row(seg(fit(label, 22), "y") + seg(rfit(list.length ? `${list.length} deals` : "", 18), "c")));
      if (!list.length) { L.push(text(" None yet this season", "c")); return; }
      // Wikipedia lists oldest first; show newest first
      for (const d of [...list].reverse().slice(0, 15)) {
        L.push(row(
          seg(fit(d.player, 17), "w") + " " +
          seg(fit(d.club.replace(/\b(F\.?C\.?|A\.?F\.?C\.?)$/i, "").trim(), 14), "c") + " " +
          seg(rfit(shortFee(d.fee), 7), d.loan ? "m" : "g")));
      }
      if (list.length > 15) L.push(text(` ...and ${list.length - 15} more`, "c"));
    };
    if (t.wiki?.title) {
      section("SIGNED", deals.filter((d) => d.dir === "in"));
      section("LEFT", deals.filter((d) => d.dir === "out"));
    } else {
      L.push(blank());
      L.push(text(t.wiki?.error ? " Couldn't reach Wikipedia" : ` No ${seasonLabel()} season page found`, "c"));
    }

    // BBC headlines
    L.push(blank());
    L.push(text("LATEST CONFIRMED MOVES - BBC SPORT", "y"));
    const items = t.news?.items || [];
    if (t.news?.error) L.push(text(` ${t.news.error}`, "r"));
    else if (!items.length) L.push(text(" No confirmed transfer news lately", "c"));
    for (const n of items) {
      const when = n.date ? fShortDay.format(new Date(n.date)).replace(",", "") : "";
      L.push(row(seg(fit(when, W), "c"), { href: n.link }));
      for (const line of wrap(n.title, W - 1)) L.push(row(seg(fit(" " + line, W), "w"), { href: n.link }));
    }

    L.push(blank());
    if (t.wiki?.title) {
      L.push(row(seg(fit(` Source: Wikipedia, ${t.wiki.title}`, W), "b"),
        { href: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.wiki.title.replace(/ /g, "_"))}` }));
    }
    L.push(text(" Tap a headline to read it", "b"));
    return L;
  },
});

/* ---------- 390: match detail (scorers & red cards from ESPN via the Worker) ---------- */

const matchInfo = {};        // match id -> { status: "loading"|"done", at, data, error }

function findMatch(id) {
  return allMatches().find((m) => String(m.id) === String(id));
}

async function loadMatchInfo(m) {
  const prev = matchInfo[m.id];
  matchInfo[m.id] = { ...(prev || {}), status: "loading" };
  try {
    if (!API) throw new Error("Needs the Cloudflare Worker (see README)");
    const T = data.teams;
    const q = new URLSearchParams({
      comp: m.comp, date: m.d,
      home: T[m.h]?.n || "", homeShort: T[m.h]?.s || "",
      away: T[m.a]?.n || "", awayShort: T[m.a]?.s || "",
    });
    const r = await fetch(`${API}/events?${q}`);
    if (!r.ok) throw new Error(`events ${r.status}`);
    matchInfo[m.id] = { status: "done", at: Date.now(), data: await r.json() };
  } catch (e) {
    matchInfo[m.id] = { ...(prev || {}), status: "done", at: Date.now(), error: String(e.message || e) };
  }
  if (current === 390 && String(pageArg) === String(m.id)) render();
}

const matchArg = () => { const [id, view] = String(pageArg || "").split("/"); return { id, lineups: view === "lineups" }; };

page(390, {
  fastextDynamic() {
    const { id, lineups } = matchArg();
    const m = findMatch(id);
    const base = m ? COMPS[m.comp].base : 310;
    return [["Back", "back"], lineups ? ["Stats", `390/${id}`] : ["Lineups", `390/${id}/lineups`],
      ["Table", base + 3], ["Index", 300]];
  },
  render() {
    const { id, lineups } = matchArg();
    const m = findMatch(id);
    if (!m) return [title("MATCH", "bg-w"), blank(), text(" Match not found", "c")];
    const c = COMPS[m.comp];
    const L = [title(c.label, c.bg)];
    const stage = m.comp === "CL" && STAGES[m.sg] ? STAGES[m.sg] : m.md ? `Matchday ${m.md}` : "";
    L.push(text(centre(`${fLongDay.format(new Date(m.d))}${stage ? "  " + stage : ""}`, W), "c"));
    L.push(blank());

    // Big score line: home | score | away
    const [h, a] = m.ft;
    const sc = h == null ? "v" : `${h}-${a}`;
    L.push(`<div class="row dh"><span class="dhtext">` +
      seg(fit(teamName(m.h), 16), "w") + seg(centre(sc, 8), isLive(m) ? "g" : "y") + seg(rfit(teamName(m.a), 16), "w") +
      `</span></div>`);
    let st = statusTag(m);
    if (m.st === "FINISHED" && m.ht[0] != null) st = `FT  (HT ${m.ht[0]}-${m.ht[1]})`;
    if (m.pn) st += `  Pens ${m.pn[0]}-${m.pn[1]}`;
    L.push(text(centre(st, W), isLive(m) ? "g flash" : "c"));
    L.push(blank());

    // Details from ESPN (via the Worker); refreshed every minute while live
    let info = matchInfo[m.id];
    const stale = info && isLive(m) && Date.now() - (info.at || 0) > 60e3;
    if ((!info || stale) && info?.status !== "loading") {
      setTimeout(() => loadMatchInfo(m), 0);
      if (!info) return [...L, text(" Loading...", "g flash")];
    }
    if (info.error && !info.data) return [...L, text(` ${info.error}`, "r")];
    const d = info.data;
    if (!d?.found) return [...L, text(" Match details not available", "c")];

    if (lineups) renderLineups(L, d);
    else renderSummary(L, d, h, a);

    L.push(blank());
    L.push(text(` Source: ESPN${info.status === "loading" ? "  (updating)" : ""}`, "b"));
    return L;
  },
});

function renderSummary(L, d, h, a) {
  // Scorers and red cards
  const evs = d.events.filter((e) => !e.shootout);
  if (!evs.length) L.push(text(centre(h === 0 && a === 0 ? "No goals" : "No details yet", W), "c"));
  for (const e of evs) {
    const tag = e.kind === "pen" ? " (pen)" : e.kind === "og" ? " (og)" : "";
    const red = e.kind === "red";
    // Always keep the minute: shorten the name instead
    const room = 19 - tag.length - e.min.length - 1;
    const label = `${e.name.length > room ? e.name.slice(0, room) : e.name}${tag} ${e.min}`.trim();
    const cls = red ? "r" : "w";
    const mark = red ? seg("\u258c", "r") : seg(" ");
    if (e.side === "a") L.push(row(" ".repeat(20) + seg(rfit(label, 19), cls) + mark));
    else L.push(row(mark + seg(fit(label, 19), cls) + " ".repeat(20)));
  }
  if (evs.some((e) => e.kind === "red")) L.push(row(seg("\u258c", "r") + seg(fit(" Sent off", W - 1), "w")));

  // Match stats
  if (d.stats?.length) {
    L.push(blank());
    L.push(text(centre("MATCH STATS", W), "y"));
    for (const [label, hv, av] of d.stats) {
      L.push(row(" " + seg(rfit(hv, 5), "w") + seg(centre(label, 28), "c") + seg(fit(av, 5), "w") + " "));
      if (label === "Possession") {
        // Teletext-style bar: home share in cyan, away in magenta
        const pct = Math.max(0, Math.min(100, parseFloat(hv) || 50));
        const n = Math.round((pct / 100) * 38);
        L.push(row(" " + `<span class="bg-c">${" ".repeat(n)}</span><span class="bg-m">${" ".repeat(38 - n)}</span>` + " "));
      }
    }
  } else if (d.state === "pre") {
    L.push(blank());
    L.push(text(centre("Stats appear once the game starts", W), "c"));
  }
}

function renderLineups(L, d) {
  const lu = d.lineups;
  L.push(text(centre("LINE-UPS", W), "y"));
  if (!lu) {
    L.push(blank());
    L.push(text(centre("Not available yet", W), "c"));
    L.push(text(centre("(usually out an hour before kick-off)", W), "c"));
    return;
  }
  L.push(row(seg(fit(" " + (lu.h.formation || ""), 20), "c") + seg(rfit((lu.a.formation || "") + " ", 20), "c")));
  const name = (p) => `${p.no ? p.no + " " : ""}${p.n}`;
  const rows = Math.max(lu.h.starters.length, lu.a.starters.length);
  for (let i = 0; i < rows; i++) {
    const hp = lu.h.starters[i], ap = lu.a.starters[i];
    L.push(row(
      seg(fit(hp ? " " + name(hp) : "", 20), hp?.off ? "b" : "w") +
      seg(rfit(ap ? name(ap) + " " : "", 20), ap?.off ? "b" : "w")));
  }
  const hs = lu.h.subsUsed, as = lu.a.subsUsed;
  if (hs.length || as.length) {
    L.push(blank());
    L.push(text(centre("ON AS SUBSTITUTES", W), "y"));
    for (let i = 0; i < Math.max(hs.length, as.length); i++) {
      L.push(row(seg(fit(hs[i] ? " " + name(hs[i]) : "", 20), "g") + seg(rfit(as[i] ? name(as[i]) + " " : "", 20), "g")));
    }
    L.push(blank());
    L.push(row(seg(" Blue", "b") + seg(fit(" = substituted off", W - 5), "w")));
  }
}

/* ---------- rendering ---------- */

function header() {
  const num = typed ? (typed + "---").slice(0, 3) : String(current);
  const now = new Date();
  const left = `P${num}`.padEnd(5) + " FOOTEXT " + String(current).padEnd(4);
  const day = fHeaderDay.format(now).replace(",", "");
  const clock = fClock.format(now).replace(/:(\d\d)$/, "/$1");
  const space = W - left.length - day.length - clock.length - 1;
  document.getElementById("header").innerHTML =
    seg(`P${num}`.padEnd(5), typed ? "g" : "w") + seg(" FOOTEXT ", "w") + seg(String(current).padEnd(4), "w") +
    " ".repeat(Math.max(1, space)) + seg(day, "w") + " " + seg(clock, "y");
}

function render() {
  const def = pages[current] || pages[300];
  const el = document.getElementById("page");
  let lines;
  if (!data) {
    lines = [title("FOOTEXT", "bg-g"), blank(),
      text(loadError ? " No data yet." : " Loading...", "c")];
    if (loadError) {
      lines.push(blank(), text(" If this is a new install, run the", "w"),
        text(" GitHub Action once (see README).", "w"));
    }
  } else {
    lines = def.render();
    const warn = freshnessWarning();
    if (warn) lines.splice(1, 0, warn);   // just under the page title
  }
  el.innerHTML = lines.join("");
  renderFastext(def);
  header();
}

/* Tell the user when scores aren't current, instead of silently showing old data */
function freshnessWarning() {
  const at = data?.updated ? new Date(data.updated) : null;
  const t = at ? fTime.format(at) : "?";
  const ageMin = at ? (Date.now() - at) / 60000 : Infinity;
  if (loadError) return text(` No connection - scores from ${t}`, "r flash");
  if (data?.stale?.length || ageMin > 5) return text(` Scores delayed - last update ${t}`, "y");
  return "";
}

function renderFastext(def) {
  const items = def.fastextDynamic ? def.fastextDynamic() : def.fastext;
  document.getElementById("fastext").innerHTML = items
    .map(([label, target]) => `<button ${target == null ? "disabled" : `data-target="${target}"`}>${esc(label)}</button>`)
    .join("");
}

function go(target, push = true) {
  let [num, ...rest] = String(target).split("/");
  let arg = rest.join("/") || undefined;
  num = Number(num);
  if (!pages[num] || (num === 390 && !arg)) { num = 300; arg = undefined; }
  current = num;
  pageArg = arg;
  typed = "";
  const hash = arg ? `#${num}/${arg}` : `#${num}`;
  if (push && location.hash !== hash) history.pushState(null, "", hash);
  render();
  window.scrollTo(0, 0);
}

function buildKeypad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "◀", "↻"];
  document.getElementById("keypad").innerHTML = keys
    .map((k) => `<button data-key="${k}" aria-label="${k === "◀" ? "Back" : k === "↻" ? "Refresh" : k}">${k}</button>`)
    .join("");
}

function pressDigit(d) {
  typed += d;
  if (typed.length === 3) {
    const n = typed;
    typed = "";
    go(pages[n] ? n : 300);
  } else header();
}

/* Make 40 columns fill the screen width */
function sizeText() {
  const maxW = Math.min(window.innerWidth, 720) - 8;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:100px";
  probe.textContent = "0".repeat(40);
  document.body.appendChild(probe);
  const ratio = probe.getBoundingClientRect().width / 4000;
  probe.remove();
  const fs = Math.floor((maxW / (W * ratio)) * 10) / 10;
  document.documentElement.style.setProperty("--fs", `${Math.max(10, fs)}px`);
}

/* ---------- data loading ---------- */

async function load() {
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
    loadError = null;
    try { localStorage.setItem("footext.cache", JSON.stringify(data)); } catch {}
  } catch (e) {
    loadError = e;
    if (!data) {
      try { data = JSON.parse(localStorage.getItem("footext.cache")); } catch {}
    }
  }
  render();
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-goto],[data-team],[data-target],[data-key],[data-href],[data-match]");
  if (!t) return;
  if (t.dataset.href) return window.open(t.dataset.href, "_blank", "noopener");
  if (t.dataset.match) return go(`390/${t.dataset.match}`);
  if (t.dataset.goto) return go(t.dataset.goto);
  if (t.dataset.team) {
    localStorage.setItem(FAV_KEY, t.dataset.team);
    return go(302);
  }
  if (t.dataset.target) {
    if (t.dataset.target === "clear") { localStorage.removeItem(FAV_KEY); return render(); }
    if (t.dataset.target === "back") return history.length > 1 ? history.back() : go(300);
    return go(t.dataset.target);
  }
  if (t.dataset.key) {
    const k = t.dataset.key;
    if (k === "◀") return history.length > 1 ? history.back() : go(300);
    if (k === "↻") return load();
    pressDigit(k);
  }
});

document.addEventListener("keydown", (e) => {
  if (/^\d$/.test(e.key)) pressDigit(e.key);
  else if (e.key === "Escape") { typed = ""; header(); }
});

window.addEventListener("popstate", () => go(location.hash.slice(1) || 300, false));
window.addEventListener("resize", sizeText);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

/* ---------- start ---------- */

buildKeypad();
sizeText();
if (document.fonts) document.fonts.ready.then(sizeText);
{
  const [n, ...rest] = location.hash.slice(1).split("/");
  current = Number(n) || 300;
  pageArg = rest.join("/") || undefined;
  if (!pages[current] || (current === 390 && !arg)) current = 300;
}
try { data = JSON.parse(localStorage.getItem("footext.cache")); } catch {}
render();
load();
setInterval(header, 1000);
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
