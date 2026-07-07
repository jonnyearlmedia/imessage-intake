#!/bin/zsh
# Stop and remove the launchd timer.  Usage:  npm run uninstall-timer
LABEL="com.jonnyearl.imessage-intake"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ Timer removed. The pipeline no longer runs on a schedule."
