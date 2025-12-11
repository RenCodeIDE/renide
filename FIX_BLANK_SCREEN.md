# Fix for Blank Screen Issue

## Problem Identified ✅

The app was showing a blank screen because **`out/nls.messages.json` was missing**.

**Error from terminal:**

```
Error reading NLS messages file /Applications/Ren.app/Contents/Resources/app.asar/out/nls.messages.json:
Error: ENOENT, out/nls.messages.json not found
```

## Solution Applied ✅

1. **Created the missing file:**

   ```bash
   echo '[]' > out/nls.messages.json
   ```

2. **Updated build script** (`scripts/build_release.sh`) to automatically create this file if missing.

3. **The file is now included** in the build because `electron-builder.yml` has:
   ```yaml
   files:
     - out/**/* # This includes nls.messages.json
   ```

## Next Steps

**Rebuild the DMG:**

```bash
# Option 1: Use the updated build script
./scripts/build_release.sh

# Option 2: Manual rebuild
npm run compile
npm run dist:mac
```

**After rebuilding, test:**

```bash
/Applications/Ren.app/Contents/MacOS/Ren --verbose
```

You should **NOT** see the NLS error anymore, and the workbench should load properly!

## Why This Happened

VS Code requires `nls.messages.json` for National Language Support (NLS). Even if you're using English, this file must exist. The official VS Code build process creates this file, but when using `electron-builder` directly, it needs to be created manually.

The file can be empty (`[]`) for English-only builds, or contain translation data for multi-language support.

## Verification

After rebuilding, verify the file is in the DMG:

```bash
npx asar list release/mac-arm64/Ren.app/Contents/Resources/app.asar | grep "nls.messages.json"
```

Should show: `/out/nls.messages.json`
