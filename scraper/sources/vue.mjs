// Vue Oxford: the what's-on page calls a JSON API; we call it from inside the page so cookies and headers match.
import { addDays, log } from "../lib.mjs";

const KEEP = /Subtitled|Autism|Captioned|Over 18|Hindi|Tamil|Telugu/i;

export async function scrape(page, { today, days }) {
  await page.goto("https://www.myvue.com/cinema/oxford/whats-on", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, i));
  const rows = await page.evaluate(async (dates) => {
    const out = [];
    for (const d of dates) {
      const r = await fetch(`/api/microservice/showings/cinemas/10008/films?showingDate=${d}&minEmbargoLevel=3&includesSession=true&includeSessionAttributes=true`, { headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const f of j.result || []) for (const g of f.showingGroups || []) for (const s of g.sessions || []) {
        if (s.startTime.slice(0, 10) !== d) continue;
        out.push({ date: d, time: s.startTime.slice(11, 16), title: f.filmTitle, attrs: (s.attributes || []).map(a => a.name), url: /^https?:/.test(s.bookingUrl || "") ? s.bookingUrl : "https://www.myvue.com" + (s.bookingUrl || "/cinema/oxford/whats-on"), release: (f.releaseDate || "").slice(0, 10) });
      }
    }
    return out;
  }, dates);
  log("vue", rows.length);
  return rows.map(r => ({ ...r, venue: "vue", tags: r.attrs.filter(a => KEEP.test(a)).map(a => a.replace("Open Captioned", "Captioned")), attrs: undefined }));
}
