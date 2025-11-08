#!/bin/bash
# Launch Ren IDE with DevTools enabled for debugging

APP_PATH="/Users/rahilmittal/Desktop/RenCodeIde/new-repo/VSCode-darwin-arm64/Ren IDE.app/Contents/MacOS/Electron"

echo "Launching Ren IDE with DevTools..."
echo "DevTools will open automatically when the app starts."
echo "Check the Console tab for errors when it crashes."
echo ""
echo "Press Ctrl+C to stop this script"
echo ""

cd "$(dirname "$APP_PATH")"
"$APP_PATH" --open-devtools
