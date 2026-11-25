# FOOTEXT

Teletext-style football scores, fixtures, tables, confirmed transfers, match stats and lineups for the **Premier League**, **Championship** and **Champions League**. No ads, no articles, no gossip. It installs on Android as an app.

## How it works

```
Phone (FOOTEXT app on GitHub Pages)
   │  you open the app → asks for fresh data
   ▼
Cloudflare Worker (free)  ── holds your API key, caches results for 60s
   ├─► football-data.org   scores, fixtures, tables
   └─► BBC Sport RSS       transfer headlines, filtered to confirmed moves
Phone ──► Wikipedia        your team's completed transfers this season
```

- Scores update **when you open the app**, and every 60 seconds while it's open. Nothing runs on a schedule.
- The Worker keeps your API key secret, and its cache keeps you inside the free API limit (10 calls a minute).
- Free-tier scores from football-data.org run a few minutes behind real time.

## Setup (about 15 minutes)

### 1. Get a football-data.org key
Register at https://www.football-data.org/client/register. The key arrives by email.

### 2. Create the Cloudflare Worker (free, no card needed)
1. Sign up at https://dash.cloudflare.com and open **Workers & Pages** → **Create** → **Create Worker**. Name it `footext` and click **Deploy**.
2. Click **Edit code**, delete the sample code, paste in all of `worker/worker.js`, then click **Deploy**.
3. Go back to the Worker and open **Settings** → **Variables and Secrets** → **Add**. Set the type to **Secret**, the name to `FOOTBALL_DATA_KEY` and the value to your key. Save.
4. *(Recommended)* Add caching that survives restarts:
   - Go to **Storage & Databases** → **KV** → **Create**, and call it `footext-cache`.
   - Then in your Worker, go to **Settings** → **Bindings** → **Add** → **KV namespace**. Set the variable name to `CACHE` and pick `footext-cache`.
5. Copy your Worker's address, e.g. `https://footext.yourname.workers.dev`. Open `<that address>/football` in a browser. You should see a page of JSON.

*(If you prefer the command line, see `worker/wrangler.toml`.)*

### 3. Point the app at your Worker
Edit `docs/config.js`:
```js
window.FOOTEXT_API = "https://footext.yourname.workers.dev";
```

### 4. Put it on GitHub Pages
1. Create a **public** repo (e.g. `footext`) and push everything in this folder.
2. Go to **Settings** → **Pages** → **Deploy from a branch**, then choose `main` and the `/docs` folder. Save.
3. After a minute, it's live at `https://YOURNAME.github.io/footext/`.

### 5. Install on your phone
Open the site in Chrome and tap ⋮ → **Add to Home screen** → **Install**.

### Optional: lock the Worker to your app
In the Worker, add a plain variable `ALLOWED_ORIGIN` = `https://YOURNAME.github.io`. Other websites then can't use your Worker from a browser.

## Pages

| Page | What |
|------|------|
| 300 | Index |
| 301 | Latest scores |
| 302 | My team: positions, form, results, fixtures |
| 303 | My team: transfers (confirmed signings and departures, plus BBC headlines) |
| 311 / 312 / 313 | Premier League results / fixtures / table |
| 321 / 322 / 323 | Championship results / fixtures / table |
| 331 / 332 / 333 | Champions League results / fixtures / league phase table |
| 399 | Choose your favourite team |

You can tap any line, use the coloured Fastext buttons, or type a page number on the keypad.

## About the transfer page

- **SIGNED / LEFT** comes from the "Transfers" tables on your club's Wikipedia season page (e.g. *2026–27 Arsenal F.C. season*). Those tables only list completed deals, including loans and fees where known.
- **Latest confirmed moves** are BBC Sport headlines. The Worker keeps only stories whose headline says a deal has happened (e.g. "signs", "joins", "completes", "new contract", "leaves"). It drops anything that sounds like speculation (e.g. "linked", "target", "bid", "talks", "set to", "close to") and anything about women's or academy football.
- The keyword filter isn't perfect. If something slips through, add the word to the `RUMOUR` list in `worker/worker.js` and redeploy.
- BBC coverage of foreign Champions League clubs is thin, but the Wikipedia part still works for them.

## Local preview (no keys needed)

```
node scripts/sample-data.mjs          # writes fake scores to docs/data
python3 -m http.server -d docs 8000
```

Then open http://localhost:8000 and leave `FOOTEXT_API` empty. Transfer news needs the Worker, but the Wikipedia section works.
