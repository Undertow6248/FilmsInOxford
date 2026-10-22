// Phoenix Picturehouse: the cinema page POSTs to /api/scheduled-movies-ajax with cinema_id=014.
import { addDays, log } from "../lib.mjs";

const KEEP = /Kids|Big Scream|Subtitled|Silver|Toddler|Q&A|Preview|Autism|Relaxed|reDiscover|Discover|Live/i;

export async function scrape(page, { today, days }) {
  await page.goto("https://www.picturehouses.com/cinema/phoenix-picturehouse", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const last = addDays(today, days - 1);
  const rows = await page.evaluate(async ({ today, last }) => {
    const tok = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const r = await fetch("/api/scheduled-movies-ajax", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-TOKEN": tok, "X-Requested-With": "XMLHttpRequest" },
      body: "cinema_id=014",
    });
    const j = await r.json();
    const out = [];
    for (const m of j.movies || []) for (const s of m.show_times || []) {
      if (s.CinemaId !== "014" || s.date_f < today || s.date_f > last) continue;
      out.push({ date: s.date_f, time: s.time, title: m.Title, attrs: s.SessionAttributesNames || [], sid: s.SessionId });
    }
    return out;
  }, { today, last });
  log("phoenix", rows.length);
  return rows.map(r => ({
    date: r.date, time: r.time, title: r.title, venue: "phx",
    tags: r.attrs.filter(a => KEEP.test(a)).map(a => a.replace(/^Silver Scr.*/, "Silver Screen").replace(/^Toddler Ti.*/, "Toddler Time").replace(/^LiveSat.*/, "Live")),
    url: "https://www.picturehouses.com/cinema/phoenix-picturehouse",
  }));
}
