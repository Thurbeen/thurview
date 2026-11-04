# Cloudflare Pages

The provider section of the `thurview-publish` skill for a target with
`provider: cloudflare`. Every block runs inside the script `SKILL.md`
describes, after its variables block: `PROJECT`, `SLUG` and `OUT` are set
there.

## Upload and sign: Cloudflare Pages, public unless behind Access

Pages serves every deployment publicly unless the project's preview
deployments sit behind Cloudflare Access, and it has no signed or expiring
link. So confirm with the user first, as `SKILL.md` says for any public copy,
unless they have told you the project's previews are behind Access.

wrangler is Cloudflare's own client for Pages' multi-step direct upload, run
through `npx` at a pinned version (4.147.0, the latest stable on npm when
this was written; check `npm view wrangler version` and use that). Run it
from `$OUT`, outside the user's repository, so it does not pick up a
`wrangler.toml` there, and come back before deleting `$OUT`.

```sh
export WRANGLER_SEND_METRICS=false
cd "${OUT:?}"
printf '/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  Cache-Control: no-cache\n' >_headers
if ! npx --yes wrangler@4.147.0 pages project list --json |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.exit(JSON.parse(s).some((p) => p["Project Name"] === process.argv[1]) ? 0 : 1))' "$PROJECT"; then
  npx --yes wrangler@4.147.0 pages project create "$PROJECT" --production-branch production
fi
npx --yes wrangler@4.147.0 pages deploy "$OUT" --project-name "$PROJECT" --branch "${SLUG:?}" --commit-dirty=true
cd - >/dev/null
```

- **The project must exist before `pages deploy`.** Run without a terminal,
  a deploy to a missing project fails, and wrangler can turn `pages deploy`
  into a Workers deploy when it detects an agent and the project is missing.
  So the block creates `$PROJECT` only when the list lacks it - name that in
  the question before the first upload, so the yes covers a new project too.
  Its production branch is one
  nothing is ever deployed to, so the bare project domain stays empty.
- **One preview branch per document.** The branch is the slug, and a
  redeploy to the same branch updates its alias in place. Hand over the
  **Deployment alias URL** wrangler prints, not the per-deployment
  `<hash>.` one, and never build it from the project name: when the name was
  taken, Pages gave the project a suffixed subdomain, which the list's
  `Project Domains` shows. `*.pages.dev` uses a wildcard certificate, so an
  alias never shows up in Certificate Transparency logs.
- Pages already sends `X-Robots-Tag: noindex` on preview deployments; the
  `_headers` file adds `nofollow`, `no-referrer` and `no-cache`, and keeps
  them should a deployment ever be promoted.
- There is no expiry to set, so `expires` stays empty, and there is nothing
  to re-sign.

## Unpublish

```sh
DEPLOYMENTS="$(npx --yes wrangler@4.147.0 pages deployment list --project-name "$PROJECT" --environment preview --json |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { for (const d of JSON.parse(s)) if (d.Branch === process.argv[1]) console.log(d.Id); })' "${SLUG:?}")"
if [ -z "$DEPLOYMENTS" ]; then echo "no deployment of $SLUG listed" >&2 && exit 3; fi
for DEPLOYMENT in $DEPLOYMENTS; do
  npx --yes wrangler@4.147.0 pages deployment delete "$DEPLOYMENT" --project-name "$PROJECT" --force
done
```

A failing list stops the script before anything is deleted or forgotten.
Exit 3 means the list worked but showed nothing on the slug's branch -
already deleted, or past the first page: open the alias, and remove the
entry only once it no longer answers. `--force` is what removes the
deployment the alias points at, and without it a run with no terminal
deletes nothing and says nothing. The list returns only the first page of
results, so on a busy project an older deployment of the slug can be missed:
tell the user to check the project's Deployments tab in the dashboard
afterwards.

## Public copy

The deployment above is already public; a public copy needs nothing more.

## Grant

`wrangler login` (OAuth, as the user). Or a custom API token with only
**Account › Cloudflare Pages › Edit** on the one account, which the user sets
as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in their own
environment.

To keep copies private, the user puts the project's previews behind
Cloudflare Access, once, in the dashboard: Workers & Pages › the project ›
Settings › General › **Access policy › Enable**, then **Manage** to edit the
policy to **Include › Emails** or **Emails ending in**. It defaults to
members of the Cloudflare account only. It covers preview deployments, not
the bare project domain or a custom domain, which is one more reason never to
deploy to production. Before relying on it, open an alias in a private window
and see the Access login. Access is free for up to 50 users.

For the smoke test, use a throwaway project, check `curl -sI` on the alias
shows `x-robots-tag: noindex, nofollow`, and finish with
`npx --yes wrangler@4.147.0 pages project delete <project>`.
