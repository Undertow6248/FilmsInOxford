// Last step of every update: list anything that didn't work, and fail the run if there is any,
// so GitHub emails you. The site has already been published by this point; it keeps working
// with fallbacks (last known times, Daily Info's copy of cinema times), so this is a heads-up.
import fs from "node:fs";

const d = JSON.parse(fs.readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const s = d.status || {};
const NAMES = { vue: "Vue", phx: "Phoenix", cur: "Curzon", ocf: "Oxford Cinema & Cafe", upp: "UPP",
  "ev:dailyinfo": "Daily Info", "ev:oxevents": "University events calendar", "ev:wegottickets": "WeGotTickets",
  "ev:eventbrite": "Eventbrite", "ev:magdalen": "Magdalen Monday Movies" };
const problems = [];

for (const k of ["vue", "phx", "cur", "ocf", "upp"]) {
  const v = s[k];
  if (!v) problems.push(`${NAMES[k]}: no result recorded.`);
  else if (!v.ok) problems.push(`${NAMES[k]}: couldn't be read (${v.error || "unknown error"}). Showing its last known times (${v.kept ?? 0} screenings).`);
}
for (const [k, v] of Object.entries(s)) {
  if (!k.startsWith("ev:")) continue;
  if (!v.ok) problems.push(`${NAMES[k] || k}: couldn't be read (${v.error || "unknown error"}). Its screenings are missing this time.`);
}
// Daily Info always has some film events; none at all means its listings have changed shape.
if (s["ev:dailyinfo"]?.ok && !s["ev:dailyinfo"].count) problems.push("Daily Info: read fine but found no film screenings at all, which is unusual. Its layout may have changed.");
if (s.tmdb?.errors?.length) problems.push(`TMDB: ${s.tmdb.errors.length}+ lookups failed (first: ${s.tmdb.errors[0]}). Posters and genres may be missing.`);
const j = s.localJob || {};
if (j.hoursAgo == null || j.hoursAgo > 96) problems.push(`The job on your computer last sent listings ${j.last ? `${j.hoursAgo} hours ago (${j.last})` : "never"}. Check fetch.log in %LOCALAPPDATA%\\FilmsInOxford, or re-run the setup command.`);

const lines = problems.length ? ["Problems in this update:", ...problems.map(p => "- " + p)] : ["Everything worked."];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
for (const p of problems) console.log("::error::" + p);
process.exit(problems.length ? 1 : 0);
