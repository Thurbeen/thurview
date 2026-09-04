#!/usr/bin/env bash
# Record media/thurview-demo.{mp4,gif}: the agent side in a terminal (VHS), then
# the reader side in the browser (headless Chromium screencast), joined by ffmpeg.
#
# Isolation: THURVIEW_HOME and the demo repository live in a throwaway directory,
# and the server runs on its own port, so nothing touches your reviews.
#
# Requirements: thurview on PATH (pnpm build && npm link), vhs (+ ttyd, ffmpeg),
# chromium, curl. Usage: scripts/demo/record.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${server_pid:-}" 2>/dev/null || true; rm -rf "$work"' EXIT
export THURVIEW_HOME="$work/home"
port=4799
repo="$work/session-service"

"$root/scripts/demo/make-repo.sh" "$repo"
cd "$repo"
uuid="$(thurview scaffold --title "Audit every login" | sed -n 's/^ *uuid: //p')"
[ -n "$uuid" ] || { echo "scaffold printed no uuid" >&2; exit 1; }
cp "$root/scripts/demo/review/review.md" "$root/scripts/demo/review/data.yaml" "$root/scripts/demo/review/map.yaml" "$THURVIEW_HOME/reviews/$uuid/"

thurview serve --port "$port" >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  sleep 0.2
done

# Agent side. The tape sources ask.sh (hidden) to file the reader's question
# through the API, the way the browser does, and keeps its id in TID.
cat >"$work/ask.sh" <<SH
TID=\$(curl -s -X POST -H 'content-type: application/json' \
  "http://127.0.0.1:$port/api/reviews/$uuid/threads" \
  -d '{"kind":"question","mode":"ask","target":{"type":"document","blockId":"summary","quote":"put a lid on it"},"body":"Was five chosen for a reason, or is it a placeholder?"}' \
  | sed 's/.*"id":"\([^"]*\)".*/\1/')
export TID
SH
sed -e "s|__DEMO_REPO__|$repo|g" -e "s|__HOME__|$THURVIEW_HOME|g" -e "s|__WORK__|$work|g" \
  "$root/scripts/demo/agent.tape.in" >"$work/agent.tape"
(cd "$work" && vhs agent.tape >"$work/vhs.log" 2>&1) || { tail -20 "$work/vhs.log" >&2; exit 1; }

# Reader side, on the revision the tape published.
node "$root/scripts/demo/record-browser.mjs" "http://127.0.0.1:$port/review/$uuid#/review" "$work/frames" 15
ffmpeg -loglevel error -y -framerate 15 -i "$work/frames/f%05d.jpg" -c:v libx264 -pix_fmt yuv420p -vf "scale=1280:800" "$work/reader.mp4"

# Join both halves.
ffmpeg -loglevel error -y -i "$work/agent.mp4" -vf "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2,fps=15" -c:v libx264 -pix_fmt yuv420p -an "$work/agent-n.mp4"
printf "file '%s'\nfile '%s'\n" "$work/agent-n.mp4" "$work/reader.mp4" >"$work/list.txt"
mkdir -p "$root/media"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$work/list.txt" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$root/media/thurview-demo.mp4"
ffmpeg -loglevel error -y -i "$root/media/thurview-demo.mp4" -vf "fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" "$root/media/thurview-demo.gif"
ls -la "$root/media"
