// Film screenings outside the five cinemas: colleges, pubs, community centres, libraries, one-offs.
// Sources, each read inside a browser page on its own site:
//   Daily Info (Oxford's what's-on listings), the University's events calendar (events.ox.ac.uk),
//   WeGotTickets, Eventbrite, and Magdalen Monday Movies' own page.
// Every source returns rows: {date, time, name, venueName, venueAddr, url, src, film}
// The caller turns these into screenings (title cleanup, venue matching, de-duplication).
import { addDays, to24, log } from "../lib.mjs";

export const OXFORD_POSTCODE = /\bOX[1-4]\s*\d[A-Z]{2}\b/i;
const CINEMA_VENUE = /^(curzon|vue|phoenix picturehouse|ultimate picture palace|the oxford cinema)/i;
// Words that mark an event as a film screening when they're in its name.
const FILM_NAME = /\b(screenings?|film night|film club|film evening|films? (?:and|&) (?:talk|q&a|discussion)|movie night|cinema (?:night|club|presents)|documentary|outdoor cinema|sing-?a-?long|(?:short|feature|independent) films?)\b/i;
// Things that mention film but aren't screenings.
const NOT_FILM = /\b(filmmakers?|film-?making|networking|workshop|course|class|masterclass|illuminated|candlelight|tribute to|concert|life drawing|film lab|make a (?:scary )?film|stop motion|audition|race screening|sports? screening|world cup|grand prix|match screening)\b/i;

/** "6.00pm (doors 5.30pm)", "Doors 2.00pm, film 3.00pm", "6.00-9.30pm", "19:30" -> "18:00" etc. */
export function firstTime(s) {
  s = String(s || "").toLowerCase();
  const film = s.match(/(?:film|screening|start(?:s| time)?)[^0-9]{0,12}(\d{1,2}(?:[.:]\d\d)?\s*[ap]m)/);
  if (film) return t(film[1]);
  const range = s.match(/(\d{1,2}(?:[.:]\d\d)?)\s*(?:-|–|to)\s*\d{1,2}(?:[.:]\d\d)?\s*([ap]m)/);
  const one = s.replace(/doors?[^,;)]*/g, "").match(/(\d{1,2}(?:[.:]\d\d)?)\s*([ap]m)?/);
  if (range) {
    // "6.00-9.30pm": start shares the end's am/pm unless that would put it after the end.
    let [h] = range[1].split(/[.:]/).map(Number);
    return t(range[1] + (range[2] === "pm" && h < 12 && h > 9 ? "am" : range[2]));
  }
  if (one && (one[2] || /[.:]/.test(one[1]))) return t(one[1] + (one[2] || ""));
  return "TBC";
  function t(x) {
    x = x.replace(/\s/g, "");
    if (!/[.:]/.test(x)) x = x.replace(/^(\d{1,2})/, "$1:00");
    return to24(x.replace(".", ":")) || "TBC";
  }
}

export const diag = {};
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- Daily Info ----------
async function dailyInfo(page, { today, last }) {
  await page.goto("https://www.dailyinfo.co.uk/whats-on", { waitUntil: "domcontentloaded" });
  const hits = await page.evaluate(async ({ today, last }) => {
    const out = [];
    for (let offset = 0; offset < 12000; offset += 1000) {
      const q = new URLSearchParams({ selectedDate: today, sortBy: "name", numListingsLoaded: "0", selectedCategory: "all", tagMatchingStyle: "any", requestId: "1", offset: String(offset), size: "1000", paramVer: "0" });
      const r = await fetch("/whats-on-listings-3?" + q);
      if (!r.ok) throw new Error("Daily Info " + r.status);
      const j = await r.json();
      const rows = (j.hits?.hits || []).map(h => h._source).filter(Boolean);
      if (!rows.length) break;
      for (const s of rows) out.push({
        ms: s.dateobj, name: s.nameNoHtml || s.name, col: s.columnName, type: s.feature_type_name, venue: s.venueName || "",
        addr: [s.venueAddress, s.venuePostCode].filter(Boolean).join(", "), times: (s.timesAndPrices || [])[0] || "",
        web: s.web || "", url: s.url ? location.origin + s.url : "", taster: (s.fields?.tasterText || "").slice(0, 300), id: s.event_id,
      });
      if (rows[rows.length - 1].dateobj > Date.parse(last + "T23:59:59Z")) break;
    }
    return out;
  }, { today, last });
  const events = [], cinemas = [];
  const seen = new Set();
  for (const h of hits) {
    const date = isoDate(h.ms);
    if (date < today || date > last) continue;
    const k = h.id + date; if (seen.has(k)) continue; seen.add(k);
    if (CINEMA_VENUE.test(h.venue)) {
      // Daily Info also lists the cinemas' times: kept as a back-up for cinemas that can't be scraped.
      cinemas.push({ date, venueName: h.venue, name: h.name, times: h.times });
      continue;
    }
    if (/workshops|courses/i.test(h.col)) continue;
    if (!OXFORD_POSTCODE.test(h.addr)) continue; // Oxford itself only (OX1–OX4), not Abingdon, Wantage etc.
    const film = h.col === "Cinema" || h.type === "film" || FILM_NAME.test(h.name);
    if (!film || NOT_FILM.test(h.name)) continue;
    events.push({ date, time: firstTime(h.times), name: h.name, venueName: h.venue, venueAddr: h.addr, url: h.web || h.url, src: "dailyinfo" });
  }
  diag.dailyinfo = { listings: hits.length };
  log("dailyinfo", events.length, "events,", cinemas.length, "cinema listings");
  return { events, cinemas };
}

/** Daily Info cinema listing -> screenings, e.g. times "12.40, 3.15, 8.20pm". */
export function dailyInfoCinemaRows(list) {
  const KEY = [[/curzon/i, "cur"], [/vue/i, "vue"], [/phoenix/i, "phx"], [/ultimate|upp/i, "upp"], [/oxford cinema/i, "ocf"]];
  const out = [];
  for (const c of list) {
    const venue = (KEY.find(([re]) => re.test(c.venueName)) || [])[1];
    if (!venue) continue;
    for (const m of String(c.times).matchAll(/(\d{1,2})[.:](\d\d)\s*([ap]m)?/gi)) {
      let h = +m[1];
      const ap = (m[3] || "").toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      else if (ap === "am" && h === 12) h = 0;
      else if (!ap && h >= 1 && h <= 9) h += 12; // cinema times without am/pm: 1–9 are afternoon/evening
      out.push({ date: c.date, time: `${String(h).padStart(2, "0")}:${m[2]}`, title: c.name.replace(/\s*\[[^\]]*\]\s*$/, ""), venue, tags: [], url: "" });
    }
  }
  return out;
}

// ---------- University of Oxford events (events.ox.ac.uk) ----------
async function oxEvents(page, { today, last }) {
  await page.goto("https://events.ox.ac.uk/", { waitUntil: "domcontentloaded" });
  const rows = await page.evaluate(async ({ today, last }) => {
    const seen = new Set(), out = [];
    for (const kw of ["screening", "film", "documentary", "cinema", "movie"]) {
      const h = await (await fetch("/events/search?" + new URLSearchParams({ keywords: kw, start: today, end: last }))).text();
      const d = new DOMParser().parseFromString(h, "text/html");
      for (const it of d.querySelectorAll('[itemtype="http://schema.org/Event"]')) {
        const a = it.querySelector("h2 a"); if (!a || seen.has(a.href)) continue; seen.add(a.href);
        const g = p => it.querySelector(`[itemprop=${p}]`);
        out.push({
          name: a.textContent.replace(/\s+/g, " ").trim(), start: g("startDate")?.getAttribute("content") || "",
          desc: (g("description")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
          venue: (g("venue")?.textContent || "").replace(/\s+/g, " ").trim(), url: a.href,
        });
      }
    }
    return out;
  }, { today, last });
  const strongDesc = /\b(film screening|screening of|documentary screening|free screening|the film will be screened|will be screening)\b/i;
  const out = rows.filter(r => (FILM_NAME.test(r.name) || strongDesc.test(r.desc)) && !NOT_FILM.test(r.name) && r.start)
    .map(r => ({ date: r.start.slice(0, 10), time: r.start.slice(11, 16) || "TBC", name: r.name, venueName: r.venue, venueAddr: "Oxford", url: r.url, src: "oxevents" }));
  diag.oxevents = { found: rows.length, sample: rows.slice(0, 3).map(r => r.name) };
  log("oxevents", out.length);
  return out;
}

// ---------- WeGotTickets ----------
async function weGotTickets(page, { today, last }) {
  await page.goto("https://wegottickets.com/", { waitUntil: "domcontentloaded" });
  const rows = await page.evaluate(async ({ today, last }) => {
    const M = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const parse = d => [...d.querySelectorAll("a.event_link")].map(a => {
      const b = a.closest(".content.block-group");
      const td = [...(b?.querySelectorAll("table.venue-details td") || [])].map(t => t.textContent.trim());
      const m = (td[1] || "").match(/(\d+)\w\w (\w+), (\d{4})/);
      return { name: a.textContent.trim(), where: td[0] || "", when: td[2] || "", url: a.href,
        date: m ? `${m[3]}-${String(M[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}` : "" };
    });
    const all = new Map();
    const first = await fetch("/searchresults", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "unified_query=oxford" });
    parse(new DOMParser().parseFromString(await first.text(), "text/html")).forEach(e => all.set(e.url, e));
    for (let p = 2; p <= 15; p++) {
      const x = parse(new DOMParser().parseFromString(await (await fetch("/searchresults/page/" + p)).text(), "text/html"));
      let added = 0; x.forEach(e => { if (!all.has(e.url)) { all.set(e.url, e); added++; } });
      if (!added) break;
    }
    const out = [];
    for (const e of all.values()) {
      if (!/^OXFORD\b/i.test(e.where) || !e.date || e.date < today || e.date > last) continue;
      // Each event page says what kind of event it is (schema.org ScreeningEvent for films).
      let type = "", start = "", desc = "", place = "";
      try {
        const d = new DOMParser().parseFromString(await (await fetch(e.url)).text(), "text/html");
        for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
          for (const j of [].concat(JSON.parse(s.textContent))) {
            if (j && j.startDate) { type = [].concat(j["@type"]).join(","); start = j.startDate; desc = (j.description || "").slice(0, 400); place = j.location?.address?.postalCode || ""; }
          }
        }
      } catch {}
      out.push({ ...e, type, start, desc, place });
    }
    return out;
  }, { today, last });
  const out = rows.filter(r => (/ScreeningEvent/.test(r.type) || FILM_NAME.test(r.name)) && !NOT_FILM.test(r.name))
    .map(r => ({
      date: r.date, time: r.start && r.start.length > 10 && r.start.slice(11, 16) !== "00:00" ? r.start.slice(11, 16) : firstTime(r.when),
      name: r.name, venueName: r.where.replace(/^OXFORD:\s*/i, ""), venueAddr: r.place || "Oxford", url: r.url, src: "wegottickets",
    }));
  diag.wegottickets = { oxfordEvents: rows.length, screeningType: rows.filter(r => /Screening/.test(r.type)).length };
  log("wegottickets", out.length, "of", rows.length, "Oxford events");
  return out;
}

// ---------- Eventbrite ----------
async function eventbrite(page, { today, last }) {
  await page.goto("https://www.eventbrite.co.uk/d/united-kingdom--oxford/screening/", { waitUntil: "domcontentloaded" });
  const rows = await page.evaluate(async ({ today, last }) => {
    const seen = new Map();
    for (const q of ["screening", "film-screening", "documentary", "film", "cinema", "movie-night"]) {
      for (const pg of [1, 2, 3]) {
        const h = await (await fetch(`/d/united-kingdom--oxford/${q}/?page=${pg}`)).text();
        const d = new DOMParser().parseFromString(h, "text/html");
        let n = 0;
        for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
          let j; try { j = JSON.parse(s.textContent); } catch { continue; }
          for (const x of [].concat(j)) for (const li of x.itemListElement || []) {
            const i = li.item || li; if (!i.url || !i.startDate) continue; n++;
            if (!seen.has(i.url)) seen.set(i.url, { name: i.name, start: i.startDate, url: i.url, venue: i.location?.name || "",
              pc: i.location?.address?.postalCode || "", street: i.location?.address?.streetAddress || "" });
          }
        }
        if (!n) break;
      }
    }
    const out = [];
    for (const e of seen.values()) {
      if (e.start.slice(0, 10) < today || e.start.slice(0, 10) > last) continue;
      out.push(e);
    }
    // Listing pages only give the date: open each relevant event for its start time.
    for (const e of out) {
      if (!/\bOX[1-4]\s*\d/i.test(e.pc)) continue;
      try {
        const d = new DOMParser().parseFromString(await (await fetch(e.url)).text(), "text/html");
        for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
          for (const j of [].concat(JSON.parse(s.textContent))) if (j?.startDate && j.startDate.length > 10) e.start = j.startDate;
        }
      } catch {}
    }
    return out;
  }, { today, last });
  const out = rows.filter(r => OXFORD_POSTCODE.test(r.pc) && FILM_NAME.test(r.name) && !NOT_FILM.test(r.name))
    .map(r => ({ date: r.start.slice(0, 10), time: r.start.length > 10 ? r.start.slice(11, 16) : "TBC", name: r.name, venueName: r.venue,
      venueAddr: [r.street, r.pc].filter(Boolean).join(", "), url: r.url.replace(/^https:\/\/www\.eventbrite\.com\//, "https://www.eventbrite.co.uk/"), src: "eventbrite" }));
  diag.eventbrite = { found: rows.length, oxford: rows.filter(r => OXFORD_POSTCODE.test(r.pc)).length, sample: rows.slice(0, 3).map(r => r.name + " " + r.pc) };
  log("eventbrite", out.length, "of", rows.length);
  return out;
}

// ---------- Magdalen Monday Movies ----------
async function magdalen(page, { today, last }) {
  await page.goto("https://www.magd.ox.ac.uk/magdalen-monday-movies/", { waitUntil: "domcontentloaded" });
  const text = await page.evaluate(() => (document.querySelector("article, main") || document.body).innerText);
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const year = +today.slice(0, 4);
  const mk = (d, mon) => { let y = year; if (mon < +today.slice(5, 7) - 6) y++; return `${y}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`; };
  const out = [];
  let month = null, prevDay = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // "Mon 26 Oct, 7.30pm: Harakiri (1962)" / "Mon 2, 7pm: Ninotchka (1939)" (month carried over)
    let m = line.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2})(?:\s+([A-Za-z]{3})\w*)?(?:,\s*([\d.:]+\s*[ap]m))?\s*:\s*(.+)$/);
    if (m) {
      if (m[2] && MON[m[2].toLowerCase()]) month = MON[m[2].toLowerCase()];
      else if (month && prevDay && +m[1] < prevDay) month = month % 12 + 1; // "Mon 2" after "Sat 31 Oct" is 2 Nov
      if (!month) continue;
      prevDay = +m[1];
      const date = mk(+m[1], month);
      const name = m[4].replace(/^Hallowe.?en Special\s*[–-]\s*/i, "").trim();
      out.push({ date, time: m[3] ? firstTime(m[3]) : "19:00", name, venueName: "Magdalen College", venueAddr: "High Street, OX1 4AU", url: "https://www.magd.ox.ac.uk/magdalen-monday-movies/", src: "magdalen" });
      continue;
    }
    // "THE THIRD MAN WITH LIVE ZITHER – Sunday 15 Nov 7pm"
    m = line.match(/^(.{4,120}?)\s+[–-]\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2})\s+([A-Za-z]{3})\w*\s+([\d.:]+\s*[ap]m)$/);
    if (m && MON[m[3].toLowerCase()] && m[1] === m[1].toUpperCase()) {
      const name = m[1].replace(/^(?:FILM STUDIES SPECIAL|DESERT A?ISLAND MOVIES):\s*/i, "").replace(/\s+WITH LIVE .*/i, "")
        .toLowerCase().replace(/(^|[\s:(–-])([a-z])/g, (a, b, c) => b + c.toUpperCase());
      if (/desert a?island/i.test(m[1])) continue; // a talk, not a screening
      out.push({ date: mk(+m[2], MON[m[3].toLowerCase()]), time: firstTime(m[4]), name, venueName: "Magdalen College", venueAddr: "High Street, OX1 4AU", url: "https://www.magd.ox.ac.uk/magdalen-monday-movies/", src: "magdalen", tag: /zither/i.test(m[1]) ? "Live zither score" : "" });
    }
  }
  const res = out.filter(e => e.date >= today && e.date <= last);
  log("magdalen", res.length);
  return res;
}

export const EVENT_SOURCES = { dailyinfo: dailyInfo, oxevents: oxEvents, wegottickets: weGotTickets, eventbrite, magdalen };

/** Run every source; a failure in one doesn't stop the others. */
// The University calendar and Eventbrite block GitHub's servers; the job on the owner's computer fetches them instead.
export const LOCAL_EVENT_SOURCES = ["oxevents", "eventbrite"];

export async function scrapeEvents(ctx, { today, days, local = {} }) {
  const last = addDays(today, days - 1);
  const events = [], status = {};
  let cinemas = [];
  for (const [key, fn] of Object.entries(EVENT_SOURCES)) {
    const l = local["ev:" + key];
    if (l && Date.now() - Date.parse(l.at) < 36 * 3600e3) {
      const rows = l.rows.filter(r => r.date >= today && r.date <= last);
      events.push(...rows);
      status[key] = { ok: true, count: rows.length, via: "local", at: l.at };
      continue;
    }
    const page = await ctx.newPage();
    try {
      const r = await fn(page, { today, last });
      const ev = Array.isArray(r) ? r : r.events;
      if (!Array.isArray(r)) cinemas = r.cinemas;
      events.push(...ev);
      status[key] = { ok: true, count: ev.length, ...(diag[key] || {}) };
      if (!ev.length) status[key].page = { url: page.url(), title: await page.title().catch(() => "") };
    } catch (e) {
      log(key, "FAILED:", e.message.split("\n")[0]);
      status[key] = { ok: false, error: e.message.split("\n")[0], page: { title: await page.title().catch(() => "") } };
    }
    await page.close();
  }
  return { events, cinemas, status };
}
