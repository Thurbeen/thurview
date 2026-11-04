---
name: thurview-publish
description: Publish, update, re-sign or take down a thurview review as one HTML page in the user's own Azure Storage, S3, Cloud Storage or Cloudflare Pages, through their own CLI login, behind a link that expires unless they confirm a public copy. Refuses a target whose allow_remotes or deny_remotes rule out the repository. Use to share, host or unpublish a review, or /thurview-publish. Not for authoring (thurview) or an opened PR/MR (thurview-pr-review).
user-invocable: true
argument-hint: "<review id> [--provider azure|aws|gcp|cloudflare] [--days N] [--public] [--resign | --unpublish]"
---

# thurview publish

For an opened PR/MR review, use `thurview-pr-review` as the single entrypoint.
It owns the durable Workers snapshot link in the managed
summary, with configuration in `cloudflare.json`. This skill is for separately
requested cloud copies of reviews; its multi-provider
`publish.yaml` targets are a different contract. Do not copy one configuration
into the other or send a PR review through both workflows.

Put a thurview document where someone without thurview can open it, in the
user's own cloud, and give them a link that stops working on its own.

```mermaid
flowchart LR
  S{repository's remotes vs the target's scope} -->|allowed, or the user said yes| A[thurview export]
  S -->|denied| X[refuse, and say why]
  A --> B[index.html]
  B --> C{provider}
  C -->|azure / aws / gcp| D[private object at prefix/slug/index.html]
  D --> E[signed link: 7 days at most, 12 hours on GCP]
  C -->|cloudflare| F[Pages branch named slug]
  F --> G[the alias wrangler prints]
  C -.->|only after 'This will be public' and a yes| H[public copy, noindex]
```

Four rules hold on every provider:

- **The user's own target, and only for code it is meant for.** A target
  belongs to its user, and some are personal only - never for work or
  company code. Before exporting anything, run the
  [scope check](#0-check-the-target-may-take-this-repository): refuse on a
  deny match, or on no allow match when the target has an allow list, and
  say which remote and pattern decided it. With no scope configured, ask the
  user whether this target is right for this repository, and wait for a yes.
- **The user's own login, never a secret.** Every command below runs as the
  identity the user's CLI is already [signed in](#signing-in) as. Never ask
  for, store, paste or pass an account key, connection string, secret access
  key, service-account key file or API token, and never set one in the
  environment yourself. If the CLI is not signed in, stop and tell the user
  which login command to run - do not work around it.
- **Ask before the first upload.** Name the target, its provider, the bucket
  or container, the object path, the expiry and whether the reader's threads
  go in, and wait for a yes. An update of a copy the user already published
  needs no second yes unless the target or the visibility changes.
- **Private, with a link that expires, by default.** The object stays private
  and the link you hand back is signed for `expiry_days` (default 7), clamped
  to the cloud's own limit: 7 days on Azure and AWS, 12 hours on GCP. A
  public copy is opt-in only: see
  [Public copies](#public-copies-only-on-confirmation).

The commands of each provider - upload and sign, unpublish, public copy, the
grant it needs - are in its own reference: [Azure Storage](references/azure.md),
[AWS S3](references/aws.md), [Google Cloud Storage](references/gcp.md),
[Cloudflare Pages](references/cloudflare.md). Read the one the target names,
not four.

## Signing in

Interactive login is the default: it is how a person publishes from their
own machine, and the CLI keeps the session in its own user config, not in
anything thurview or the repository holds. Environment credentials are only
for a non-interactive run - CI, a scheduled job - where whoever owns that
environment sets them; the skill never does.

| Provider   | Interactive, the default                                     | Non-interactive only                                                                                                             |
| ---------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Azure      | `az login`                                                   | `az login --identity` (a managed identity), or a federated service principal the pipeline signs in                               |
| AWS        | `aws sso login --profile <profile>`                          | the role the environment provides: an instance or task role, or web identity (`AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE`) |
| GCP        | `gcloud auth login`                                          | the attached service account, or workload identity federation (`gcloud auth login --cred-file=<config>`, no key)                 |
| Cloudflare | `wrangler login` (OAuth, kept in wrangler's own user config) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, set in that environment by its owner                                         |

## The config

The settings live in `${THURVIEW_HOME:-$HOME/.thurview}/publish.yaml`, the
user's own file beside thurview's review store - never in a repository, and
never in the exported page. Read it before anything else. When it is missing,
ask the user for their target and its scope, write it, and show it to them.

A user can have several targets - a personal one, a work one - each with its
own provider and its own scope. This one keeps a personal Cloudflare project
for the user's own repositories, never a company's, and a work Azure account
for the company's code only. A deny always wins over an allow:

```yaml
default: personal # the target used when the user names none
prefix: thurview # every copy goes under <prefix>/<slug>/index.html
expiry_days: 7 # whole days, 1 or more; clamped to 7 on Azure and AWS, 12 hours on GCP
targets:
  personal:
    provider: cloudflare
    project: my-reviews
    allow_remotes: # only my own repositories...
      - github.com/example-user/**
    deny_remotes: # ...and never the company's code, even under a name I own
      - gitlab.example.com/**
      - github.com/example-corp/**
  work:
    provider: azure
    account: examplecorpreviews
    container: reviews # a private container, not $web
    allow_remotes: # this account takes the company's code and nothing else
      - gitlab.example.com/**
  aws:
    provider: aws
    bucket: my-review-bucket
    profile: default # the AWS CLI profile or SSO session to use
    region: eu-west-1
  gcp:
    provider: gcp
    bucket: my-review-bucket
    signer: thurview-signer@my-project.iam.gserviceaccount.com # impersonated to sign, never a key file
published: {} # <review id>: { target, slug, public, url, expires }
```

A target names its `provider` and that provider's fields: `account` and
`container` for Azure, `bucket`, `profile` and `region` for AWS, `bucket` and
`signer` for GCP, `project` for Cloudflare. `allow_remotes` and
`deny_remotes` are globs over a remote's host and path, such as
`gitlab.example.com/team/**`: `*` stays inside one path segment, `**`
crosses them, and case does not matter. `published` is how a document keeps
one path: it maps each review id to the target and slug its copy lives
under. Write it after every upload, re-sign and unpublish, and update or
unpublish a copy only on the target it records.

Every block from step 1 on, and every block of a provider's reference, reads
the config through these shell variables. Run each operation - publish (steps
1 to 4), re-sign, unpublish - as **one** script file run with `bash`, never
typed into an interactive shell, that starts by setting them, so no block runs
in a shell where they are empty, and stops at the first command that fails:

```sh
set -euo pipefail
REVIEW="<review id>"
PROVIDER="<target.provider>" PREFIX="<prefix>" EXPIRY_DAYS="<expiry_days>"
SLUG="<published.<review id>.slug, or empty for a first upload>"
ACCOUNT="<target.account>" CONTAINER="<target.container>"
BUCKET="<target.bucket>" PROFILE="<target.profile>" REGION="<target.region>"
SIGNER="<target.signer>" PROJECT="<target.project>"
```

For a public Azure copy, `CONTAINER` is `'$web'` instead - see
[Public copies](#public-copies-only-on-confirmation).

## Workflow

### 0. Check the target may take this repository

Before exporting or uploading anything - and again before every update,
since a repository's remotes can change - hold the review's repository to
the target's scope. Run it **on its own, before the publish script**, not
inside it, so its answer decides whether that script runs at all. The
repository is the review's worktree: `thurview info --all --fields worktree`
lists it beside the review's id. The script sits in this skill's own
directory; pass one `--deny` per `deny_remotes` entry and one `--allow` per
`allow_remotes` entry of the chosen target:

```sh
node "<this skill's directory>/scripts/check-scope.mjs" --repo "<the review's worktree>" \
  --deny '<a deny_remotes entry>' --allow '<an allow_remotes entry>'
```

It checks every fetch and push URL of every remote, reduced to host and
path, and an ssh alias also by the host `ssh -G` says it names. It prints one
line per URL saying what decided it. Its exit code decides what happens
next:

| Exit | Meaning                                                                           | Do                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | allowed: no remote denied, and every one allowed when a list is set               | run the publish script                                                                                                                                                                 |
| 1    | refused: a remote is denied, or matches no allow pattern                          | stop. Tell the user the remote and the pattern it printed, and that this target is not for this repository. Do not offer a way round it; the user changes the config if it is wrong    |
| 2    | nothing to decide by: no scope set, no remote, no repository, a local-path remote | ask the user whether this target is right for this repository, naming its remotes; run the publish script only on a yes, and suggest adding a scope so the question does not come back |

A deny list only refuses the hosts and paths it names. For a personal target,
an `allow_remotes` list of the user's own namespaces is the stronger guard:
work code under a name nobody thought to deny is refused too.

### 1. Export the page

```sh
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
thurview export --review "$REVIEW" --out "$OUT" --no-threads
FILE="$OUT/index.html"
```

The page is the one the `thurview` skill's _Sharing a copy that needs no
server_ section describes: read only, self-contained, fetching nothing,
naming no server and no local path, and marked `noindex, nofollow`.
`--no-threads` keeps the reader's threads and decisions out, because a link
travels further than the conversation it was sent in. Drop it only when the
user asked for the threads in the copy. The trap deletes `$OUT` when the
script ends, whether the upload worked or not.

### 2. Find or mint the slug

`SLUG` is the one `published` recorded for this review, so the upload
overwrites the same object and the link the user already sent keeps pointing
at the current copy. A first upload mints one:

```sh
SLUG="${SLUG:-r$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')}"
OBJECT="${PREFIX:?set PREFIX from publish.yaml}/$SLUG/index.html"
```

`r` and 24 random hex characters: 96 bits, so a path cannot be guessed from
the review id, the title or another link, and short, lowercase and
alphanumeric, so Cloudflare Pages takes it unchanged as a branch alias.
Never derive the slug from the review id, a branch or the title. The prefix
is required: the grants in the references cover `<prefix>/*` and nothing
else.

### 3. Work out the expiry

```sh
case "${EXPIRY_DAYS:-7}" in
  "" | 0* | *[!0-9]*) echo "expiry_days must be a whole number of days, 1 or more" >&2 && exit 2 ;;
esac
MAX_SECONDS=604800
if [ "$PROVIDER" = gcp ]; then MAX_SECONDS=43200; fi
EXPIRY_SECONDS=$((${EXPIRY_DAYS:-7} * 86400))
if [ "$EXPIRY_SECONDS" -gt "$MAX_SECONDS" ]; then EXPIRY_SECONDS=$MAX_SECONDS; fi
EXPIRY_AT="$(node -e 'console.log(new Date(Date.now() + process.argv[1] * 1000).toISOString().slice(0, 16) + "Z")' "$EXPIRY_SECONDS")"
```

| Provider | Longest link                 | Why                                                                     |
| -------- | ---------------------------- | ----------------------------------------------------------------------- |
| Azure    | 7 days                       | a user-delegation key, which signs the SAS, lives 7 days at most        |
| AWS      | 7 days, or the session's end | SigV4 presigning stops at 604800 s, and at the signing credential's end |
| GCP      | 12 hours                     | a URL signed by impersonating a service account lives 12 hours at most  |

When the user asked for more, say it was clamped and to what. On GCP that is
every request over half a day: say so before the first upload, and point at
[re-signing](#re-signing-a-link) for a fresh link.

### 4. Upload and sign, per provider

Run the _Upload and sign_ section of the provider's reference -
[Azure Storage](references/azure.md), [AWS S3](references/aws.md),
[Google Cloud Storage](references/gcp.md) or
[Cloudflare Pages](references/cloudflare.md) - and nothing of the other
three, then go to step 5. Cloudflare Pages has no private copy and no
expiring link, so its reference starts with the confirmation a
[public copy](#public-copies-only-on-confirmation) needs.

### 5. Record it and hand it over

Write `published.<review id>` with the provider, slug, `public`, the link and
its expiry, then give the user the link and say when it stops working. Do
not print the link anywhere else: it is a bearer credential until it
expires.

## Re-signing a link

A link expired, or the user wants a fresh one. Nothing is uploaded: set the
variables, compute `OBJECT` (step 2, with the recorded slug) and the expiry
(step 3), and run only the signing command of the provider's _Upload and
sign_ section. Then record the new link and expiry. A link already sent keeps
working until its own expiry; the provider's reference says what, if
anything, can cut it short.

Cloudflare Pages links and public copies do not expire, so there is nothing
to re-sign.

## Unpublishing

Set the variables with the recorded slug, compute `OBJECT` (step 2), run the
provider's _Unpublish_ section, and remove the `published` entry only when it
succeeded: a copy whose record is gone can no longer be found to take down.
For a public Azure copy `CONTAINER` is `'$web'`, as it was when it was
uploaded. A signed link to a deleted object stops working at once; what a
delete leaves behind on each provider is in its reference.

## Public copies, only on confirmation

Only when the user asks for a public copy. Before anything, tell them, in
these words: **"This will be public: anyone with the link can read it, and it
cannot be made to expire."** Name what is in the page (the code it quotes,
and threads if they asked for them), and wait for an explicit yes. Record
`public: true`. The exported page is already `noindex, nofollow`; that keeps
it out of search results, not out of reach.

A copy keeps its visibility. To make a private copy public or the other way
round, [unpublish](#unpublishing) it, clear its slug, and publish afresh, so
no stale copy is left behind at the old path or the old visibility.

What a public copy takes, and the extra grant it needs, is the _Public copy_
section of the provider's reference. On AWS there is none: the bucket stays
closed and the user puts CloudFront in front of it.

## Setting up, once per provider

The smallest grant that runs this skill, which the user applies in their own
account, is the _Grant_ section of the provider's reference. A public copy
needs more, named in its _Public copy_ section.

### Smoke test

The user runs this with their own account before publishing a real document:
it uploads a one-line page under a fixed slug, prints a link, and deletes it.
Write it as a script file and run it with `bash`, never pasted into an
interactive shell, where `set -e` and `exit` would close the terminal. The
script is the variables block, then:

```sh
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
printf '<!doctype html><title>thurview smoke test</title><p>ok\n' >"$OUT/index.html"
FILE="$OUT/index.html"
SLUG=rsmoketest
OBJECT="${PREFIX:?}/$SLUG/index.html"
EXPIRY_DAYS=1
```

then step 3 and the provider's _Upload and sign_ section. Open the link it
prints and see `ok`. Then run a second script - the variables block with
`SLUG=rsmoketest`, step 2, then the provider's _Unpublish_ section - and open
the link again to see it refused. Each script's variables die with it, so a
real document published afterwards mints its own slug instead of landing at
the guessable `rsmoketest`. On Cloudflare, use a throwaway project, as its
reference says.
