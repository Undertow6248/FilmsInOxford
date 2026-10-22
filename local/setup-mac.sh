#!/bin/bash
# Films in Oxford: sets up the daily Vue + Curzon fetch on this Mac. No admin rights needed.
# Run in Terminal:  curl -fsSL https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local/setup-mac.sh | bash
set -euo pipefail
REPO=https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local
DIR="$HOME/Library/Application Support/FilmsInOxford"
mkdir -p "$DIR"; cd "$DIR"
echo "Setting up in $DIR"

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  V=v22.20.0; ARCH=$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 )
  if [ ! -x node/bin/node ]; then
    echo "Downloading Node.js..."
    curl -fsSL "https://nodejs.org/dist/$V/node-$V-darwin-$ARCH.tar.gz" | tar xz
    rm -rf node; mv "node-$V-darwin-$ARCH" node
  fi
  NODE="$DIR/node/bin/node"
fi
NPM="$(dirname "$NODE")/npm"
for f in fetch.mjs package.json; do curl -fsSL "$REPO/$f" -o "$f"; done
PATH="$(dirname "$NODE"):$PATH" "$NPM" install --no-audit --no-fund --silent

if [ ! -f config.json ]; then
  printf "Paste your GitHub token (starts github_pat_), then press Enter: "
  read -rs TOKEN < /dev/tty; echo
  printf '{"token":"%s"}' "$TOKEN" > config.json; chmod 600 config.json
fi

PLIST="$HOME/Library/LaunchAgents/uk.filmsinoxford.fetch.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>uk.filmsinoxford.fetch</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/fetch.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>15</integer></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Daily job added (10:15, and at login; catches up after sleep)."
echo "Running it once now..."
"$NODE" fetch.mjs --force && echo "Done. Vue and Curzon times are on their way to the site." || echo "Problem on first run; see $DIR/fetch.log"
