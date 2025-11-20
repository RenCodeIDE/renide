#!/bin/bash

# Exit on any error
set -e

# Navigate to the project root (renide/)
# This ensures commands run in the correct place regardless of where the script is called from
cd "$(dirname "$0")/.."

echo "📂 Working in: $(pwd)"

echo "🧹 Cleaning up old build artifacts..."
rm -rf out
rm -rf release

echo "📦 Installing dependencies..."
npm install

echo "🔨 Compiling source code..."
# We use max-old-space-size to prevent memory crashes during the heavy compilation
export NODE_OPTIONS="--max-old-space-size=8192"
npm run compile

echo "🍎 Packaging for macOS..."
npm run dist:mac

echo "✅ Done! Your app is in the 'release' folder."
