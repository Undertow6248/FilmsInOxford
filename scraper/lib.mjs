// Shared helpers for the scrapers.
export const TZ = "Europe/London";

/** Today's date in London as YYYY-MM-DD. */
export function londonToday(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "6:20PM" / "18:20" / "6.20pm" -> "18:20" */
export function to24(s) {
  const m = String(s).trim().match(/^(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = +m[1];
  const ap = (m[3] || "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Turn "Sat 24 Oct", "Saturday 24th October 2026" etc. into YYYY-MM-DD, guessing the year from today. */
export function parseDayMonth(text, today = londonToday()) {
  const m = String(text).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{4}))?/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  let year = m[3] ? +m[3] : +today.slice(0, 4);
  let iso = `${year}-${String(mon).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  if (!m[3] && iso < addDays(today, -60)) iso = `${year + 1}${iso.slice(4)}`;
  return iso;
}

/** Normalise a cinema's film title so the same film matches across venues. */
export function cleanTitle(t) {
  return String(t)
    .replace(/\s+/g, " ")
    .replace(/\s*\((?:\d{4}|re-?release|\d+(?:st|nd|rd|th) anniversary[^)]*|tamil|hindi|telugu|subtitled|4k[^)]*)\)\s*/gi, " ")
    .replace(/\s*-\s*preview$/i, "")
    .replace(/\s*(\.{3}|…)\s*$/, "")
    .replace(/^NTLive:\s*/i, "NT Live: ")
    .replace(/\s*\((?:\d{1,2}\+|PG|12A?|15|18|U)\)\s*$/i, "")
    .replace(/^(ken russell's|evolution of horror presents:|film club:[^:]*:)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function log(...a) { console.log("[scrape]", ...a); }
