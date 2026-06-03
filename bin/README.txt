Bundled command-line binaries
=============================

This folder holds the external tools that get packaged into the .app at build
time (electron-builder `extraResources`), so the shipped app is fully
self-contained — no Homebrew, no Terminal, no extra installs for end users.

Contents (NOT committed to git — too large; see .gitignore):
  ffmpeg, ffprobe   static arm64 builds (osxexperts.net), zero external deps
  tsMuxeR           + lib/libfreetype.6.dylib, libpng16.16.dylib
  mkvmerge          + lib/ (QtCore, ICU, glib, matroska/ebml, FLAC, ... )
  xorriso           links only /usr/lib (macOS built-ins)
  lib/              relocated Homebrew dylibs, loaded via @executable_path/lib/

All binaries are relocated to have ZERO /opt/homebrew references and are
ad-hoc code-signed (required on Apple Silicon after modification).

To (re)generate this folder on a build machine:
  brew install mkvtoolnix xorriso tsmuxer dylibbundler
  ./scripts/setup-binaries.sh

At runtime the app finds these via findTool() in src/main.js, which checks
<App>/Contents/Resources/bin first before falling back to the system PATH.
