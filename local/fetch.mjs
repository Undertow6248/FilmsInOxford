// Runs on the owner's computer once a day. Vue and Curzon block GitHub's servers, so this fetches their times
// in an ordinary Chrome (or Edge) window here and sends them to the repo. The site then rebuilds itself.
//
// Usage: node fetch.mjs          (skips if it already ran in the last 12 hours)
//        node fetch.mjs --force  (run now regardless)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const REPO = "Undertow6248/FilmsInOxford";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "config.json");   // { "token": "github_pat_..." }
const STATE = path.join(HERE, "last-run.json");
const LOG = path.join(HERE, "fetch.log");
// Curzon is separate (tryCurzon below): it blocks browsers that a tool has started (a Cloudflare security check),
// so it gets an ordinary Chrome, started normally with its own saved profile, which this job only attaches to.
const SOURCES = { vue: "sources/vue.mjs" };
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
  // Keep this script up to date too (takes effect from the next run).
  try {
    const r = await gh(`https://raw.githubusercontent.com/${REPO}/main/local/fetch.mjs`, { cache: "no-store" });
    if (r.ok) {
      const t = await r.text();
      if (t.includes("films-in-oxford-local") && t !== fs.readFileSync(fileURLToPath(import.meta.url), "utf8")) {
        fs.writeFileSync(fileURLToPath(import.meta.url), t);
        // Run the new version straight away, rather than waiting until tomorrow.
        log("updated this script, restarting it");
        process.exitCode = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" }).status ?? 1;
        return;
      }
    }
  } catch {}
  const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "")).token || ""; // Windows may add a BOM
  // Pasting into a terminal can add invisible characters around the token; keep just the token itself.
  const token = (saved.match(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/) || [])[0];
  if (!token) throw new Error(`the saved GitHub token doesn't look right (${saved.length} characters, should start github_pat_). Delete config.json in ${HERE} and run setup again.`);

  // Curzon times saved to Downloads by the "Curzon times" Claude task: upload them whenever there's a new file,
  // even if the rest of this job has already run today.
  try { await uploadCurzon(token); } catch (e) { log("curzon file FAILED:", e.message); }

  try {
    const last = JSON.parse(fs.readFileSync(STATE, "utf8").replace(/^\uFEFF/, ""));
    if (!force && Date.now() - Date.parse(last.ok) < 12 * 3600e3) return log("already ran today, skipping");
  } catch {}

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
      // Record what the page showed, e.g. a "Just a moment..." security check.
      try { log(key, "page was:", JSON.stringify(await page.title()), (await page.evaluate(() => document.body?.innerText || "")).replace(/\s+/g, " ").slice(0, 160)); } catch {}
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
      // Keep a source from the last upload if it failed this time, but only sources this job still fetches.
      const mine = new Set([...Object.keys(SOURCES), ...((await import(pathToFileURL(path.join(code, EVENTS)) + "").catch(() => ({}))).LOCAL_EVENT_SOURCES || []).map(k => "ev:" + k)]);
      for (const [k, v] of Object.entries(prev.sources || {})) if (!out.sources[k] && mine.has(k)) out.sources[k] = v;
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

  try { await tryCurzon(token); } catch (e) { log("curzon FAILED:", e.message.split("\n")[0]); }
}

// Curzon. A Chrome started by Playwright is marked as automated, and Cloudflare stops it. So start Chrome the
// ordinary way, with its own profile kept in this folder (Cloudflare's "you passed" cookie then carries over between
// days), attach to it afterwards, and run the same page script the Claude task uses. If Cloudflare still shows its
// check, log that and give up: nothing else depends on this, and the Claude task / Daily Info still cover Curzon.
async function tryCurzon(token) {
  const exe = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(p => p && fs.existsSync(p));
  if (!exe) throw new Error("Chrome isn't installed in the usual place");
  const profile = path.join(HERE, "chrome-profile");
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  try { fs.unlinkSync(portFile); } catch {}
  const chrome = spawn(exe, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--disable-blink-features=AutomationControlled",
    "--no-default-browser-check", "--window-position=-2400,-2400", "--window-size=1366,900", "about:blank"], { stdio: "ignore" });
  let browser;
  try {
    let port;
    for (let i = 0; i < 60 && !port; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim(); } catch {}
    }
    if (!port) throw new Error("Chrome didn't start (is another copy using its profile?)");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    // The page script saves a copy to Downloads for the Claude task's hand-over; not needed here.
    try { await (await browser.newBrowserCDPSession()).send("Browser.setDownloadBehavior", { behavior: "deny" }); } catch {}
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto("https://www.curzon.com/venues/oxford/", { waitUntil: "domcontentloaded", timeout: 60000 });
    // Cloudflare's check, when it lets a browser through, finishes by itself within a few seconds.
    try { await page.waitForSelector(".v-date-picker [role=tab]", { timeout: 60000 }); }
    catch {
      const title = await page.title().catch(() => "");
      throw new Error(/just a moment/i.test(title) ? "blocked by Cloudflare's security check" : `listings didn't appear (page title ${JSON.stringify(title)})`);
    }
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/chrome/curzon-page.js`, { cache: "no-store" });
    if (!r.ok) throw new Error(`couldn't download curzon-page.js: ${r.status}`);
    await page.evaluate(await r.text());
    await page.waitForFunction(() => typeof window.__curzonDone === "number", null, { timeout: 180000, polling: 2000 });
    const text = await page.evaluate(() => document.getElementById("curzon-out")?.textContent || "");
    const { at, rows } = parseCurzon(text);
    await putFile(token, "scraper/local/curzon.json", JSON.stringify({ at, rows }), `Curzon times from this computer (${at.slice(0, 10)})`);
    log("curzon", rows.length, "screenings,", new Set(rows.map(r => r.date)).size, "days, sent to GitHub");
  } finally {
    try { await browser?.close(); } catch {}
    try { chrome.kill(); } catch {}
  }
}

// Lines from curzon-page.js (AT|time, F|title|film-path, S|date|time|booking-number, END|count) -> screenings
function parseCurzon(text, fallbackAt) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const end = lines.find(l => l.startsWith("END|"));
  if (!end) throw new Error("the Curzon read is incomplete (no END line)");
  const at = (lines.find(l => l.startsWith("AT|")) || "").slice(3) || fallbackAt || new Date().toISOString();
  const rows = []; let film = null;
  for (const l of lines) {
    const p = l.split("|");
    if (p[0] === "F") film = { title: p[1], url: p[2] ? new URL(p[2], "https://www.curzon.com/").href : "" };
    else if (p[0] === "S" && film && /^\d{4}-\d\d-\d\d$/.test(p[1]) && /^\d\d:\d\d$/.test(p[2]))
      rows.push({ date: p[1], time: p[2], title: film.title, venue: "cur", tags: [], url: p[3] ? `https://www.curzon.com/ticketing/seats/OXF1-${p[3]}/` : film.url, filmUrl: film.url });
  }
  if (!rows.length || rows.length !== +end.split("|")[1]) throw new Error(`the Curzon read has ${rows.length} screenings but says ${end.split("|")[1]}`);
  return { at, rows };
}

// Save a file to the repo through GitHub's API (creating or replacing it).
async function putFile(token, repoPath, content, message) {
  const api = `https://api.github.com/repos/${REPO}/contents/${repoPath}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "films-in-oxford-local" };
  const cur = await gh(api, { headers });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const put = await gh(api, { method: "PUT", headers, body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), ...(sha ? { sha } : {}) }) });
  if (!put.ok) throw new Error(`GitHub said ${put.status}: ${(await put.text()).slice(0, 200)}`);
}

// films-in-oxford-curzon.txt (lines F|title|film-path, S|date|time|booking-number, END|count) -> scraper/local/curzon.json
async function uploadCurzon(token) {
  const dl = path.join(os.homedir(), "Downloads");
  let files = [];
  try {
    files = fs.readdirSync(dl).filter(f => /^films-in-oxford-curzon.*\.txt$/i.test(f))
      .map(f => ({ p: path.join(dl, f), t: fs.statSync(path.join(dl, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  } catch { return; }
  if (!files.length) return;
  const { at, rows } = parseCurzon(fs.readFileSync(files[0].p, "utf8"), new Date(files[0].t).toISOString());
  await putFile(token, "scraper/local/curzon.json", JSON.stringify({ at, rows }), `Curzon times via Chrome (${at.slice(0, 10)})`);
  // Uploaded: tidy up the file(s) the task left in Downloads.
  for (const f of files) try { fs.unlinkSync(f.p); } catch {}
  log("curzon", rows.length, "screenings from Chrome, sent to GitHub");
}

main().catch(e => { log("ERROR:", e.message, e.cause ? `(${e.cause.code || ""} ${e.cause.message || e.cause})` : ""); process.exitCode = 1; });
