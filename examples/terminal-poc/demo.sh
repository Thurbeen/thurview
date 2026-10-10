#!/usr/bin/env bash
# Run the terminal proof of concept in a thurbox that shares nothing with yours.
#
#   examples/terminal-poc/demo.sh            build, install, launch
#   examples/terminal-poc/demo.sh --setup    build and install, do not launch
#   examples/terminal-poc/demo.sh --seed     also ask one question and answer it as
#                                            the agent would, so a thread shows
#   examples/terminal-poc/demo.sh clean      stop the sandbox and delete it
#
# Everything lives under $THURVIEW_POC_ROOT (default ~/.cache/tvpoc):
# a scratch git repository holding the fixture's code, a THURVIEW_HOME the
# fixture design is published into, and a thurbox profile of its own - HOME,
# THURBOX_CONFIG_DIR, THURBOX_DATA_DIR, its own session socket and its own
# TMUX_TMPDIR. Your thurbox, its interface, sessions and grants, and any running
# thurview server are never read or written.
#
# THURVIEW_POC_REVISION=<a revision directory> projects that sealed revision
# instead of the fixture - `~/.thurview/reviews/<id>/revisions/<n>`, say. It is
# only read.
#
# Needs: node and this checkout's dependencies (pnpm install), git, tmux,
# thurbox and thurbox-cli on PATH. Commenting needs the `run` grant, which only
# you can give: Ctrl+, then ] in the sandboxed thurbox, select thurview, press t.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
# Short on purpose: thurbox puts a control socket under its data directory, and
# a socket path is capped near 104 bytes.
root="${THURVIEW_POC_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/tvpoc}"
socket="thurview-poc-demo"

sandbox_env() {
    # Drop whatever a surrounding thurbox session exported, so nothing here
    # reaches its server or its database.
    local name
    for name in $(env | sed -n 's/^\(THURBOX_[A-Z_]*\)=.*/\1/p; s/^\(TMUX[A-Z_]*\)=.*/\1/p'); do
        unset "$name"
    done
    export HOME="$root/home"
    export THURBOX_CONFIG_DIR="$root/cfg"
    export THURBOX_DATA_DIR="$root/data"
    export THURBOX_SOCKET="$socket"
    export TMUX_TMPDIR="$root/tmux"
    mkdir -p "$HOME" "$TMUX_TMPDIR"
}

if [[ "${1:-}" == "clean" ]]; then
    (
        sandbox_env
        tmux -L "$socket" kill-server 2>/dev/null || true
        tmux -L deliver kill-server 2>/dev/null || true
    )
    rm -rf "$root"
    echo "removed $root"
    exit 0
fi

tsx() {
    node "$repo_root/node_modules/tsx/dist/cli.mjs" "$@"
}
thurview() {
    tsx "$repo_root/src/main.ts" "$@"
}

mkdir -p "$root"
model="$root/model.lua"
# The pane writes through bridge.mjs, which imports thurview's built modules.
"$repo_root/node_modules/.bin/tsc" -p "$repo_root/tsconfig.json"

if [[ -n "${THURVIEW_POC_REVISION:-}" ]]; then
    revision="$THURVIEW_POC_REVISION"
else
    # The fixture: its code committed in a scratch repository, its design
    # published there by thurview itself, exactly as an agent would.
    scratch="$root/relay"
    export THURVIEW_HOME="$root/thurview-home"
    if [[ ! -d "$scratch/.git" ]]; then
        cp -r "$here/fixture/repo" "$scratch"
        git -C "$scratch" init -q -b main
        git -C "$scratch" add .
        git -C "$scratch" -c user.name=demo -c user.email=demo@example.invalid commit -q -m relay
    fi
    if [[ ! -f "$root/design-dir" ]]; then
        (
            cd "$scratch"
            dir="$(thurview design --title relay | sed -n 's/^  dir: //p')"
            if [[ -z "$dir" ]]; then
                echo "demo.sh: thurview design printed no dir:" >&2
                exit 1
            fi
            cp "$here/fixture/doc/review.md" "$here/fixture/doc/data.yaml" "$here/fixture/doc/map.yaml" "$dir/"
            thurview publish >/dev/null
            echo "$dir" >"$root/design-dir"
        )
    fi
    revision="$(find "$(cat "$root/design-dir")/revisions" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
    review="$(basename "$(cat "$root/design-dir")")"
    if [[ " $* " == *" --seed "* ]] && ! grep -q '"threads": *\[ *{' "$(cat "$root/design-dir")/threads.json" 2>/dev/null; then
        # The reader asks through the bridge, the agent answers through the CLI:
        # the same two paths a real review takes.
        block="$(node -e 'const d=require(process.argv[1]); console.log(d.blocks.find((b)=>b.type==="heading"&&b.text==="How a delivery works today").id)' "$revision/document.json")"
        hex() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
        asked="$(node "$here/bridge.mjs" create "$review" document "$(hex "$block")" ask "$(hex "Does the lease survive a worker restart?")")"
        thread="$(printf '%s\n' "$asked" | awk -F'\t' '$1=="T"{print $2; exit}')"
        (cd "$scratch" && thurview threads reply "$thread" --review "$review" --body "Yes: the row keeps its due_at, so another worker takes it after thirty seconds." >/dev/null)
    fi
fi
tsx "$here/project.ts" "$revision" "$model"
echo "projected $revision"

(
    sandbox_env
    ui="$THURBOX_CONFIG_DIR/ui"
    if [[ ! -f "$ui/layout.lua" ]]; then
        # thurbox delivers its interface on its first run, which needs a terminal:
        # one detached tmux window, gone once the files are there.
        tmux -L deliver -f /dev/null new-session -d -s deliver -x 160 -y 45 thurbox
        for _ in $(seq 1 100); do
            [[ -f "$ui/layout.lua" ]] && break
            sleep 0.1
        done
        tmux -L deliver kill-server 2>/dev/null || true
    fi
    "$here/install.sh" "$ui" "$model"
    thurbox-cli plugin check --text
)

if [[ " $* " == *" --setup "* ]]; then
    exit 0
fi

echo "launching the sandboxed thurbox: F3 opens the document, F1 lists its keys, Ctrl+Q quits"
sandbox_env
exec thurbox
