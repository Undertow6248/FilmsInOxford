// Runs on the owner's computer once a day. Vue and Curzon block GitHub's servers, so this fetches their times
// in an ordinary Chrome (or Edge) window here and sends them to the repo. The site then rebuilds itself.
//
// Usage: node fetch.mjs          (skips if it already ran in the last 12 hours)
//        node fetch.mjs --force  (run now regardless)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const REPO = "Undertow6248/FilmsInOxford";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "config.json");   // { "token": "github_pat_..." }
const STATE = path.join(HERE, "last-run.json");
const LOG = path.join(HERE, "fetch.log");
const SOURCES = { vue: "sources/vue.mjs", cur: "sources/curzon.mjs" };
const EVENTS = "sources/events.mjs"; // University events calendar + Eventbrite

// GitHub calls, retried a few times (networks sometimes drop a connection).
async function gh(url, opts = {}) {
  let err;
  for (let i = 0; i < 4; i++) {
    try { return await fetch(url, opts); } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw err;
}
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(" ")}`; console.log(line); fs.appendFileSync(LOG, line + "\n"); };

async function main() {
  const force = process.argv.includes("--force");
  try {
    const last = JSON.parse(fs.readFileSync(STATE, "utf8").replace(/^\uFEFF/, ""));
    if (!force && Date.now() - Date.parse(last.ok) < 12 * 3600e3) return log("already ran today, skipping");
  } catch {}
  // Keep this script up to date too (takes effect from the next run).
  try {
    const r = await gh(`https://raw.githubusercontent.com/${REPO}/main/local/fetch.mjs`, { cache: "no-store" });
    if (r.ok) { const t = await r.text(); if (t.includes("films-in-oxford-local") && t !== fs.readFileSync(fileURLToPath(import.meta.url), "utf8")) fs.writeFileSync(fileURLToPath(import.meta.url), t); }
  } catch {}
  const { token } = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "")); // Windows may add a BOM

  // Always use the latest scraper code from the repo, so fixes there apply here too.
  const code = path.join(HERE, "code", "scraper");
  fs.mkdirSync(path.join(code, "sources"), { recursive: true });
  for (const f of ["lib.mjs", ...Object.values(SOURCES), EVENTS]) {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/scraper/${f}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`couldn't download ${f}: ${r.status}`);
    fs.writeFileSync(path.join(code, f), await r.text());
  }
  const { londonToday } = await import(pathToFileURL(path.join(code, "lib.mjs")) + `?v=${Date.now()}`);
  const today = londonToday();

  // An ordinary visible browser window, parked off-screen so it doesn't get in the way.
  let browser;
  for (const channel of ["chrome", "msedge"]) {
    try { browser = await chromium.launch({ channel, headless: false, args: ["--window-position=-2400,-2400", "--window-size=1366,900"] }); break; } catch {}
  }
  if (!browser) throw new Error("couldn't open Chrome or Edge");
  const ctx = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London", viewport: { width: 1366, height: 900 } });

  const out = { sources: {} };
  for (const [key, file] of Object.entries(SOURCES)) {
    const page = await ctx.newPage();
    try {
      const mod = await import(pathToFileURL(path.join(code, file)) + `?v=${Date.now()}`);
      const rows = await mod.scrape(page, { today, days: 21 });
      if (!rows.length) throw new Error("no screenings found");
      out.sources[key] = { at: new Date().toISOString(), rows: rows.map(({ attrs, release, ...r }) => r) };
      log(key, rows.length, "screenings");
    } catch (e) {
      log(key, "FAILED:", e.message.split("\n")[0]);
    }
    await page.close();
  }
  // Screenings outside cinemas from the sites that block GitHub.
  try {
    const ev = await import(pathToFileURL(path.join(code, EVENTS)) + `?v=${Date.now()}`);
    const { addDays } = await import(pathToFileURL(path.join(code, "lib.mjs")) + `?v=${Date.now()}`);
    for (const key of ev.LOCAL_EVENT_SOURCES || []) {
      const page = await ctx.newPage();
      try {
        const rows = await ev.EVENT_SOURCES[key](page, { today, last: addDays(today, 20) });
        out.sources["ev:" + key] = { at: new Date().toISOString(), rows };
        log(key, rows.length, "screenings");
      } catch (e) { log(key, "FAILED:", e.message.split("\n")[0]); }
      await page.close();
    }
  } catch (e) { log("events FAILED:", e.message); }
  await browser.close();
  if (!Object.keys(out.sources).length) throw new Error("nothing fetched");

  // Send to the repo (scraper/local/listings.json). That commit starts the site update on GitHub.
  const api = `https://api.github.com/repos/${REPO}/contents/scraper/local/listings.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "films-in-oxford-local" };
  const cur = await gh(api, { headers });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  if (cur.ok && sha) {
    // Keep a source from the previous upload if it failed this time.
    try {
      const prev = await (await fetch(`https://raw.githubusercontent.com/${REPO}/main/scraper/local/listings.json`, { cache: "no-store" })).json();
      for (const [k, v] of Object.entries(prev.sources || {})) if (!out.sources[k]) out.sources[k] = v;
    } catch {}
  }
  const body = {
    message: `Listings from this computer (${today})`,
    content: Buffer.from(JSON.stringify(out)).toString("base64"),
    ...(sha ? { sha } : {}),
  };
  const put = await gh(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GitHub said ${put.status}: ${(await put.text()).slice(0, 200)}`);
  fs.writeFileSync(STATE, JSON.stringify({ ok: new Date().toISOString() }));
  log("sent to GitHub");
}

main().catch(e => { log("ERROR:", e.message, e.cause ? `(${e.cause.code || ""} ${e.cause.message || e.cause})` : ""); process.exitCode = 1; });
