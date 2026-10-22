// Curzon Oxford: the showtime picker is rendered client-side, so click through each date tab and read the DOM.
// Clicking a tab updates the URL to ?date=YYYY-MM-DD, which we use as the date. (Loading that URL directly doesn't work.)
import { parseDayMonth, to24, log } from "../lib.mjs";

export async function scrape(page, { today }) {
  await page.goto("https://www.curzon.com/venues/oxford/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".v-date-picker [role=tab]", { timeout: 60000 });
  await page.waitForSelector(".v-showtime-picker-film", { timeout: 20000 }).catch(() => {}); // today may be over
  const read = () => page.evaluate(() => [...document.querySelectorAll(".v-showtime-picker-film")].map(f => ({
    title: f.querySelector(".v-showtime-picker-film-details a")?.textContent.trim(),
    times: [...new Set([...f.querySelectorAll(".v-showtime-picker-site-list button, .v-showtime-picker-site-list a")]
      .map(b => b.innerText.replace(/\s+/g, " ").trim()).filter(x => /^\d{1,2}:\d\d\s?[AP]M/i.test(x)))],
  })));
  const n = (await page.$$(".v-date-picker [role=tab]")).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const tab = (await page.$$(".v-date-picker [role=tab]"))[i];
    const label = (await tab.innerText()).replace(/\s+/g, " ").trim();
    if (i > 0) {
      const before = JSON.stringify(await read());
      await tab.click();
      for (let k = 0; k < 30; k++) { await page.waitForTimeout(500); if (JSON.stringify(await read()) !== before) break; }
      await page.waitForTimeout(1200); // let the rest of the list render
    }
    const fromUrl = (page.url().match(/date=(\d{4}-\d\d-\d\d)/) || [])[1];
    const date = fromUrl || (/today/i.test(label) ? today : parseDayMonth(label, today));
    for (const f of await read()) for (const t of f.times) {
      const time = to24(t.match(/^\d{1,2}:\d\d\s?[AP]M/i)[0]);
      if (f.title && time && date) out.push({ date, time, title: f.title, venue: "cur", tags: [], url: "https://www.curzon.com/venues/oxford/" });
    }
  }
  log("curzon", out.length);
  return out;
}
