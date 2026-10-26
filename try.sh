#!/usr/bin/env bash
# Start one spike: ./try.sh 07   (installs deps on first run)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
nn="${1:-}"
dir="$(ls -d "$here"/"$nn"-*/ 2>/dev/null | head -1 || true)"
if [[ -z "$nn" || -z "$dir" ]]; then
  echo "usage: ./try.sh <NN>   available:"; ls -d "$here"/0*/ | xargs -n1 basename | sed 's/^/  /'; exit 1
fi
cd "$dir"
[[ -d node_modules ]] || npm install
npx playwright install chromium >/dev/null 2>&1 || true
q=""; [[ "$nn" > "05" ]] && q="?user=Noah"
echo "→ $(basename "$dir") on http://127.0.0.1:51$nn/$q  (Ctrl+C to stop; see README.md for what to try)"
exec npm start
