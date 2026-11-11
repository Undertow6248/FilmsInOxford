# Curzon in Chrome: instructions for the scheduled Claude task

Curzon's website blocks automated browsers with a Cloudflare security check, but it works normally in the owner's own Chrome. A scheduled Claude task reads Curzon's Oxford listings there a few times a week and saves them to `scraper/local/curzon.json`. The nightly site update then uses them.

Each run does the following:

1. **Get the repo.** Attach `Undertow6248/FilmsInOxford` with push access (add_repo), then clone it.
2. **Open Curzon in Chrome.**
   - Load the Claude in Chrome tools in one ToolSearch call: tabs_context_mcp, tabs_create_mcp, navigate, javascript_tool, get_page_text, computer, tabs_close_mcp.
   - Open a **new** tab and go to `https://www.curzon.com/venues/oxford/`.
3. **Read the listings.**
   - Run the whole of `chrome/curzon-page.js` from the repo with javascript_tool. It returns straight away and keeps working in the page for 30–60 seconds.
   - Wait with `computer` wait (10 seconds at a time). Then check `window.__curzonDone` with javascript_tool until it is a number.
   - If it's still empty after 2 minutes, stop and report a failure.
   - If the page title is "Just a moment...", Curzon is showing its security check. Don't try to get past it: stop and report it.
4. **Copy the result.**
   - Call get_page_text on the tab. The text is lines starting `F|`, `S|` and ending `END|<number>`.
   - Write it, exactly and completely, to a file such as `/tmp/curzon-lines.txt`.
   - Close the tab.
5. **Import it.** Run `node chrome/curzon-import.mjs /tmp/curzon-lines.txt` in the repo.
   - The importer checks that the number of screenings matches the END line.
   - If it reports a mismatch, the copy lost lines. Fix the file from the page text and run it again.
   - Don't commit a file that fails.
6. **Save to the repo.** Commit only `scraper/local/curzon.json`:
   - Author: `Undertow6248 <Undertow6248@users.noreply.github.com>`
   - Message: `Curzon times via Chrome (YYYY-MM-DD)`
   - Run `git pull --rebase` first, then push to `main`.
   - The push starts a site update by itself.
7. **Report.** In one line, give how many screenings and days were saved, or what went wrong.

If Chrome can't be reached (the computer is off, or Chrome is closed), say so and stop. The site falls back to Daily Info's two days for Curzon. If no run succeeds for about 4 days, the nightly update's check flags it and GitHub emails the owner.
