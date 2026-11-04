# Google Cloud Storage

The provider section of the `thurview-publish` skill for a target with
`provider: gcp`. Every block runs inside the script `SKILL.md` describes,
after its variables block: `BUCKET`, `SIGNER`, `OBJECT`, `FILE` and
`EXPIRY_SECONDS` are set there.

## Upload and sign

```sh
gcloud storage cp "$FILE" "gs://$BUCKET/$OBJECT" \
  --content-type="text/html; charset=utf-8" --cache-control="no-cache"
```

Then sign it, for a private copy only:

```sh
gcloud storage sign-url "gs://$BUCKET/$OBJECT" --duration="${EXPIRY_SECONDS}s" \
  --impersonate-service-account="$SIGNER"
```

A user's own Google login cannot sign a URL; only a service account can. So
the link is signed by impersonating the `signer` service account through the
user's login, which needs no key file. Never fall back to
`--private-key-file` or an activated service-account key to get a longer
link: a key file is exactly the stored secret this skill does not use. That
is what caps a GCS link at 12 hours. Re-signing runs the `sign-url` command
alone.

## Unpublish

```sh
gcloud storage rm "gs://$BUCKET/$OBJECT"
```

On a versioned bucket the delete leaves the older versions behind, readable
by anyone with access to the bucket; say so when the bucket has versioning
on.

## Public copy, only on confirmation

Once the user has confirmed in the words `SKILL.md` gives, a bucket with
fine-grained access can make the one object readable, which needs **Storage
Object Admin** rather than Object User. A bucket with uniform access cannot
make one object public, only the whole bucket or a managed folder, so refuse
and say why. Neither works where public access prevention is enforced. Run
the upload above - not its signing - and then the grant, and run the grant
again after **every** update: an upload writes a new object generation with
the bucket's default ACL, which drops `allUsers`.

```sh
gcloud storage objects update "gs://$BUCKET/$OBJECT" \
  --add-acl-grant=entity=allUsers,role=READER
```

The link is `https://storage.googleapis.com/$BUCKET/$OBJECT`.

## Grant

**Storage Object User** (`roles/storage.objectUser`) on the bucket;
**Service Account Token Creator** on the `signer` service account, which
itself holds **Storage Object Viewer** on the bucket.
