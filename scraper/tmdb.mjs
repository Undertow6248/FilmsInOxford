// TMDB lookups: find each title, then fetch year, genres, countries and poster.
// Needs TMDB_TOKEN (the "API Read Access Token") in the environment. Results are cached in data/tmdb-cache.json
// so each film is only looked up once.
import fs from "node:fs";
import { log } from "./lib.mjs";

const CACHE = new URL("../data/tmdb-cache.json", import.meta.url);
const API = "https://api.themoviedb.org/3";
const COUNTRY = { "United States of America": "USA", "United Kingdom": "UK", "Korea, Republic of": "South Korea", "Russian Federation": "Russia", "Iran, Islamic Republic of": "Iran", "Czech Republic": "Czechia" };

export const stats = { token: !process.env.TMDB_TOKEN ? "missing" : process.env.TMDB_TOKEN.trim().startsWith("eyJ") ? "read token" : `key, ${process.env.TMDB_TOKEN.trim().length} chars`, lookups: 0, found: 0, errors: [] };
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}

async function get(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  // Accept either credential TMDB gives you: the long "API Read Access Token" (sent as a header)
  // or the short "API Key" (sent as ?api_key=).
  const cred = (process.env.TMDB_TOKEN || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "");
  const headers = { accept: "application/json" };
  if (cred.startsWith("eyJ")) headers.Authorization = `Bearer ${cred}`; else url.searchParams.set("api_key", cred);
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`TMDB ${r.status} ${path}`);
  return r.json();
}

const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/** Strip event prefixes so "NT Live: Golden Boy" searches as "Golden Boy". */
function searchTitle(t) {
  return t.replace(/^(NT Live|National Theatre Live|Royal Ballet & Opera|RBO( Live| Encore)?|Met Opera( Live)?|Kids' Club|Parent & Baby):\s*/i, "")
    .replace(/\s*\+\s.*$/, "").trim();
}

async function find(title, hint) {
  if (hint.tmdb) return hint.tmdb;
  const q = searchTitle(title);
  const tries = hint.year ? [{ query: q, primary_release_year: hint.year }, { query: q, year: hint.year }, { query: q }] : [{ query: q }];
  for (const p of tries) {
    const j = await get("/search/movie", { ...p, include_adult: "false", language: "en-GB", region: "GB" });
    const res = (j.results || []).filter(r => r.media_type !== "tv");
    if (!res.length) continue;
    // Prefer an exact title match, then the most popular.
    const exact = res.filter(r => norm(r.title) === norm(q) || norm(r.original_title) === norm(q));
    const pool = (exact.length ? exact : res).slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    // Without a year, a loose match on an unknown indie title is often wrong: only accept it if it's recent or exact.
    if (!exact.length && !hint.year) {
      const y = +(pool[0].release_date || "0").slice(0, 4);
      if (y < new Date().getFullYear() - 1) return null;
    }
    return pool[0].id;
  }
  return null;
}

/** Is there a film on TMDB with exactly this title? Returns its TMDB title, or null. Cached (misses for a week). */
export async function exactTitle(q) {
  q = String(q || "").trim();
  if (!process.env.TMDB_TOKEN || q.length < 2) return null;
  const key = "exact:" + norm(q);
  const c = cache[key];
  if (c && (c.title || Date.now() - c.at < 7 * 864e5)) return c.title || null;
  try {
    const j = await get("/search/movie", { query: q, include_adult: "false", language: "en-GB" });
    const hit = (j.results || []).filter(r => norm(r.title) === norm(q) || norm(r.original_title) === norm(q))
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
    cache[key] = { title: hit ? hit.title : "", at: Date.now() };
    return hit ? hit.title : null;
  } catch { return null; }
}

/** Returns {id, year, genres[], countries[], poster, release} or null. */
export async function enrich(title, hint = {}) {
  const key = title + (hint.tmdb ? "#" + hint.tmdb : hint.year ? "#" + hint.year : "");
  if (!process.env.TMDB_TOKEN || hint.skip) return cache[key] || null;
  // Cached entries from before languages were recorded get their details fetched again.
  if (cache[key] && cache[key].lang !== undefined) return cache[key];
  try {
    stats.lookups++;
    const id = cache[key]?.id || await find(title, hint);
    let out = null;
    if (id) {
      const d = await get(`/movie/${id}`, { language: "en-GB" });
      out = {
        id,
        year: (d.release_date || "").slice(0, 4),
        release: d.release_date || "",
        genres: (d.genres || []).map(g => g.name.replace("Science Fiction", "Sci-fi")).slice(0, 3),
        countries: (d.production_countries || []).map(c => COUNTRY[c.name] || c.name).slice(0, 3),
        poster: d.poster_path || "",
        // The film's original (main spoken) language, by its English name.
        lang: ((d.spoken_languages || []).find(l => l.iso_639_1 === d.original_language)?.english_name)
          || (d.original_language ? new Intl.DisplayNames(["en"], { type: "language" }).of(d.original_language) : "") || "",
      };
    }
    if (out) { cache[key] = out; stats.found++; } // misses are retried next run, in case TMDB adds the film
    return out;
  } catch (e) {
    log("tmdb error", title, e.message);
    if (stats.errors.length < 5) stats.errors.push(`${title}: ${e.message}`);
    return null;
  }
}

export function saveCache() {
  fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
}
