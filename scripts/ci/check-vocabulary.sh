#!/usr/bin/env bash
#
# Fail when a tracked file names a caller's orchestrator, session tooling or
# organization-specific agents. The skills take explicit, generic inputs, so
# nothing shipped here should know who is calling.
#
# Usage: check-vocabulary.sh   (run from the repository root)
set -euo pipefail

banned='fleet|thurbox|thurbeen|mission[ -]control'
own_address='Thurbeen/thurview|owner = "Thurbeen"'

if matches=$(git grep -n -I -i -E "$banned" -- . \
    ':!pnpm-lock.yaml' \
    ':!scripts/ci/check-vocabulary.sh' \
    ':!scripts/ci/check-vocabulary.bats'); then
    :
else
    search_status=$?
    no_match_status=1
    [ "$search_status" -eq "$no_match_status" ] || exit "$search_status"
fi

hits=$(printf '%s\n' "$matches" |
    sed -E "s#${own_address}##g" |
    grep -i -E "$banned" || true)

if [ -n "$hits" ]; then
    printf 'These lines name a caller; take a generic input instead:\n\n' >&2
    printf '%s\n' "$hits" >&2
    exit 1
fi

printf 'No caller-specific vocabulary in tracked files.\n'
