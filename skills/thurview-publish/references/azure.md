# Azure Storage

The provider section of the `thurview-publish` skill for a target with
`provider: azure`. Every block runs inside the script `SKILL.md` describes,
after its variables block: `ACCOUNT`, `CONTAINER`, `OBJECT`, `FILE` and
`EXPIRY_AT` are set there.

## Upload and sign

```sh
az storage blob upload --auth-mode login --account-name "$ACCOUNT" \
  --container-name "$CONTAINER" --name "$OBJECT" --file "$FILE" --overwrite \
  --content-type "text/html; charset=utf-8" --content-cache-control "no-cache"
```

Then sign it - for a private copy only; a public one's link is the static
website's, and a SAS on it would be recorded as an expiring link that is not
the one the reader should get:

```sh
az storage blob generate-sas --auth-mode login --as-user \
  --account-name "$ACCOUNT" --container-name "$CONTAINER" --name "$OBJECT" \
  --permissions r --https-only --expiry "$EXPIRY_AT" --full-uri --output tsv
```

It prints the full link. `--as-user` makes it a
user-delegation SAS, signed by a key Entra ID issues to the user rather than
by the account key, so it is revocable and names who signed it. It also ends
when the delegation key does, which is at most 7 days. Re-signing runs this
command alone. Azure can cut a link short by revoking the user's delegation
keys (`az storage account revoke-delegation-keys`), which kills every
user-delegation SAS on the account.

## Unpublish

```sh
az storage blob delete --auth-mode login --account-name "$ACCOUNT" \
  --container-name "$CONTAINER" --name "$OBJECT"
```

For a public copy `CONTAINER` is `'$web'`, as it was when it was uploaded.

## Public copy, only on confirmation

The static website's `$web` container, once the user has confirmed in the
words `SKILL.md` gives. Enabling it changes the whole account and needs
**Storage Account Contributor**, so it is the user's call. Then run the
upload above - not its SAS - with the container set to `$web`, which needs
Storage Blob Data Contributor on `$web` as well:

```sh
az storage blob service-properties update --auth-mode login \
  --account-name "$ACCOUNT" --static-website --index-document index.html
CONTAINER='$web'
az storage account show --name "$ACCOUNT" --query primaryEndpoints.web --output tsv
```

The link is that endpoint followed by `$OBJECT`. Updates and unpublishing
use `'$web'` too.

## Grant

**Storage Blob Data Contributor** on the container; **Storage Blob
Delegator** on the storage account, since the user-delegation key is issued
at account scope.
