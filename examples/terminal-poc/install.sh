#!/usr/bin/env sh
# Install the terminal proof of concept into a thurbox interface directory.
#
#   install.sh <interface dir> <model.lua>
#
# Copies the pane and its modules beside the interface's own files, and the
# model projected from a sealed revision (project.ts) next to them. It writes
# nothing else: the pane takes the `center` switch slot, so layout.lua needs no
# edit, and the action band offers it as a pill.
#
# Point it at an ISOLATED interface (THURBOX_CONFIG_DIR, or THURBOX_UI_DIR), not
# at the one your everyday thurbox reads: demo.sh shows the whole sandbox.
set -eu

ui="${1:?usage: install.sh <interface dir> <model.lua>}"
model="${2:?usage: install.sh <interface dir> <model.lua>}"
here="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$ui/layout.lua" ]; then
    echo "install.sh: $ui has no layout.lua; run that thurbox once so it delivers its interface" >&2
    exit 1
fi
mkdir -p "$ui/plugins" "$ui/thurview_poc"
cp "$here/ui/plugins/85_thurview_poc.lua" "$ui/plugins/"
cp "$here/ui/thurview_poc/view.lua" "$here/ui/thurview_poc/diagram.lua" "$ui/thurview_poc/"
cp "$model" "$ui/thurview_poc/model.lua"
echo "installed into $ui"
