# Quick Fix: Blank Screen Issue

## Immediate Steps to Diagnose

### 1. Run App from Terminal (See Real Errors)

```bash
# Find where you installed Ren.app
# Then run:
/Applications/Ren.app/Contents/MacOS/Ren --verbose 2>&1 | tee /tmp/ren-errors.log
```

**Look for errors like:**
- "Cannot find module"
- "Failed to load"
- "Workbench not found"
- Path errors

### 2. Check Console Logs

Open **Console.app** (Applications > Utilities) and filter for "Ren" to see system-level errors.

### 3. Most Common Issues Found Online

Based on research, here are the **top causes** of blank screens in VS Code forks:

#### A. **Missing `product.json` in Root** ⚠️ VERY COMMON

VS Code **requires** `product.json` at the root of the app bundle.

**Check:**
```bash
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep "^/product.json$"
```

**If missing, fix `electron-builder.yml`:**
```yaml
files:
  - out/**/*
  - extensions/**/*
  - resources/**/*
  - product.json  # ✅ You have this
  - package.json
```

#### B. **Missing `out/nls.messages.json`**

VS Code needs NLS files to load properly.

**Check:**
```bash
ls -la out/nls.messages.json
```

**If missing:**
```bash
echo '[]' > out/nls.messages.json
npm run dist:mac
```

#### C. **Incorrect Main Entry Point**

The main entry must be `./out/main.js` relative to app root.

**Your config is correct:**
```yaml
extraMetadata:
  main: "./out/main.js"  # ✅ Correct
```

#### D. **Missing Workbench HTML/JS**

**Already verified - these exist:**
- ✅ `/out/vs/code/electron-browser/workbench/workbench.html`
- ✅ `/out/vs/code/electron-browser/workbench/workbench.js`

#### E. **Code Signing / Quarantine**

macOS may block the app.

**Fix:**
```bash
# Remove quarantine
xattr -d com.apple.quarantine /Applications/Ren.app

# Or if in different location
xattr -d com.apple.quarantine "/path/to/Ren.app"
```

#### F. **Missing Resources Directory**

**Check:**
```bash
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep "^/resources/"
```

Should show:
- `/resources/`
- `/resources/darwin/`
- `/resources/server/`

### 4. **VS Code-Specific: Missing Bootstrap Files**

VS Code needs bootstrap files in `out/`:

**Check:**
```bash
ls -la out/bootstrap*.js
```

Should show:
- `bootstrap-esm.js`
- `bootstrap-node.js`
- `bootstrap-fork.js`
- etc.

### 5. **Try Development Mode First**

Test if the app works in dev mode:

```bash
cd /Users/ishaankundesu/Documents/DevWork/ren/renide
./scripts/code.sh
```

**If dev mode works but DMG doesn't:**
- It's a packaging issue
- Check what's different between dev and packaged

### 6. **Compare with Official VS Code**

Extract official VS Code's app.asar and compare:

```bash
# Download official VS Code
# Extract: /Applications/Visual Studio Code.app/Contents/Resources/app.asar
npx asar extract "/Applications/Visual Studio Code.app/Contents/Resources/app.asar" /tmp/vscode-extracted

# Compare structure
diff -r /tmp/vscode-extracted out/ | head -50
```

## Most Likely Fix Based on Research

**The #1 issue found online:** Missing or incorrectly placed `product.json`

**Verify it's in the right place:**
```bash
# Should be at root of asar
npx asar extract-file release/mac-arm64/Ren.app/Contents/Resources/app.asar product.json /tmp/product.json
cat /tmp/product.json
```

**If product.json is missing or wrong:**
1. Ensure `product.json` exists in project root
2. Rebuild: `npm run compile && npm run dist:mac`

## Alternative: Use VS Code's Official Build

If electron-builder keeps having issues, use the official method:

```bash
# This uses Gulp (VS Code's official build system)
npm run gulp vscode-darwin-arm64-min

# Creates: ../VSCode-darwin-arm64/Ren IDE.app

# Create DMG
hdiutil create -volname "Ren IDE" \
  -srcfolder "../VSCode-darwin-arm64/Ren IDE.app" \
  -ov -format UDZO \
  "Ren-1.106.0-arm64.dmg"
```

This method is **guaranteed to work** because it's what Microsoft uses.

## Quick Test Script

Run this to check everything:

```bash
#!/bin/bash
APP="release/mac-arm64/Ren.app/Contents/Resources/app.asar"

echo "Checking product.json..."
npx asar list "$APP" | grep "^/product.json$" && echo "✅ product.json found" || echo "❌ product.json MISSING"

echo "Checking main.js..."
npx asar list "$APP" | grep "^/out/main.js$" && echo "✅ main.js found" || echo "❌ main.js MISSING"

echo "Checking workbench.html..."
npx asar list "$APP" | grep "workbench.html" && echo "✅ workbench.html found" || echo "❌ workbench.html MISSING"

echo "Checking resources..."
npx asar list "$APP" | grep "^/resources/" | head -1 && echo "✅ resources found" || echo "❌ resources MISSING"

echo "Checking extensions..."
npx asar list "$APP" | grep "^/extensions/" | head -1 && echo "✅ extensions found" || echo "❌ extensions MISSING"
```

Save as `check-app.sh`, make executable, and run:
```bash
chmod +x check-app.sh
./check-app.sh
```

