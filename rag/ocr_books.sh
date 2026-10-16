#!/usr/bin/env bash
# OCR the scanned books listed in rag/books.json ("ocr": true), one text file per page:
#   knowledge/ocr/<id>/page-0001.txt ...
# Run from the repo root:  bash rag/ocr_books.sh [book-id ...]
# Needs poppler (pdfinfo, pdftoppm) and tesseract. On a Mac: brew install poppler tesseract
# Resumable: pages that already have a .txt are skipped, so it can be stopped and restarted.
# FORCE=1 re-OCRs pages that already have text (e.g. after changing a book's "ocr_source").
set -euo pipefail
JOBS="${JOBS:-4}"     # parallel pages
DPI="${DPI:-300}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ocr.XXXXXX")"   # page images live outside the repo
trap 'rm -rf "$TMP"' EXIT
trap 'exit 143' TERM INT   # still runs the EXIT cleanup when stopped
# One tesseract thread per page: several multi-threaded runs at once fight over the CPU
# (measured: ~2 min/page oversubscribed vs ~2 s/page single-threaded).
export OMP_THREAD_LIMIT=1

ocr_page() {  # pdf page outdir tmp dpi source
  local pdf="$1" n="$2" out="$3" tmp="$4" dpi="$5" source="${6:-render}" name img
  name=$(printf "page-%04d" "$n")
  # FORCE re-does a page unless its text is newer than the FORCE start marker (so a forced run can resume)
  if [ -s "$out/$name.txt" ]; then
    [ -z "${FORCE:-}" ] && return 0
    [ "$out/$name.txt" -nt "$out/.force-start" ] && return 0
  fi
  if [ "$source" = raw ]; then
    # Some scans are 8-bit JPEGs that the PDF mislabels as 1-bit; every renderer then draws
    # noise. Pull the embedded image out as-is and upscale it 2.5x (low-res scans OCR better).
    pdfimages -f "$n" -l "$n" -j "$pdf" "$tmp/$name" >/dev/null 2>&1
    img=$(ls -S "$tmp/$name"* 2>/dev/null | head -1)
    if [ -n "$img" ] && python3 -c "import PIL" 2>/dev/null; then
      python3 -c "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('L'); im.resize((im.width*5//2, im.height*5//2), Image.LANCZOS).save(sys.argv[2])" "$img" "$tmp/$name-up.png" && rm -f "$img" && img="$tmp/$name-up.png"
    fi
  else
    pdftoppm -f "$n" -l "$n" -r "$dpi" -gray -png "$pdf" "$tmp/$name" >/dev/null 2>&1
    img=$(ls "$tmp/$name"*.png 2>/dev/null | head -1)
  fi
  [ -n "$img" ] || { : > "$out/$name.txt"; return 0; }
  # Cap each page: notation-heavy pages can make tesseract grind for minutes. A capped page is
  # saved empty (and logged); it is almost always music the index would drop anyway.
  if ! $TIMEOUT tesseract "$img" "$out/$name.part" -l eng --psm 3 >/dev/null 2>&1; then
    : > "$out/$name.part.txt"; echo "  $(basename "$out") page $n: OCR skipped (timeout or error)" >&2
  fi
  mv "$out/$name.part.txt" "$out/$name.txt"
  rm -f "$tmp/$name"*
}
# GNU timeout is "timeout" on Linux and "gtimeout" on a Mac with coreutils; without either, no cap.
if command -v timeout >/dev/null; then TIMEOUT="timeout ${PAGE_TIMEOUT:-60}"
elif command -v gtimeout >/dev/null; then TIMEOUT="gtimeout ${PAGE_TIMEOUT:-60}"
else TIMEOUT=""; fi
export TIMEOUT
export -f ocr_page

python3 - "$ROOT/rag/books.json" "$@" > "$TMP/list" <<'PY'
import json, sys
want = set(sys.argv[2:])
for b in json.load(open(sys.argv[1])):
    if b.get("ocr") and (not want or b["id"] in want): print(b["id"] + "\t" + b["file"] + "\t" + b.get("ocr_source", "render"))
PY

while IFS=$'\t' read -r id file source; do
  pdf="$ROOT/reference/$file"
  out="$ROOT/knowledge/ocr/$id"; mkdir -p "$out"
  [ -n "${FORCE:-}" ] && [ ! -e "$out/.force-start" ] && touch "$out/.force-start"
  pages=$(pdfinfo "$pdf" 2>/dev/null | awk '/^Pages:/{print $2}')
  echo "$(date +%H:%M:%S) $id: $pages pages"
  seq 1 "$pages" | xargs -P "$JOBS" -I{} bash -c 'ocr_page "$@"' _ "$pdf" {} "$out" "$TMP" "$DPI" "$source"
  echo "$(date +%H:%M:%S) $id: done ($(ls "$out" | grep -c '^page-.*\.txt$') page files)"
done < "$TMP/list"
