// Turns the lines read from Curzon's page (see curzon-page.js) into scraper/local/curzon.json.
// Usage: node chrome/curzon-import.mjs lines.txt
import fs from "node:fs";
const text = fs.readFileSync(process.argv[2], "utf8");
const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => /^(F|S|END)\|/.test(l));
const end = lines.find(l => l.startsWith("END|"));
if (!end) throw new Error("No END line: the page read didn't finish, or the copy was cut short.");
const rows = [];
let film = null;
for (const l of lines) {
  const p = l.split("|");
  if (p[0] === "F") film = { title: p[1], url: p[2] ? new URL(p[2], "https://www.curzon.com/").href : "" };
  else if (p[0] === "S") {
    const [, date, time, seat] = p;
    if (!film || !/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) throw new Error("Bad line: " + l);
    rows.push({ date, time, title: film.title, venue: "cur", tags: [], url: seat ? `https://www.curzon.com/ticketing/seats/OXF1-${seat}/` : film.url, filmUrl: film.url });
  }
}
if (+end.split("|")[1] !== rows.length) throw new Error(`Expected ${end.split("|")[1]} screenings but got ${rows.length}: some were lost when copying.`);
if (!rows.length) throw new Error("No screenings found on Curzon's page.");
const out = new URL("../scraper/local/curzon.json", import.meta.url);
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }));
console.log(`Saved ${rows.length} Curzon screenings, ${[...new Set(rows.map(r => r.date))].length} days, to scraper/local/curzon.json`);
