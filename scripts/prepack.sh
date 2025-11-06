set -euo pipefail

mkdir -p resources/app
cp -f product.json resources/app/
cp -f package.json resources/app/
rsync -a --delete out/ resources/app/out/
if [ -d "extensions" ]; then
  mkdir -p resources/app/extensions
  rsync -a --delete extensions/ resources/app/extensions/
fi
if [ -d "resources/static" ]; then
  mkdir -p resources/app/static
  rsync -a --delete resources/static/ resources/app/static/
fi

# Create minimal nls.messages.json if it doesn't exist (prevents error when NLS messages file is missing)
# Create in both out/ (for development) and resources/app/out/ (for packaging)
if [ ! -f "out/nls.messages.json" ]; then
  echo '[]' > out/nls.messages.json
  echo "[prepack] Created minimal out/nls.messages.json"
fi
if [ ! -f "resources/app/out/nls.messages.json" ]; then
  echo '[]' > resources/app/out/nls.messages.json
  echo "[prepack] Created minimal resources/app/out/nls.messages.json"
fi

echo "[prepack] resources/app/ ready."
