# Blank Screen / App Not Loading - Troubleshooting Guide

## Problem
The Ren IDE app opens but shows a blank/dark screen with nothing loading.

## Common Causes & Solutions

### 1. **Missing Workbench Files** ⚠️ MOST LIKELY ISSUE

VS Code requires specific workbench files to load. Check if these are included:

**Required files:**
- `out/vs/code/electron-browser/workbench/workbench.html`
- `out/vs/code/electron-browser/workbench/workbench.js`
- `out/vs/workbench/electron-browser/desktop.main.js`
- All files in `out/vs/` directory

**Check if included:**
```bash
# Check what's in the asar archive
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep workbench
```

**Solution:** Ensure `electron-builder.yml` includes all `out/**/*` files:
```yaml
files:
  - out/**/*  # This should include everything
```

### 2. **Missing Resources Directory**

VS Code needs the `resources` directory for icons, images, and static assets.

**Check:**
```bash
ls -la release/mac-arm64/Ren.app/Contents/Resources/app.asar
# Should contain resources/ directory
```

**Solution:** Your `electron-builder.yml` already includes:
```yaml
files:
  - resources/**/*
```

### 3. **Missing Extensions**

Built-in extensions are required for VS Code to function.

**Check:**
```bash
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep extensions
```

**Solution:** Your config includes:
```yaml
files:
  - extensions/**/*
```

### 4. **Code Signing / Quarantine Issue**

macOS may block unsigned apps from loading properly.

**Solution:**
```bash
# Remove quarantine attribute
xattr -d com.apple.quarantine /Applications/Ren.app

# Or if installed elsewhere
xattr -d com.apple.quarantine "/path/to/Ren.app"
```

### 5. **Missing Native Modules**

Native modules (`.node` files) must be unpacked from asar.

**Check your config:**
```yaml
asarUnpack:
  - "**/*.node"  # ✅ You have this
```

**Verify:**
```bash
ls -la release/mac-arm64/Ren.app/Contents/Resources/app.asar.unpacked/
# Should contain node_modules with .node files
```

### 6. **Check Console Logs**

The app may be showing errors in the console.

**To check logs:**
1. Open Terminal
2. Run the app from command line:
   ```bash
   /Applications/Ren.app/Contents/MacOS/Ren
   ```
3. Look for error messages

**Or check system logs:**
```bash
log show --predicate 'process == "Ren"' --last 5m
```

### 7. **Missing Main Entry Point**

The app must have `out/main.js` as the entry point.

**Check:**
```bash
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep "out/main.js"
```

**Your config has:**
```yaml
extraMetadata:
  main: "./out/main.js"  # ✅ Correct
```

### 8. **Incomplete Build**

The `out/` directory may not have all required files.

**Solution:**
```bash
# Rebuild everything
npm run compile

# Verify out/ directory has all files
ls -la out/vs/code/electron-browser/workbench/
# Should show: workbench.html, workbench.js

# Then rebuild DMG
npm run dist:mac
```

### 9. **VS Code-Specific: Missing NLS Files**

VS Code needs NLS (National Language Support) files.

**Check:**
```bash
ls -la out/nls.messages.json
```

**If missing, create it:**
```bash
echo '[]' > out/nls.messages.json
```

### 10. **Electron Version Mismatch**

The Electron version in the built app may not match what was used during development.

**Check:**
```bash
cat package.json | grep electron
```

**Solution:** Ensure `electron-builder` uses the correct Electron version.

## Quick Diagnostic Steps

1. **Check if workbench files exist in asar:**
   ```bash
   npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep -E "(workbench|out/vs/code)"
   ```

2. **Run app from terminal to see errors:**
   ```bash
   /Applications/Ren.app/Contents/MacOS/Ren --verbose
   ```

3. **Check if main.js exists:**
   ```bash
   npx asar extract-file release/mac-arm64/Ren.app/Contents/Resources/app.asar out/main.js /tmp/main.js
   cat /tmp/main.js | head -20
   ```

4. **Verify build was complete:**
   ```bash
   ls -la out/vs/code/electron-browser/workbench/
   # Should show workbench.html and workbench.js
   ```

## Most Likely Fix

Based on VS Code fork issues, the **most common problem** is:

**Missing or incomplete `out/` directory in the packaged app.**

**Fix:**
1. Ensure you ran `npm run compile` BEFORE building the DMG
2. Verify `out/` has all files:
   ```bash
   ls -R out/ | grep -E "(workbench|main\.js)" | head -10
   ```
3. Rebuild with verbose logging:
   ```bash
   DEBUG=electron-builder* npm run dist:mac
   ```

## Alternative: Use VS Code's Official Build Method

If electron-builder continues to have issues, use VS Code's official method:

```bash
# Build app bundle
npm run gulp vscode-darwin-arm64-min

# This creates: ../VSCode-darwin-arm64/Ren IDE.app

# Then create DMG manually
hdiutil create -volname "Ren IDE" \
  -srcfolder "../VSCode-darwin-arm64/Ren IDE.app" \
  -ov -format UDZO \
  "Ren-1.106.0-arm64.dmg"
```

## Still Not Working?

1. **Check the exact error:**
   - Run from terminal: `/Applications/Ren.app/Contents/MacOS/Ren`
   - Check Console.app for errors
   - Look for crash reports in `~/Library/Logs/DiagnosticReports/`

2. **Compare with working build:**
   - Extract a working VS Code DMG
   - Compare file structure
   - Check what files are in their `app.asar`

3. **Test in development mode:**
   ```bash
   ./scripts/code.sh
   ```
   If this works but DMG doesn't, it's a packaging issue.

## Resources

- [VS Code Build Issues](https://github.com/microsoft/vscode/issues)
- [electron-builder Troubleshooting](https://www.electron.build/troubleshooting)
- [VS Code Architecture](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)

