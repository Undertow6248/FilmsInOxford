# Oxford Screens

Every film showing in Oxford over the next two weeks: the five cinemas plus colleges, pubs, libraries and one-off community screenings. The site is a single static page hosted on GitHub Pages and updated by a scheduled GitHub Action.

## How it works

Every night at about 5am, and again on Tuesday lunchtime, `.github/workflows/update.yml` does the following:

1. Opens each cinema's own listings page in a headless browser and reads the times. The scrapers are in `scraper/sources/`: Vue, Phoenix Picturehouse, Curzon, The Oxford Cinema & Cafe and UPP.
2. Adds the hand-entered one-off screenings from `scraper/extras.json`.
3. Looks each film up on TMDB to get its year, genres, countries and poster, then sorts it into a section:
   - Wide release: showing at Vue.
   - Limited release: new, but not at Vue.
   - Throwback: released more than about 18 months ago.
   - Also on screen: theatre, opera, concerts and similar events.
4. Writes `site/data.json`, commits it, and publishes `site/` to GitHub Pages.

If a cinema's site fails to load, that cinema's previous listings are kept, and the page notes that they may be out of date.

## Setup (one time)

1. Repo **Settings → Secrets and variables → Actions → New repository secret**. Set the name to `TMDB_TOKEN` and the value to your TMDB *API Read Access Token*, the long one beginning `eyJ`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. **Actions → Update listings → Run workflow**. The site appears at `https://<user>.github.io/<repo>/`.

## Vue and Curzon: the job on your computer

Vue and Curzon block GitHub's servers, so a small job on your own computer fetches their times once a day and sends them to `scraper/local/listings.json`. The site uses those times while they are less than 36 hours old.

- **Windows:** in PowerShell, run `irm https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local/setup-windows.ps1 | iex`. This adds the scheduled task "Films in Oxford".
- **Mac:** in Terminal, run `curl -fsSL https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local/setup-mac.sh | bash`.

Setup asks for a GitHub fine-grained token that has access to this repo only, with **Contents: Read and write** permission. Each run downloads the latest scraper code from the repo, so fixes made here apply to the job without reinstalling. A log is kept in `fetch.log` in the install folder.

## Everyday edits

- **Add a one-off screening.** Add a line to `scraper/extras.json`, using an existing line as the pattern. `venue` must be one of the venue keys in `site/index.html`; to add a new venue, add it to `V` there. Past screenings drop off automatically.
- **Fix a film's section or match.** Edit `scraper/overrides.json`:
  - `cat`: W, L, T or E.
  - `year`: helps TMDB find the right film.
  - `tmdb`: pins an exact TMDB id. The id is the number in the film's themoviedb.org URL.
  - `aliases`: merges different spellings of the same film from different cinemas.
- Committing either file triggers a fresh update.

## Run it locally

```
npm install
npx playwright install chromium
TMDB_TOKEN=... node scraper/run.mjs     # or --only=upp to test one cinema
npm run serve                            # http://localhost:8080
```

## Credits

Film details and posters are from [TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB. Times come from each venue's own website.
