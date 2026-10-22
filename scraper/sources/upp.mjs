// Ultimate Picture Palace: the what's-on page lists every screening by date in plain HTML.
// Each day is an <h5> ("Friday 23rd October"), followed by blocks with a time, an <h5> title link to /show/, and a "Book here" link.
import { parseDayMonth, to24, log } from "../lib.mjs";

export async function scrape(page, { today }) {
  await page.goto("https://uppcinema.com/whats-on/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const raw = await page.evaluate(() => {
    // The "By film" tab has one table row per screening: "Saturday 24th October 2026 : 5.30pm" + booking link.
    const out = [];
    document.querySelectorAll("table tr").forEach(tr => {
      const m = tr.innerText.match(/(\w+day \d{1,2}\w\w \w+ \d{4}) : (\d{1,2}\.\d\d[ap]m)/i);
      if (!m) return;
      let el = tr.closest("table"), title = null, titleHref = "", tag = (tr.querySelector("strong, b")?.innerText || "").trim();
      while (el && !title) { el = el.previousElementSibling; if (el && el.querySelector) { const a = el.matches('a[href*="/show/"]') ? el : el.querySelector('a[href*="/show/"]'); if (a && a.innerText.trim()) { title = a.innerText.trim(); titleHref = a.href; } } }
      // The film's own page at UPP (its times and booking); UPP's booking links all go to one generic page.
      if (title) out.push({ when: m[1], time: m[2], title, tag, book: titleHref });
    });
    return out;
  });
  const seen = new Set(), out = [];
  for (const r of raw) {
    const date = parseDayMonth(r.when, today), time = to24(r.time);
    const title = r.title.replace(/\s*\((?:Cert[- ]?)?(?:U|PG|12A?|15|18|R18|N\/A|TBC|[^)]*TBC)\)\s*$/i, "").trim();
    const k = date + time + title; if (seen.has(k)) continue; seen.add(k);
    out.push({ date, time, title, venue: "upp", tags: r.tag ? r.tag.split("/").map(s => s.trim()).filter(Boolean) : [], url: r.book, filmUrl: r.book });
  }
  log("upp", out.length);
  return out;
}
