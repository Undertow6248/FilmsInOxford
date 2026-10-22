// Scrape every Oxford cinema, add the hand-entered one-offs, look films up on TMDB, write site/data.json.
// Usage: node scraper/run.mjs            (needs TMDB_TOKEN for posters/genres; works without it, just with less detail)
//        node scraper/run.mjs --only=upp (one source, for testing)
import fs from "node:fs";
import { chromium } from "playwright";
import { londonToday, addDays, cleanTitle, log } from "./lib.mjs";
import { enrich, saveCache, stats as tmdbStats } from "./tmdb.mjs";
import * as vue from "./sources/vue.mjs";
import * as phx from "./sources/phoenix.mjs";
import * as cur from "./sources/curzon.mjs";
import * as ocf from "./sources/oxfordcinema.mjs";
import * as upp from "./sources/upp.mjs";
import { scrapeEvents, dailyInfoCinemaRows } from "./sources/events.mjs";

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
// A normal Chrome window (under a virtual display on the server). We don't try to get round bot protection:
// if a cinema blocks the server, its last-known times are kept and the page says so.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : process.env.CI ? { channel: "chrome" } : {}),
  headless: !process.env.HEADFUL,
});
const ctx = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London", viewport: { width: 1366, height: 900 } });
fs.rmSync(new URL("../data/debug/", import.meta.url), { recursive: true, force: true });
const raw = [], status = {};
// Vue and Curzon block GitHub's servers, so a job on the owner's computer (local/fetch.mjs) sends their times here.
const local = read("./local/listings.json", { sources: {} });
// Screenings outside cinemas (and Daily Info's copy of the cinema times, used as a back-up below).
let ev = { events: [], cinemas: [], status: {} };
if (!only || only === "events") ev = await scrapeEvents(ctx, { today, days: DAYS, local: local.sources });
const diCinema = dailyInfoCinemaRows(ev.cinemas);
for (const [key, src] of Object.entries(SOURCES)) {
  if (only && key !== only) continue;
  const l = local.sources[key];
  if (!only && l && Date.now() - Date.parse(l.at) < 36 * 3600e3 && l.rows.length) {
    raw.push(...l.rows.filter(r => r.date >= today && r.date <= last));
    status[key] = { ok: true, count: l.rows.length, via: "local", at: l.at };
    continue;
  }
  const page = await ctx.newPage();
  try {
    const rows = (await src.scrape(page, { today, days: DAYS })).filter(r => r.date >= today && r.date <= last && r.time);
    if (!rows.length) throw new Error("no screenings found");
    raw.push(...rows);
    status[key] = { ok: true, count: rows.length };
  } catch (e) {
    const di = diCinema.filter(r => r.venue === key && r.date >= today && r.date <= last);
    const old = previous.shows.filter(s => s[3] === key && s[0] >= today);
    if (di.length) {
      // Fall back to Daily Info's copy of this cinema's times (it lists the next couple of weeks).
      log(`${key} FAILED: ${e.message.split("\n")[0]} (using Daily Info's listing)`);
      raw.push(...di);
      status[key] = { ok: true, count: di.length, via: "dailyinfo", error: e.message.split("\n")[0] };
    } else {
      log(`${key} FAILED: ${e.message.split("\n")[0]} (keeping previous data)`);
      raw.push(...old.map(s => ({ date: s[0], time: s[1], title: s[2], venue: key, tags: s[4] ? [s[4]] : [], url: s[5], kept: true })));
      status[key] = { ok: false, error: e.message.split("\n")[0], kept: old.length };
    }
    // Save what the page looked like, so a failure can be diagnosed from the repo (data/debug/).
    try {
      fs.mkdirSync(new URL("../data/debug/", import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL(`../data/debug/${key}.png`, import.meta.url).pathname });
      status[key].page = { url: page.url(), title: await page.title(), text: (await page.evaluate(() => document.body?.innerText || "")).replace(/\s+/g, " ").slice(0, 400) };
    } catch {}
  }
  await page.close();
}
await browser.close();
if (only) { console.log(JSON.stringify(only === "events" ? ev : raw.slice(0, 20), null, 1), raw.length); process.exit(0); }
Object.assign(status, Object.fromEntries(Object.entries(ev.status).map(([k, v]) => ["ev:" + k, v])));

// 2. Screenings outside cinemas: the hand-entered ones in extras.json, then everything the event sources found.
const { rows: eventRows, venues } = buildEvents(extras.screenings.filter(s => s.date >= today), ev.events, overrides.hide || []);
raw.push(...eventRows);

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
  shows.push([r.date, r.time, t, r.venue, tag, r.url && r.url !== VENUE_HOME[r.venue] ? r.url : "", r.filmUrl || ""]);
}
// Same film spelt differently by two cinemas ("NAZA"/"Naza"), or cut short ("Shaun the Sheep: The Beast Of Mo"):
// map each to the most-used full spelling.
{
  const key = t => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  const count = {}; for (const s of shows) count[s[2]] = (count[s[2]] || 0) + 1;
  const names = Object.keys(count), canon = {};
  for (const n of names) {
    const k = key(n);
    const same = names.filter(m => key(m) === k || (k.length >= 20 && key(m).startsWith(k) && key(m).length > k.length));
    canon[n] = same.sort((a, b) => (overrides.films[b] ? 1 : 0) - (overrides.films[a] ? 1 : 0) || key(b).length - key(a).length || count[b] - count[a])[0];
  }
  for (const s of shows) s[2] = canon[s[2]];
  const seen2 = new Set();
  for (let i = shows.length - 1; i >= 0; i--) { const k = shows[i].slice(0, 4).join("|"); if (seen2.has(k)) shows.splice(i, 1); else seen2.add(k); }
}
shows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

// Links: each time links to that screening's booking page where the cinema gives one. Where it doesn't
// (e.g. times taken from Daily Info), link to the film's page at that cinema, remembered from earlier runs.
{
  const LINKS = new URL("../data/links.json", import.meta.url);
  let links = {}; try { links = JSON.parse(fs.readFileSync(LINKS, "utf8")); } catch {}
  for (const s of shows) if (s[6]) links[s[3] + "|" + s[2]] = s[6];
  for (const s of shows) { if (!s[5]) s[5] = links[s[3] + "|" + s[2]] || ""; s.length = 6; }
  fs.writeFileSync(LINKS, JSON.stringify(links, null, 1));
}

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
  films[t] = [cat, o.note || "", m?.id || p[2] || "", String(o.year || m?.year || p[3] || ""), m?.genres || p[4] || [], m?.countries || p[5] || [], m?.poster || p[6] || "", m?.lang || p[7] || ""];
}
saveCache();

status.tmdb = tmdbStats;
const out = { updated: new Date().toISOString(), status, venues, shows, films };
fs.writeFileSync(OUT, JSON.stringify(out));
log(`wrote ${shows.length} screenings of ${Object.keys(films).length} films`, JSON.stringify(status));
if (Object.keys(SOURCES).every(k => !status[k]?.ok)) { log("every source failed"); process.exit(1); }

// ---------- screenings outside cinemas ----------
function buildEvents(fixed, found, hide) {
  // Venues the page already knows about (see V in site/index.html); others are added from the listing.
  const KNOWN = [[/magdalen/i, "mag"], [/divinity school/i, "bod"], [/tap social/i, "tap"], [/maison fran/i, "mfo"],
    [/oxford castle|^the castle$/i, "cas"], [/schwarzman/i, "swz"], [/rewley house/i, "rew"], [/human genetics/i, "chg"],
    [/^the nest\b/i, "nest"], [/florence park/i, "fpc"], [/common ground/i, "cg"]];
  const venues = {};
  const slug = n => n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const venueKey = e => {
    const name = (e.venueName || "").replace(/\s+-\s+.*$/, "").replace(/,.*$/, "").trim() || "Venue TBC";
    const k = (KNOWN.find(([re]) => re.test(e.venueName || "")) || [])[1];
    if (k) return k;
    const key = "x-" + slug(name);
    venues[key] ||= { n: name.length > 24 ? name.slice(0, 22) + "…" : name, f: name, u: e.url, w: e.venueAddr || "" };
    return key;
  };
  const eventTitle = n => n.replace(/\s*\[[^\]]*\]/g, "")
    .replace(/^(?:halloween\s+)?(?:film\s+)?screening(?:\s+of)?\s*[:–-]\s*/i, "")
    .replace(/^(?:daytime cinema presents|outdoor cinema night|magdalen monday movies|film club|movie night|film night|cinema club)\s*[:–-]\s*/i, "")
    .replace(/\s*[:–-]\s*(?:documentary\s+|community\s+|free\s+)?screening\b.*$/i, "")
    .replace(/\s+(?:film\s+)?screening\s*(?:&|and|\+|with|in|at)\b.*$/i, "")
    .replace(/\s+film screening\b.*$/i, "")
    .replace(/\s*\+\s*q\s*&\s*a.*$/i, "")
    .replace(/\s*[–-]\s*independent film.*$/i, "")
    .replace(/\s*\((?:19|20)\d\d\)/, "")
    .replace(/^['"‘“](.+?)['"’”]$/, "$1").replace(/\s+/g, " ").trim() || n;
  const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(w => w.length >= 4 && !/^(film|screening|with|from|the|and|night|oxford|documentary)$/.test(w)));
  const mins = t => /^\d\d:\d\d$/.test(t) ? +t.slice(0, 2) * 60 + +t.slice(3) : null;
  const same = (a, b) => {
    if (a.date !== b.date) return false;
    const ta = mins(a.time), tb = mins(b.time);
    if (ta != null && tb != null && Math.abs(ta - tb) > 60) return false;
    if (a.key === b.key && a.venue === b.venue) return true;
    const wa = words(a.raw), wb = words(b.raw);
    return [...wa].some(w => wb.has(w));
  };
  const hideRes = hide.map(h => new RegExp(h, "i"));
  const kept = [];
  // Hand-entered first, then the sources, best links first.
  const ORDER = { magdalen: 1, oxevents: 2, dailyinfo: 3, eventbrite: 4, wegottickets: 5 };
  const cands = [
    ...fixed.map(s => ({ date: s.date, time: s.time, title: s.title, raw: s.title, venue: s.venue, tags: s.tag ? [s.tag] : [], url: s.url || "", fixed: true })),
    ...found.slice().sort((a, b) => (ORDER[a.src] || 9) - (ORDER[b.src] || 9)).map(e => {
      const title = eventTitle(e.name);
      const tags = [];
      if (/q\s*&\s*a/i.test(e.name)) tags.push("Q&A");
      if (e.tag) tags.push(e.tag);
      return { date: e.date, time: e.time || "TBC", title, raw: e.name, venue: venueKey(e), tags, url: e.url, src: e.src, name: e.name };
    }),
  ];
  for (const c of cands) {
    if (hideRes.some(re => re.test(c.raw) || re.test(c.title))) continue;
    c.key = c.title.toLowerCase();
    const dup = kept.find(k => same(k, c));
    if (dup) { if (!dup.url && c.url) dup.url = c.url; if (dup.time === "TBC" && c.time !== "TBC") dup.time = c.time; continue; }
    kept.push(c);
  }
  // Only list venues that ended up with a screening.
  const used = new Set(kept.map(k => k.venue));
  for (const k of Object.keys(venues)) if (!used.has(k)) delete venues[k];
  log("events:", kept.length, "screenings outside cinemas,", Object.keys(venues).length, "new venues");
  return { rows: kept.map(k => ({ date: k.date, time: k.time, title: k.title, venue: k.venue, tags: k.tags, url: k.url, fixed: true })), venues };
}
