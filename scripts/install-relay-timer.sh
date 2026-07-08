#!/bin/zsh
# Install the launchd timer for the TRISH RELAY — ships new messages in the 1:1
# thread with Trish up to the jonny-os Communications Log every 15 minutes.
# This is SEPARATE from the task-intake timer (own label, own log, own watermark).
# Usage:  npm run install-relay-timer     (from the repo root)
# Remove: npm run uninstall-relay-timer
set -e

LABEL="com.jonnyearl.imessage-trish-relay"
REPO="$(cd "$(dirname "$0")/.." && pwd)"        # repo root, wherever it lives
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$REPO/relay.log"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$REPO" && npm run relay -- --post</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ Trish relay timer installed: runs every 15 minutes."
echo "   Plist:  $PLIST"
echo "   Log:    $LOG   (tail it with:  tail -f \"$LOG\")"
echo "   Stop it anytime with:  npm run uninstall-relay-timer"
