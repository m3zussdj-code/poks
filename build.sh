#!/usr/bin/env bash
# build.sh — składa src/ w jeden plik userscripta (dist/pokeglory-bot.user.js).
# Zero zależności: tylko cat + komentarz z nazwą pliku dla czytelności w DevTools.
set -euo pipefail
cd "$(dirname "$0")"

OUT="dist/pokeglory-bot.user.js"
mkdir -p dist

{
  # 1) nagłówek Tampermonkeya (src/meta.js) — MUSI być pierwszy liniami pliku
  cat src/meta.js
  echo

  # 2) cała logika w jednym IIFE — żadnych globali w oknie gry
  echo '(function () {'
  echo "'use strict';"
  for f in src/js/*.js; do
    echo
    echo "/* ===== ${f} ===== */"
    cat "$f"
  done
  echo
  echo '})();'
} > "$OUT"

# szybki sanity-check składni (node musi być dostępny)
if command -v node >/dev/null 2>&1; then
  node --check "$OUT"
fi

echo "OK → ${OUT} ($(wc -c < "$OUT") bajtów, $(wc -l < "$OUT") linii)"
