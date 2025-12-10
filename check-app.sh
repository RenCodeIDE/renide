#!/bin/bash

# Diagnostic script to check if Ren.app is properly packaged

APP="release/mac-arm64/Ren.app/Contents/Resources/app.asar"

if [ ! -f "$APP" ]; then
    echo "❌ Error: App not found at $APP"
    echo "   Make sure you've built the DMG first: npm run dist:mac"
    exit 1
fi

echo "🔍 Checking Ren.app package structure..."
echo ""

echo "1. Checking product.json..."
if npx asar list "$APP" 2>/dev/null | grep -q "^/product.json$"; then
    echo "   ✅ product.json found at root"
else
    echo "   ❌ product.json MISSING at root (CRITICAL!)"
fi

echo ""
echo "2. Checking main entry point..."
if npx asar list "$APP" 2>/dev/null | grep -q "^/out/main.js$"; then
    echo "   ✅ out/main.js found"
else
    echo "   ❌ out/main.js MISSING (CRITICAL!)"
fi

echo ""
echo "3. Checking workbench files..."
if npx asar list "$APP" 2>/dev/null | grep -q "workbench.html"; then
    echo "   ✅ workbench.html found"
    npx asar list "$APP" 2>/dev/null | grep "workbench.html" | head -2
else
    echo "   ❌ workbench.html MISSING (CRITICAL!)"
fi

if npx asar list "$APP" 2>/dev/null | grep -q "workbench.js"; then
    echo "   ✅ workbench.js found"
else
    echo "   ❌ workbench.js MISSING (CRITICAL!)"
fi

echo ""
echo "4. Checking resources directory..."
if npx asar list "$APP" 2>/dev/null | grep -q "^/resources/"; then
    echo "   ✅ resources/ directory found"
    RES_COUNT=$(npx asar list "$APP" 2>/dev/null | grep "^/resources/" | wc -l)
    echo "   Found $RES_COUNT resource files"
else
    echo "   ❌ resources/ directory MISSING"
fi

echo ""
echo "5. Checking extensions..."
if npx asar list "$APP" 2>/dev/null | grep -q "^/extensions/"; then
    echo "   ✅ extensions/ directory found"
    EXT_COUNT=$(npx asar list "$APP" 2>/dev/null | grep "^/extensions/" | wc -l)
    echo "   Found $EXT_COUNT extension files"
else
    echo "   ❌ extensions/ directory MISSING"
fi

echo ""
echo "6. Checking bootstrap files..."
BOOTSTRAP_FILES=("bootstrap-esm.js" "bootstrap-node.js" "bootstrap-fork.js")
for file in "${BOOTSTRAP_FILES[@]}"; do
    if npx asar list "$APP" 2>/dev/null | grep -q "$file"; then
        echo "   ✅ $file found"
    else
        echo "   ⚠️  $file not found (may be OK)"
    fi
done

echo ""
echo "7. Checking package.json..."
if npx asar list "$APP" 2>/dev/null | grep -q "^/package.json$"; then
    echo "   ✅ package.json found at root"
else
    echo "   ❌ package.json MISSING at root"
fi

echo ""
echo "8. Checking NLS files..."
if npx asar list "$APP" 2>/dev/null | grep -q "nls.messages.json"; then
    echo "   ✅ nls.messages.json found"
else
    echo "   ⚠️  nls.messages.json not found (may cause issues)"
fi

echo ""
echo "9. Checking native modules (unpacked)..."
if [ -d "release/mac-arm64/Ren.app/Contents/Resources/app.asar.unpacked" ]; then
    UNPACKED_COUNT=$(find release/mac-arm64/Ren.app/Contents/Resources/app.asar.unpacked -name "*.node" 2>/dev/null | wc -l)
    echo "   ✅ app.asar.unpacked directory exists"
    echo "   Found $UNPACKED_COUNT .node files"
else
    echo "   ⚠️  app.asar.unpacked directory missing (may be OK if no native modules)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "If you see ❌ for any CRITICAL items above, that's likely the problem."
echo ""
echo "Next steps:"
echo "1. Run the app from terminal to see errors:"
echo "   /Applications/Ren.app/Contents/MacOS/Ren --verbose"
echo ""
echo "2. Check Console.app for system errors"
echo ""
echo "3. If critical files are missing, rebuild:"
echo "   npm run compile"
echo "   npm run dist:mac"
echo ""

