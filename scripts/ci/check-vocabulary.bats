#!/usr/bin/env bats
#
# Drives check-vocabulary.sh: thurview and the skills it ships name no
# orchestrator, session tool or organization-specific agent of their callers.

setup() {
  CHECKER="${BATS_TEST_DIRNAME}/check-vocabulary.sh"

  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR \
    GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX \
    GIT_NAMESPACE

  REPO="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "$REPO/skills/s"
  cd "$REPO" || exit 1
  git init -q -b main .
  printf 'Review the PR.\n' >skills/s/SKILL.md
  git add -A
}

track() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
  git add "$1"
}

@test "accepts a repository that names no caller" {
  run "$CHECKER"
  [ "$status" -eq 0 ]
}

@test "rejects a Fleet command in a shipped skill" {
  track skills/s/SKILL.md 'Then run `fleet declare review --change-request URL`.'
  run "$CHECKER"
  [ "$status" -eq 1 ]
  [[ "$output" == *"skills/s/SKILL.md:1:"* ]]
}

@test "rejects a Fleet worker marker in source" {
  track src/post.ts 'const tail = "<!-- fleet:worker u1 -->";'
  run "$CHECKER"
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/post.ts:1:"* ]]
}

@test "rejects session tooling and organization agents in any case" {
  track .shellcheckrc '# ShellCheck configuration for Thurbox shell scripts.'
  track docs/a.md 'Runs as the thurbeen-agents App, routed by Mission Control.'
  run "$CHECKER"
  [ "$status" -eq 1 ]
  [[ "$output" == *".shellcheckrc:1:"* ]]
  [[ "$output" == *"docs/a.md:1:"* ]]
}

@test "accepts the repository's own address and owner" {
  track README.md 'npx skills@latest add https://github.com/Thurbeen/thurview'
  track cog.toml 'owner = "Thurbeen"'
  run "$CHECKER"
  [ "$status" -eq 0 ]
}

@test "still rejects a banned term beside the repository's own address" {
  track README.md 'See https://github.com/Thurbeen/thurview and the Thurbeen fleet.'
  run "$CHECKER"
  [ "$status" -eq 1 ]
}

@test "accepts generic words a caller's vocabulary shares" {
  track docs/a.md 'A brief summary; the worker pool; inbox zero; HTTP 502 Bad Gateway.'
  run "$CHECKER"
  [ "$status" -eq 0 ]
}

@test "ignores untracked files and the lockfile" {
  printf 'fleet\n' >scratch.md
  track pnpm-lock.yaml 'fleet-thing: 1.0.0'
  run "$CHECKER"
  [ "$status" -eq 0 ]
}
