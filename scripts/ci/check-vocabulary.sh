#!/usr/bin/env bash
#
# Fail when a tracked file names a caller's orchestrator, session tooling or
# organization-specific agents. The skills take explicit, generic inputs, so
# nothing shipped here should know who is calling.
#
# Usage: check-vocabulary.sh   (from anywhere in the repository)
set -euo pipefail

banned='fleet|thurbox|thurbeen|mission[ -]control'
own_address='thurbeen/thurview|owner = "thurbeen"'

cd "$(git rev-parse --show-toplevel)"

if matches=$(git grep -n -I -i -w -E "$banned" -- . \
    ':!pnpm-lock.yaml' \
    ':!scripts/ci/check-vocabulary.sh' \
    ':!scripts/ci/check-vocabulary.bats'); then
    :
else
    search_status=$?
    no_match_status=1
    [ "$search_status" -eq "$no_match_status" ] || exit "$search_status"
fi

hits=$(printf '%s\n' "$matches" | awk -v banned="$banned" -v own="$own_address" '
    {
        line = tolower($0)
        gsub(own, "", line)
        if (line ~ ("(^|[^[:alnum:]_])(" banned ")([^[:alnum:]_]|$)")) print
    }')

if [ -n "$hits" ]; then
    printf 'These lines name a caller; take a generic input instead:\n\n' >&2
    printf '%s\n' "$hits" >&2
    exit 1
fi

printf 'No caller-specific vocabulary in tracked files.\n'
