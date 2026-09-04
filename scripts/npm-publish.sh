#!/usr/bin/env bash
#
# Publish the current commit to npm as the version of its latest tag.
#
# Releases tag without committing a version bump (main takes changes through
# pull requests only), so package.json in the tree keeps its last committed
# number while the tags move ahead. CI reconciles the two with `npm version`
# before it builds; this script does the same for a publish run by hand, which
# is needed once to claim the name before trusted publishing can be configured.
#
# The working tree must be clean, and HEAD must carry the tag being published.
# package.json is restored afterwards, so the tree is left as it was found.
#
# Usage: scripts/npm-publish.sh [--otp <code>] [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

otp=""
dry=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --otp) otp="${2:?--otp needs a code}"; shift 2 ;;
        --otp=*) otp="${1#*=}"; shift ;;
        --dry-run) dry="--dry-run"; shift ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ -n "$(git status --porcelain)" ]; then
    printf 'The working tree has changes; publish from a clean checkout.\n' >&2
    exit 1
fi

tag="$(git describe --tags --exact-match 2>/dev/null || true)"
if [ -z "$tag" ]; then
    printf 'HEAD carries no tag. Publish the commit a release tagged:\n' >&2
    printf '  git checkout %s\n' "$(git describe --tags --abbrev=0 2>/dev/null || echo '<tag>')" >&2
    exit 1
fi
version="${tag#v}"

restore() { git checkout -- package.json 2>/dev/null || true; }
trap restore EXIT

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null
printf 'publishing thurview@%s from %s\n' "$version" "$tag"
# shellcheck disable=SC2086 # $dry and the otp flag are deliberately word-split
npm publish $dry ${otp:+--otp "$otp"}
