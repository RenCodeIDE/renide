# DMG Creation Guide for Ren IDE

This guide explains how to create a DMG (Disk Image) file for distributing Ren IDE on macOS.

## Important Note: `pack:mac` Script

**The `pack:mac` script EXISTS in your `package.json`** (line 16). If you're getting a "Missing script" error, try:

1. **Verify the script exists:**
   ```bash
   npm run | grep pack
   ```
2. **If it's missing, you may need to reload/restart:**
   - Close and reopen your terminal
   - Or run: `npm install` to refresh npm's script cache

## Current Setup

Your project is already configured to create DMG files using **electron-builder**. The configuration is in `electron-builder.yml`.

**Note:** VS Code's official build process uses **Gulp tasks** (`vscode-darwin-x64-min`, `vscode-darwin-arm64-min`) to build the `.app` bundle, then creates DMG files separately. Your fork uses `electron-builder` which is a **simpler, modern alternative** that's perfectly valid for VS Code forks.

## Method 1: Using electron-builder (Recommended - Already Configured)

### Quick Start

1. **Compile the application:**

   ```bash
   npm run compile
   ```

2. **Create the DMG:**

   ```bash
   npm run dist:mac
   ```

   Or use the automated build script:

   ```bash
   ./scripts/build_release.sh
   ```

3. **Find your DMG:**
   The DMG will be created in the `release/` folder with the name format:
   ```
   Ren-{version}-{arch}.dmg
   ```
   Example: `Ren-1.106.0-arm64.dmg`

### Current Configuration

Your `electron-builder.yml` is configured with:

- **Output directory:** `release/`
- **DMG target:** Enabled for macOS
- **Icon:** `resources/darwin/code.icns`
- **Category:** Developer Tools
- **App ID:** `com.yourco.ren`

### Customizing the DMG

You can enhance your DMG by updating `electron-builder.yml`:

```yaml
mac:
  target: [dmg]
  category: public.app-category.developer-tools
  icon: resources/darwin/code.icns

  # Customize DMG appearance
  dmg:
    # Background image (optional - create a PNG image)
    background: resources/darwin/dmg-background.png

    # Window size and position
    window:
      width: 540
      height: 380
      x: 400
      y: 100

    # Icon size
    iconSize: 128

    # Text size
    textSize: 16

    # Contents arrangement
    contents:
      - x: 130
        y: 220
        type: file
      - x: 410
        y: 220
        type: link
        path: /Applications
```

### Advanced DMG Customization

For more advanced customization (custom background, better layout), you can:

1. **Create a background image:**

   - Create a PNG image (e.g., `resources/darwin/dmg-background.png`)
   - Recommended size: 540x380 pixels
   - Add your branding/logo

2. **Update electron-builder.yml** with the DMG configuration above

3. **Rebuild:**
   ```bash
   npm run dist:mac
   ```

## Method 2: Manual DMG Creation (Alternative)

If you need more control or want to create a DMG manually:

### Using hdiutil (Command Line)

1. **First, build your app using electron-builder (without DMG):**

   ```bash
   npm run pack:mac
   ```

   This creates the `.app` bundle in `release/mac/`

2. **Create a temporary folder:**

   ```bash
   mkdir -p /tmp/RenDMG
   cp -R release/mac/Ren.app /tmp/RenDMG/
   ```

3. **Create the DMG:**

   ```bash
   hdiutil create -volname "Ren IDE" \
     -srcfolder /tmp/RenDMG \
     -ov -format UDZO \
     release/Ren-$(node -p "require('./package.json').version")-$(uname -m).dmg
   ```

4. **Clean up:**
   ```bash
   rm -rf /tmp/RenDMG
   ```

### Using create-dmg (Third-party tool)

1. **Install create-dmg:**

   ```bash
   brew install create-dmg
   ```

2. **Create DMG with customizations:**
   ```bash
   create-dmg \
     --volname "Ren IDE" \
     --volicon "resources/darwin/code.icns" \
     --window-pos 200 120 \
     --window-size 540 380 \
     --icon-size 128 \
     --icon "Ren.app" 130 220 \
     --hide-extension "Ren.app" \
     --app-drop-link 410 220 \
     "release/Ren-$(node -p "require('./package.json').version")-$(uname -m).dmg" \
     "release/mac/Ren.app"
   ```

### Using Disk Utility (GUI)

1. Open **Disk Utility** (`/Applications/Utilities/Disk Utility.app`)

2. Go to **File > New Image > Image from Folder**

3. Select your `.app` bundle (e.g., `release/mac/Ren.app`)

4. Choose settings:

   - **Image Format:** Compressed
   - **Encryption:** None (unless needed)

5. Click **Save** and choose the destination

## Code Signing & Notarization

For distribution outside the App Store, you should:

1. **Code sign your app:**

   ```bash
   codesign --deep --force --verify --verbose \
     --sign "Developer ID Application: Your Name" \
     release/mac/Ren.app
   ```

2. **Notarize with Apple:**

   ```bash
   xcrun notarytool submit Ren.dmg \
     --apple-id "your@email.com" \
     --team-id "YOUR_TEAM_ID" \
     --password "app-specific-password" \
     --wait
   ```

3. **Staple the notarization:**
   ```bash
   xcrun stapler staple Ren.dmg
   ```

## Troubleshooting

### DMG won't open / "Unidentified Developer"

- This is normal for unsigned apps
- Right-click the DMG > Open > Click "Open" in the dialog
- Or: System Settings > Privacy & Security > Allow the app

### Build fails with "out/main.js not found"

- Run `npm run compile` first
- Ensure compilation completes successfully

### DMG is too large

- Check that `node_modules` are properly excluded
- Verify `asar: true` in electron-builder.yml (packages files)
- Remove unnecessary files from the build

## Best Practices

1. **Always test the DMG** on a clean macOS system before distribution
2. **Include a README** or license file in the DMG if needed
3. **Use version numbers** in the DMG filename (already configured)
4. **Test both Intel and Apple Silicon** builds if targeting both
5. **Consider code signing** for production releases

## Current Build Process

Your project includes an automated build script at `scripts/build_release.sh` that:

1. Cleans old builds
2. Installs dependencies
3. Rebuilds native modules
4. Compiles the source
5. Creates the DMG

Run it with:

```bash
./scripts/build_release.sh
```

## VS Code Official Build Method (For Reference)

The **official VS Code repository** uses a different approach:

1. **Build the app bundle using Gulp:**

   ```bash
   npm run gulp vscode-darwin-arm64-min
   # or
   npm run gulp vscode-darwin-x64-min
   ```

   This creates the `.app` bundle in `../VSCode-darwin-{arch}/`

2. **Create DMG manually** using `hdiutil` or `create-dmg`:
   ```bash
   # Using hdiutil (standard macOS tool)
   hdiutil create -volname "Ren IDE" \
     -srcfolder "../VSCode-darwin-arm64/Ren IDE.app" \
     -ov -format UDZO \
     "Ren-1.106.0-arm64.dmg"
   ```

**Why your fork uses electron-builder instead:**

- ✅ **Simpler**: One command (`npm run dist:mac`) does everything
- ✅ **Modern**: electron-builder is the industry standard for Electron apps
- ✅ **Automated**: Handles code signing, notarization, and DMG creation
- ✅ **Customizable**: Easy to configure via `electron-builder.yml`

**Both methods are valid!** electron-builder is actually more common in modern Electron projects.

## Resources

- [electron-builder Documentation](https://www.electron.build/)
- [Apple Code Signing Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [create-dmg GitHub](https://github.com/create-dmg/create-dmg)
- [VS Code Build Documentation](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
