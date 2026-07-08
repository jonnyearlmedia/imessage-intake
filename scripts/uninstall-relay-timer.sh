#!/bin/zsh
# Stop and remove the Trish relay launchd timer.  Usage:  npm run uninstall-relay-timer
LABEL="com.jonnyearl.imessage-trish-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ Trish relay timer removed. Messages with Trish no longer sync to jonny-os."
