// Scrape every Oxford cinema, add the hand-entered one-offs, look films up on TMDB, write site/data.json.
// Usage: node scraper/run.mjs            (needs TMDB_TOKEN for posters/genres; works without it, just with less detail)
//        node scraper/run.mjs --only=upp (one source, for testing)
import fs from "node:fs";
import { chromium } from "playwright";
import { londonToday, addDays, cleanTitle, log } from "./lib.mjs";
import { enrich, saveCache } from "./tmdb.mjs";
import * as vue from "./sources/vue.mjs";
import * as phx from "./sources/phoenix.mjs";
import * as cur from "./sources/curzon.mjs";
import * as ocf from "./sources/oxfordcinema.mjs";
import * as upp from "./sources/upp.mjs";

const SOURCES = { vue, phx, cur, ocf, upp };
const DAYS = 21; // scrape three weeks; the page shows two
const OUT = new URL("../site/data.json", import.meta.url);
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8")); } catch { return d; } };

const today = londonToday();
const last = addDays(today, DAYS - 1);
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);
const previous = read("../site/data.json", { shows: [], films: {} });
const overrides = read("./overrides.json", { aliases: {}, films: {} });
const extras = read("./extras.json", { screenings: [] });

// 1. Scrape the cinemas. If one fails, keep its previous listings so the site never goes blank.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({
  locale: "en-GB", timezoneId: "Europe/London",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});
const raw = [], status = {};
for (const [key, src] of Object.entries(SOURCES)) {
  if (only && key !== only) continue;
  const page = await ctx.newPage();
  try {
    const rows = (await src.scrape(page, { today, days: DAYS })).filter(r => r.date >= today && r.date <= last && r.time);
    if (!rows.length) throw new Error("no screenings found");
    raw.push(...rows);
    status[key] = { ok: true, count: rows.length };
  } catch (e) {
    log(`${key} FAILED: ${e.message.split("\n")[0]} (keeping previous data)`);
    const old = previous.shows.filter(s => s[3] === key && s[0] >= today);
    raw.push(...old.map(s => ({ date: s[0], time: s[1], title: s[2], venue: key, tags: s[4] ? [s[4]] : [], url: s[5], kept: true })));
    status[key] = { ok: false, error: e.message.split("\n")[0], kept: old.length };
  }
  await page.close();
}
await browser.close();
if (only) { console.log(JSON.stringify(raw.slice(0, 20), null, 1), raw.length); process.exit(0); }

// 2. One-off screenings from extras.json.
for (const s of extras.screenings) if (s.date >= today) raw.push({ ...s, tags: s.tag ? [s.tag] : [], fixed: true });

// 3. Tidy titles and merge duplicates.
const VENUE_HOME = {
  vue: "https://www.myvue.com/cinema/oxford/whats-on", cur: "https://www.curzon.com/venues/oxford/",
  phx: "https://www.picturehouses.com/cinema/phoenix-picturehouse", ocf: "https://www.oxfordcinema.co.uk/en/buy-tickets",
  upp: "https://uppcinema.com/whats-on/",
};
const A = overrides.aliases;
const title = t => A[t.trim()] || A[cleanTitle(t)] || cleanTitle(t);
const seen = new Set(), shows = [];
for (const r of raw) {
  const t = r.fixed || r.kept ? (overrides.aliases[r.title] || r.title) : title(r.title);
  const k = [r.date, r.time, t, r.venue].join("|");
  if (seen.has(k)) continue; seen.add(k);
  const tag = (r.tags || []).join(" · ");
  shows.push([r.date, r.time, t, r.venue, tag, r.url && r.url !== VENUE_HOME[r.venue] ? r.url : ""]);
}
shows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

// 4. Look each film up on TMDB and pick a section for it.
const EVENT = /^(NT Live|National Theatre Live|RBO|Royal Ballet|Met Opera|Bolshoi|Book Club)|Live Viewing|in Concert|: Live$|\bConcert\b|The Musical$|Cinema Club/i;
const films = {};
for (const t of [...new Set(shows.map(s => s[2]))]) {
  const o = overrides.films[t] || {};
  const venues = new Set(shows.filter(s => s[2] === t).map(s => s[3]));
  const isEvent = o.cat === "E" || o.cat === "K" || EVENT.test(t);
  const m = await enrich(t, isEvent && !o.tmdb ? { ...o, skip: o.skip ?? true } : o);
  let cat = o.cat;
  if (!cat) {
    const rel = m?.release || "";
    if (isEvent) cat = "E";
    else if (rel && rel < addDays(today, -540)) cat = "T"; // out for more than ~18 months
    else if (venues.has("vue")) cat = "W";
    else cat = "L";
  }
  const p = previous.films[t] || [];
  films[t] = [cat, o.note || "", m?.id || p[2] || "", String(o.year || m?.year || p[3] || ""), m?.genres || p[4] || [], m?.countries || p[5] || [], m?.poster || p[6] || ""];
}
saveCache();

const out = { updated: new Date().toISOString(), status, shows, films };
fs.writeFileSync(OUT, JSON.stringify(out));
log(`wrote ${shows.length} screenings of ${Object.keys(films).length} films`, JSON.stringify(status));
if (Object.values(status).every(s => !s.ok)) { log("every source failed"); process.exit(1); }
