# Cloudflare setup for PR/MR reviews

Read this only when `thurview publish-static --check --to cloudflare` fails.
Name the missing part (target file, Wrangler, login, account access or project)
and present the applicable numbered steps once. Keep all answers in
`$THURVIEW_HOME/cloudflare.json` (default `~/.thurview/cloudflare.json`).
Credentials stay in Wrangler's own login store or the operator's environment.
Never commit either file, print account details in a forge comment or ask the
user to paste a token into chat.

1. **Install the checked stable Wrangler.** Run `npm view wrangler version`
   first. At writing, npm reports `4.147.0`; the checked install command is
   `npm install -g wrangler@4.147.0`. If the registry reports a newer stable
   version, substitute that exact result and check its command help. Check
   `wrangler --version`; the snapshot CLI invokes that executable on PATH.
2. **Log in on the publishing host.** Run `wrangler login --device` in remote
   sessions. Open the verification URL on the user's device, enter its code
   and approve there. This avoids the unreachable localhost OAuth callback.
   Check `wrangler whoami --json`; keep the account information local. With
   multiple accounts, have the user choose one, then retain its id in the
   target file. An existing environment token is supported; do not create or
   store another credential. A failed login needs renewal, not new setup.
3. **Register the account's `workers.dev` subdomain.** Open the account from
   [the dashboard](https://dash.cloudflare.com/), then Workers & Pages. Use
   its subdomain settings; on a new account with only **Create application**,
   start a static application and complete the prompted subdomain choice.
   Let the user choose this account-wide public name. Use the dashboard menus
   rather than a constructed `/workers/onboarding` link. See
   [Cloudflare's subdomain guidance](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
4. **Create a dedicated static-assets Worker project.** The snapshot CLI
   uses Workers static assets through `wrangler deploy`, not a legacy Pages
   project. Agree on a project name and create it with a harmless static page
   outside the source repository, using the selected account. Run this block
   as a script after substituting the user's choices; keep its scratch
   directory under the publishing store and delete only that scratch.

   ```sh
   set -eu
   CF_HOME="${THURVIEW_HOME:-$HOME/.thurview}"
   CF_PROJECT='<chosen-project>'
   export CLOUDFLARE_ACCOUNT_ID='<chosen-account-id>'
   mkdir -p "$CF_HOME"
   CF_BOOTSTRAP="$(mktemp -d "$CF_HOME/bootstrap.XXXXXX")"
   trap 'rm -rf "$CF_BOOTSTRAP"' EXIT
   printf '<!doctype html><title>Review snapshots</title><p>Ready</p>\n' >"$CF_BOOTSTRAP/index.html"
   cd "$CF_BOOTSTRAP"
   wrangler deploy --name "$CF_PROJECT" --assets "$CF_BOOTSTRAP"
   wrangler deployments status --name "$CF_PROJECT" --json
   ```

   Record the actual HTTPS origin Wrangler returns, for example
   `https://thurview-reviews.thurbeen.workers.dev`. A missing subdomain must be
   fixed before retrying; do not rerun the same failed command. Starting from
   a static directory and using `--assets` avoids project auto-detection.
   Existing projects need no creation or bootstrap upload. The dedicated
   Worker must contain no other site's assets: later publishes replace its
   full asset set. See
   [static-assets deployment](https://developers.cloudflare.com/workers/static-assets/get-started/).

5. **Save the target and check it.** Write the user's values to that one JSON
   file, creating its parent directory if necessary. The shape is:

   ```json
   {
     "name": "<chosen-project>",
     "account_id": "<chosen-account-id>",
     "publicUrl": "https://<chosen-project>.<chosen-subdomain>.workers.dev",
     "allowLiveLink": false
   }
   ```

   These are placeholders, not usable account values. Keep the account id
   local; never put credentials in this file. Respect an already configured
   custom public origin rather than deriving a different one. Run
   `thurview publish-static --check --to cloudflare` again. It checks login
   and project access without deploying or needing a review. For an existing
   target, keep its publishing store and restore its retained archive if it
   was lost; do not initialize a replacement.

After authoring the **first** document for this new dedicated Worker, use
`thurview publish-static <id> --to cloudflare --initialize-archive` once.
Later publications omit `--initialize-archive`. The archive under
`$THURVIEW_HOME/static/` retains all documents' assets, so keep it backed up
and use one publishing store per Worker. A setup check proves remote login
and project access, not that an archive was restored or that a future upload
will succeed. Require a successful upload and both reachable links before
posting the review summary.

Reuse the saved values without another setup question. The public snapshot
is read only; comments go through the private live page. Do not put that
page's address in the public snapshot or forge summary. A private repository
needs existing authorization for public sharing, or an authorized protected
target; the existence of this target file alone does not grant it.
