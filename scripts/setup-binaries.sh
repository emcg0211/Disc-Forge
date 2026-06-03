#!/usr/bin/env bash
#
# setup-binaries.sh — populate bin/ with fully self-contained (relocated) binaries
#
# The bundled binaries are NOT committed to git (too large — see .gitignore).
# Run this once on a build machine before `npm run build` to produce a bin/
# folder whose binaries have ZERO /opt/homebrew dependencies, so the shipped
# .app works on any Apple Silicon Mac with no Homebrew / no extra installs.
#
# Requirements (build machine only — NOT end users):
#   - Apple Silicon (arm64) macOS
#   - Homebrew with: mkvtoolnix, xorriso, tsmuxer, freetype, qtbase, dylibbundler
#       brew install mkvtoolnix xorriso tsmuxer dylibbundler
#   - curl, install_name_tool, codesign (Xcode command line tools)
#
# What it does:
#   1. Downloads static arm64 ffmpeg + ffprobe (no deps) from osxexperts.net
#   2. Copies tsMuxeR, mkvmerge, xorriso from Homebrew
#   3. Uses dylibbundler to copy every Homebrew dylib into bin/lib/ and rewrite
#      the load paths to @executable_path/lib/, then bundles QtCore.framework
#      (which dylibbundler skips) and its transitive deps by hand.
#   4. Ad-hoc re-signs everything (arm64 rejects modified-but-unsigned mach-o).
#   5. Verifies no /opt/homebrew references remain and each binary runs.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"
LIB="$BIN/lib"
mkdir -p "$LIB"

# Expected SHA256 of the unzipped arm64 binaries from osxexperts.net (ffmpeg 8.1)
FFMPEG_SHA="9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028"
FFPROBE_SHA="aab17ac7379c1178aaf400c3ef36cdb67db0b75b1a23eeef2cb9f658be8844e6"

echo "==> 1/5  Downloading static arm64 ffmpeg + ffprobe"
fetch_static() {  # $1=name $2=url $3=expected_sha
  local name="$1" url="$2" want="$3" tmp="/tmp/_dlbf_$1"
  curl -fsSL "$url" -o "$tmp.zip"
  rm -f "$tmp"; unzip -o -q "$tmp.zip" -d "/tmp/_dlbf_${1}_d"
  local got; got="$(shasum -a 256 "/tmp/_dlbf_${1}_d/$name" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    echo "ERROR: $name sha256 mismatch (got $got want $want)" >&2; exit 1
  fi
  cp "/tmp/_dlbf_${1}_d/$name" "$BIN/$name"
  case "$(file -b "$BIN/$name")" in *arm64*) ;; *) echo "ERROR: $name not arm64" >&2; exit 1;; esac
}
fetch_static ffmpeg  "https://www.osxexperts.net/ffmpeg81arm.zip"  "$FFMPEG_SHA"
fetch_static ffprobe "https://www.osxexperts.net/ffprobe81arm.zip" "$FFPROBE_SHA"

echo "==> 2/5  Copying tsMuxeR, mkvmerge, xorriso from Homebrew"
require_tool() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH (brew install it)" >&2; exit 1; }; }
require_tool tsMuxeR; require_tool mkvmerge; require_tool xorriso; require_tool dylibbundler
# rm -f first: copied-from-brew binaries can be read-only, blocking overwrite.
rm -f "$BIN/tsMuxeR" "$BIN/mkvmerge" "$BIN/xorriso"
cp "$(command -v tsMuxeR)"  "$BIN/tsMuxeR"
cp "$(command -v mkvmerge)" "$BIN/mkvmerge"
cp "$(command -v xorriso)"  "$BIN/xorriso"   # xorriso links only /usr/lib — nothing to relocate
chmod +w "$BIN/tsMuxeR" "$BIN/mkvmerge" "$BIN/xorriso"

echo "==> 3/5  Bundling dylibs (dylibbundler) for tsMuxeR + mkvmerge"
dylibbundler -of -b -x "$BIN/tsMuxeR" -x "$BIN/mkvmerge" -d "$LIB/" -p @executable_path/lib/ >/dev/null 2>&1

# mkvmerge links QtCore.framework, which dylibbundler does not handle. Stage it
# as a flat dylib and pull in its transitive deps with a second dylibbundler pass.
QT_FW="$(otool -L "$BIN/mkvmerge" | awk '/QtCore.framework/{print $1; exit}')"
if [ -n "${QT_FW:-}" ]; then
  echo "    staging QtCore from $QT_FW"
  cp "$QT_FW" "$LIB/QtCore"; chmod +w "$LIB/QtCore"
  install_name_tool -id @executable_path/lib/QtCore "$LIB/QtCore"
  install_name_tool -change "$QT_FW" @executable_path/lib/QtCore "$BIN/mkvmerge"
  dylibbundler -of -b -x "$LIB/QtCore" -x "$BIN/mkvmerge" -x "$BIN/tsMuxeR" \
               -d "$LIB/" -p @executable_path/lib/ >/dev/null 2>&1
  # dylibbundler appends an LC_RPATH each pass — drop the duplicate it just added.
  count_rpath() { otool -l "$1" | awk '/LC_RPATH/{f=1} f&&/path @executable_path\/lib\//{c++;f=0} END{print c+0}'; }
  while [ "$(count_rpath "$BIN/mkvmerge")" -gt 1 ]; do
    install_name_tool -delete_rpath '@executable_path/lib/' "$BIN/mkvmerge"
  done
fi

echo "==> 4/5  Ad-hoc re-signing all binaries + dylibs"
for f in "$BIN/ffmpeg" "$BIN/ffprobe" "$BIN/tsMuxeR" "$BIN/mkvmerge" "$BIN/xorriso" "$LIB"/*; do
  chmod 755 "$f"; codesign --force -s - "$f" >/dev/null 2>&1
done

echo "==> 5/5  Verifying (no /opt/homebrew refs, binaries run)"
fail=0
for f in "$BIN/ffmpeg" "$BIN/ffprobe" "$BIN/tsMuxeR" "$BIN/mkvmerge" "$BIN/xorriso" "$LIB"/*; do
  if otool -L "$f" | tail -n +2 | grep -qE '/opt/homebrew|/Cellar/'; then
    echo "  FAIL: $f still references Homebrew"; fail=1
  fi
  codesign -v "$f" 2>/dev/null || { echo "  FAIL: $f bad signature"; fail=1; }
done
( cd "$BIN" && PATH=/usr/bin:/bin ./ffmpeg  -version >/dev/null 2>&1 ) || { echo "  FAIL: ffmpeg won't run";  fail=1; }
( cd "$BIN" && PATH=/usr/bin:/bin ./mkvmerge --version >/dev/null 2>&1 ) || { echo "  FAIL: mkvmerge won't run"; fail=1; }
( cd "$BIN" && PATH=/usr/bin:/bin ./xorriso --version >/dev/null 2>&1 ) || { echo "  FAIL: xorriso won't run";  fail=1; }
if [ "$fail" = 0 ]; then
  echo "OK — bin/ is self-contained ($(du -sh "$BIN" | awk '{print $1}'))"
else
  echo "One or more checks failed." >&2; exit 1
fi
