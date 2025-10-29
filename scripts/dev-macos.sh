#!/bin/bash

# macOS Development Script - Optimized for fast compilation with Bun
# This script sets up VS Code development with minimal compilation overhead

echo "Starting macOS-optimized VS Code development with Bun..."

# Set environment variables for macOS-only build
export VSCODE_PLATFORM=darwin
export VSCODE_ARCH=$(uname -m)

# Kill any existing watch processes
echo "Cleaning up existing processes..."
pkill -f "gulp watch" || true
pkill -f "npm run watch" || true
pkill -f "bun run watch" || true

# Clean build directory
echo "Cleaning build directory..."
rm -rf out/

# Compile only essential parts with Bun
echo "Compiling essential components with Bun..."
bun run compile-macos

# Start optimized watch process with Bun
echo "Starting optimized watch process with Bun..."
bun run watch-macos &

# Start VS Code in development mode
echo "Launching VS Code..."
./scripts/code.sh --new-window

echo "macOS development environment ready with Bun!"
echo "Note: This setup uses Bun for faster compilation and excludes heavy extensions."
