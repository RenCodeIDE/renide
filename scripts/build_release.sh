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

echo "🔧 Rebuilding native dependencies for Electron..."
npx electron-builder install-app-deps

echo "🔨 Compiling source code for production (to out-build/)..."
# We use max-old-space-size to prevent memory crashes during the heavy compilation
export NODE_OPTIONS="--max-old-space-size=8192"
npx gulp compile-build-without-mangling

# Verify compilation success
if [ ! -f "out-build/main.js" ]; then
    echo "❌ Error: Compilation failed. out-build/main.js not found!"
    exit 1
fi
echo "✅ Compilation to out-build/ completed"

# Create nls.messages.json if missing (required for VS Code to load)
if [ ! -f "out-build/nls.messages.json" ]; then
    echo "📝 Creating missing nls.messages.json..."
    echo '[]' > out-build/nls.messages.json
fi

# CRITICAL: Bundle JavaScript files using esbuild (via gulp)
# This creates bundled JS files that work inside ASAR archives
echo "📦 Bundling JavaScript (required for production builds)..."
npx gulp bundle-vscode

# Verify bundling succeeded
if [ ! -d "out-vscode" ]; then
    echo "❌ Error: Bundling failed. out-vscode directory not found!"
    exit 1
fi

# Verify the bundled workbench file exists and is large enough
if [ -f "out-vscode/vs/workbench/workbench.desktop.main.js" ]; then
    BUNDLE_SIZE=$(stat -f%z "out-vscode/vs/workbench/workbench.desktop.main.js" 2>/dev/null || stat -c%s "out-vscode/vs/workbench/workbench.desktop.main.js")
    echo "✅ Bundled workbench.desktop.main.js size: $BUNDLE_SIZE bytes"
    if [ "$BUNDLE_SIZE" -lt 100000 ]; then
        echo "⚠️  Warning: Bundle seems too small, might not be properly bundled"
    fi
else
    echo "❌ Error: Bundled workbench.desktop.main.js not found!"
    exit 1
fi

# Create 'out' directory from bundled output for electron-builder
echo "📋 Creating out/ from bundled output..."
rm -rf out
cp -r out-vscode out
echo "✅ Bundled output copied to out/"

# CRITICAL: Bundle extensions for production
echo "📦 Bundling extensions for production..."
npx gulp compile-extensions-build

# Verify extension bundling succeeded
if [ ! -d ".build/extensions" ]; then
    echo "❌ Error: Extension bundling failed. .build/extensions directory not found!"
    exit 1
fi
echo "✅ Extensions bundled to .build/extensions"

# Copy bundled extensions to out/extensions for electron-builder
echo "📋 Copying bundled extensions..."
rm -rf out/extensions 2>/dev/null || true
mkdir -p out/extensions
cp -r .build/extensions/* out/extensions/
echo "✅ Bundled extensions ready"

echo "🍎 Packaging for macOS with electron-builder..."
npm run dist:mac

echo "✅ Done! Your app is in the 'release' folder."
