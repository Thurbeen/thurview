#!/usr/bin/env bash
# Record media/thurview-demo.{mp4,gif}: the reader side in the browser, captured
# from headless Chromium as a screencast and encoded by ffmpeg. The demo is of
# the interface, so the agent side — scaffold, publish, the reply to the
# reader's question — runs off camera, before the recording starts.
#
# Isolation: THURVIEW_HOME and the demo repository live in a throwaway directory,
# and the server runs on its own port, so nothing touches your reviews.
#
# Requirements: thurview on PATH (pnpm build && npm link), ffmpeg, chromium (or
# $CHROMIUM), curl. Usage: scripts/demo/record.sh
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
thurview publish --review "$uuid" >"$work/publish.log" 2>&1

thurview serve --port "$port" >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  sleep 0.2
done

# The exchange the threads panel shows as already answered: a question filed
# through the API the way the browser files one, and the agent's reply through
# the command the skill uses. Both off camera; the video picks up the state.
tid="$(curl -s -X POST -H 'content-type: application/json' \
  "http://127.0.0.1:$port/api/reviews/$uuid/threads" \
  -d '{"kind":"question","mode":"ask","target":{"type":"document","blockId":"summary","quote":"put a lid on it"},"body":"Was five chosen for a reason, or is it a placeholder?"}' |
  sed 's/.*"id":"\([^"]*\)".*/\1/')"
[ -n "$tid" ] || { echo "the API returned no thread id" >&2; exit 1; }
thurview threads reply "$tid" --review "$uuid" \
  --body "A placeholder: nothing in the request named a number. Five keeps a laptop, a phone and a tab or two." >/dev/null

# Reader side, on the revision that was published above.
node "$root/scripts/demo/record-browser.mjs" "http://127.0.0.1:$port/review/$uuid#/review" "$work/frames" 15 "$work/shots"
mkdir -p "$root/media"
ffmpeg -loglevel error -y -framerate 15 -i "$work/frames/f%05d.jpg" -c:v libx264 -pix_fmt yuv420p -vf "scale=1280:800" -movflags +faststart "$root/media/thurview-demo.mp4"
ffmpeg -loglevel error -y -i "$root/media/thurview-demo.mp4" -vf "fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" "$root/media/thurview-demo.gif"

# Stills of the review page, captured during the same run as the video.
for shot in review files map threads decision; do
  ffmpeg -loglevel error -y -i "$work/shots/$shot.png" -vf "scale=1100:-1:flags=lanczos" "$root/media/review-$shot.png"
done
ls -la "$root/media"
