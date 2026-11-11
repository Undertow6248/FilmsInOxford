// Run on https://www.curzon.com/venues/oxford/ in a normal Chrome tab (by the scheduled "Curzon in Chrome" task).
// Clicks through every date tab and writes a compact list into the page, for get_page_text to read:
//   F|Film title|film-path            (one per film)
//   S|YYYY-MM-DD|HH:MM|booking-number (its screenings; booking page is /ticketing/seats/OXF1-<number>/)
// It ends with "END|<number of S lines>". It also saves the same text as films-in-oxford-curzon.txt in the
// browser's Downloads folder, where the Films in Oxford job on the same computer picks it up and uploads it.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !document.querySelector(".v-date-picker [role=tab]"); i++) await sleep(500);
  const read = () => [...document.querySelectorAll(".v-showtime-picker-film")].map(f => {
    const a = f.querySelector(".v-showtime-picker-film-details a");
    return { title: a?.textContent.trim() || "", film: a?.getAttribute("href") || "",
      times: [...f.querySelectorAll(".v-showtime-picker-site-list a, .v-showtime-picker-site-list button")]
        .map(b => ({ t: b.innerText.replace(/\s+/g, " ").trim(), href: b.getAttribute("href") || "" }))
        .filter(x => /^\d{1,2}:\d\d\s?[AP]M/i.test(x.t)) };
  });
  const to24 = t => { const m = t.match(/^(\d{1,2}):(\d\d)\s?([AP]M)/i); let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return String(h).padStart(2, "0") + ":" + m[2]; };
  const films = new Map(), seen = new Set();
  const n = document.querySelectorAll(".v-date-picker [role=tab]").length;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const before = JSON.stringify(read());
      document.querySelectorAll(".v-date-picker [role=tab]")[i].click();
      for (let k = 0; k < 30; k++) { await sleep(500); if (JSON.stringify(read()) !== before) break; }
      await sleep(1200);
    }
    const date = (location.search.match(/date=(\d{4}-\d\d-\d\d)/) || [])[1];
    if (!date) continue;
    for (const f of read()) for (const t of f.times) {
      const seat = ((t.href.match(/seats\/([^/]+)/) || [])[1] || "").replace(/^OXF1-/, "");
      const key = f.title + "|" + date + "|" + t.t;
      if (seen.has(key)) continue; seen.add(key);
      if (!films.has(f.title)) films.set(f.title, { film: f.film, s: [] });
      films.get(f.title).s.push(["S", date, to24(t.t), seat].join("|"));
    }
  }
  const lines = [];
  for (const [title, v] of films) lines.push(["F", title.replace(/\|/g, "/").replace(/TBC$/, "").trim(), v.film].join("|"), ...v.s);
  lines.unshift("AT|" + new Date().toISOString());
  lines.push("END|" + seen.size);
  document.body.innerHTML = "<main><pre id='curzon-out'></pre></main>";
  document.getElementById("curzon-out").textContent = lines.join("\n");
  if (seen.size) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    a.download = "films-in-oxford-curzon.txt";
    document.body.appendChild(a); a.click();
  }
  window.__curzonDone = seen.size;
})();
