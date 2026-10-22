// The Oxford Cinema & Cafe: the buy-tickets page has a button per date; each shows films with their times.
import { parseDayMonth, to24, log } from "../lib.mjs";

export async function scrape(page, { today }) {
  await page.goto("https://www.oxfordcinema.co.uk/en/buy-tickets", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const parse = () => page.evaluate(() => {
    const L = document.querySelector("main").innerText.split("\n").map(s => s.trim()).filter(Boolean);
    const out = []; let cur = null;
    for (let i = 0; i < L.length; i++) {
      if (/^\d+h( \d+m)?$|^\d+m$/.test(L[i]) && i > 0) { cur = { t: L[i - 1], ts: [] }; out.push(cur); }
      else if (cur && /^\d{1,2}:\d\d\s?[AP]M$/i.test(L[i])) cur.ts.push(L[i]);
    }
    return out;
  });
  const buttons = await page.$$("main button");
  const out = [];
  for (const b of buttons) {
    const label = (await b.innerText()).replace(/\s+/g, " ").trim();
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*\d{1,2}\s*[A-Za-z]{3}$/.test(label)) continue;
    const date = parseDayMonth(label.replace(/^(\w{3})\s*(\d+)\s*(\w+)$/, "$2 $3"), today);
    await b.click();
    await page.waitForTimeout(2500);
    let films = await parse();
    if (!films.length) { await page.waitForTimeout(4000); films = await parse(); } // some days load slowly
    for (const f of films) for (const t of f.ts) out.push({ date, time: to24(t), title: f.t, venue: "ocf", tags: [], url: "https://www.oxfordcinema.co.uk/en/buy-tickets" });
  }
  log("oxford cinema", out.length);
  return out;
}
