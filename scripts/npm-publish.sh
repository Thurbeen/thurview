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
# A one-time password is only valid for about half a minute, so `--skip-build`
# exists to move the slow part before the code is typed: build first, then
# publish immediately.
#
# Usage: scripts/npm-publish.sh [--otp <code>] [--dry-run] [--skip-build]
set -euo pipefail
cd "$(dirname "$0")/.."

otp=""
dry=""
build=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --otp) otp="${2:?--otp needs a code}"; shift 2 ;;
        --otp=*) otp="${1#*=}"; shift ;;
        --dry-run) dry="--dry-run"; shift ;;
        --skip-build) build=0; shift ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

if [ -n "$(git status --porcelain)" ]; then
    printf 'The working tree has changes; publish from a clean checkout.\n' >&2
    exit 1
fi

# Publish the latest tag's version. HEAD need not carry the tag itself: a
# commit that touches only CI, docs or these scripts cuts no release, so main
# routinely sits ahead of the tag with identical shipped content. What must
# hold is that nothing shipped changed since it - the same paths the release
# workflow gates on - because then a release is due and publishing this tree
# under the old number would ship something the tag never contained.
tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -z "$tag" ]; then
    printf 'No tag to publish. Land a change that cuts a release first.\n' >&2
    exit 1
fi
changed="$(git diff --name-only "$tag" HEAD -- src bin skills package.json pnpm-lock.yaml)"
if [ -n "$changed" ]; then
    printf 'Shipped files changed since %s, so a release is due:\n%s\n' "$tag" "$changed" >&2
    printf 'Push to main and publish the tag that follows.\n' >&2
    exit 1
fi
version="${tag#v}"

restore() { git checkout -- package.json 2>/dev/null || true; }
trap restore EXIT

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
if [ "$build" -eq 1 ]; then
    pnpm install --frozen-lockfile >/dev/null
    pnpm build >/dev/null
elif [ ! -f dist/cli.js ] || [ ! -f dist/ui/app.js ]; then
    printf 'dist/ is missing or incomplete: run pnpm build, or drop --skip-build.\n' >&2
    exit 1
fi
printf 'publishing thurview@%s from %s\n' "$version" "$tag"
# shellcheck disable=SC2086 # $dry and the otp flag are deliberately word-split
npm publish $dry ${otp:+--otp "$otp"}
