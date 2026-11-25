// Writes fake data to docs/data so you can preview the app locally without an API key.
// Usage: node scripts/sample-data.mjs  then  npx serve docs  (or python3 -m http.server -d docs)
import { mkdir, writeFile } from "node:fs/promises";

const names = {
  PL: ["Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Burnley", "Chelsea", "Crystal Palace", "Everton", "Fulham", "Leeds United", "Liverpool", "Man City", "Man Utd", "Newcastle", "Nott'm Forest", "Sunderland", "Tottenham", "West Ham", "Wolves"],
  ELC: ["Birmingham", "Blackburn", "Bristol City", "Charlton", "Coventry", "Derby", "Hull", "Ipswich", "Leicester", "Middlesbrough", "Millwall", "Norwich", "Oxford United", "Portsmouth", "Preston", "QPR", "Sheff Utd", "Sheff Wed", "Southampton", "Stoke", "Swansea", "Watford", "West Brom", "Wrexham"],
  CL: ["Arsenal", "Liverpool", "Man City", "Chelsea", "Newcastle", "Tottenham", "Real Madrid", "Barcelona", "Atlético", "Bayern", "Dortmund", "Leverkusen", "Paris SG", "Monaco", "Marseille", "Inter", "Milan", "Juventus", "Napoli", "Atalanta", "Benfica", "Sporting", "Porto", "PSV", "Ajax", "Feyenoord", "Club Brugge", "Celtic", "Galatasaray", "Olympiacos", "Slavia Praha", "Bodø/Glimt", "Copenhagen", "Qarabağ", "Kairat", "Pafos"],
};

const teams = {};
const ids = {};
let next = 1;
const idOf = (n) => (ids[n] ??= (teams[next] = { n, s: n, t: n.slice(0, 3).toUpperCase() }, next++));

const now = Date.now();
const DAY = 86400000;
let mid = 1;
const rnd = (n) => Math.floor(Math.random() * n);

function season(list, rounds, perDay) {
  const tids = list.map(idOf);
  const matches = [];
  for (let r = 0; r < rounds; r++) {
    const shuffled = [...tids].sort(() => Math.random() - 0.5);
    const day = now + (r - Math.floor(rounds / 2)) * 7 * DAY;
    for (let i = 0; i < shuffled.length; i += 2) {
      const d = new Date(day);
      d.setUTCHours(i % 4 === 0 ? 15 : 19, i % 6 === 0 ? 30 : 0, 0, 0);
      const t = d.getTime();
      let st = t < now - 2 * 3600e3 ? "FINISHED" : t < now ? "IN_PLAY" : "TIMED";
      const ft = st === "TIMED" ? [null, null] : [rnd(4), rnd(3)];
      matches.push({ id: mid++, d: d.toISOString(), st, md: r + 1, sg: perDay, h: shuffled[i], a: shuffled[i + 1], ft, ht: ft, mn: st === "IN_PLAY" ? 67 : undefined });
    }
  }
  const rows = tids.map((id) => ({ id, pl: 12, w: rnd(9), d: rnd(4), l: rnd(5), gf: rnd(30), ga: rnd(25) }))
    .map((r) => ({ ...r, gd: r.gf - r.ga, pts: r.w * 3 + r.d }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd)
    .map((r, i) => ({ p: i + 1, ...r }));
  return { matches, tables: [{ name: "", rows }] };
}

const out = {
  updated: new Date().toISOString(),
  comps: {
    PL: { name: "Premier League", ...season(names.PL, 10, "REGULAR_SEASON") },
    ELC: { name: "Championship", ...season(names.ELC, 10, "REGULAR_SEASON") },
    CL: { name: "UEFA Champions League", ...season(names.CL, 6, "LEAGUE_STAGE") },
  },
  teams,
};

await mkdir("docs/data", { recursive: true });
await writeFile("docs/data/football.json", JSON.stringify(out));
console.log("Wrote docs/data/football.json (sample data)");
