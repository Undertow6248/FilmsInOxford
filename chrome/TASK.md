# Curzon in Chrome: instructions for the scheduled Claude task

Curzon's website blocks automated browsers with a Cloudflare security check, but it works normally in the owner's own Chrome. A scheduled Claude task reads Curzon's Oxford listings there before 10:15 on weekdays. The page script saves the result to the computer's Downloads folder as `films-in-oxford-curzon.txt`. The Films in Oxford job on the same computer runs at 10:15, uploads that file to the repo (`scraper/local/curzon.json`) and deletes it.

The task doesn't touch GitHub. Each run does the following:

1. **Get the page script.** Read the whole text of `https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/chrome/curzon-page.js`, using WebFetch or curl. Run it unchanged.
2. **Open Curzon in Chrome.**
   - Load the Claude in Chrome tools in one ToolSearch call: tabs_context_mcp, tabs_create_mcp, navigate, javascript_tool, get_page_text, computer, tabs_close_mcp.
   - Call tabs_context_mcp first.
   - Open a **new** tab and go to `https://www.curzon.com/venues/oxford/`.
   - If the page title is "Just a moment...", Curzon is showing its security check. Don't try to get past it: close the tab, stop and report it.
3. **Read the listings.**
   - Run the whole script with javascript_tool. It returns straight away and keeps working in the page for 30–90 seconds.
   - Wait with `computer` wait (10 seconds at a time). Then check `window.__curzonDone` with javascript_tool until it is a number.
   - If it's still empty after 3 minutes, close the tab and report a failure.
   - When it's done, the script has already saved `films-in-oxford-curzon.txt` to Downloads. This is expected and approved by the owner.
4. **Check the result.** Call get_page_text on the tab. Confirm that it ends with `END|<number>` and that the number matches `window.__curzonDone`. Then close the tab.
5. **Report.** In one line, give how many screenings and how many days (count the distinct dates in the `S|` lines), or what went wrong.

If Chrome can't be reached (the computer is off, or Chrome is closed), say so and stop. The site keeps using the last Curzon times it has, for up to a week, then falls back to Daily Info's two days. If no new Curzon times arrive for about 4 days, the nightly update's check flags it and GitHub emails the owner.
