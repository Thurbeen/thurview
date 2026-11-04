# AWS S3

The provider section of the `thurview-publish` skill for a target with
`provider: aws`. Every block runs inside the script `SKILL.md` describes,
after its variables block: `BUCKET`, `PROFILE`, `REGION`, `OBJECT`, `FILE`
and `EXPIRY_SECONDS` are set there.

## Upload and sign

```sh
aws s3 cp "$FILE" "s3://$BUCKET/$OBJECT" --profile "$PROFILE" --region "$REGION" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache"
aws s3 presign "s3://$BUCKET/$OBJECT" --profile "$PROFILE" --region "$REGION" \
  --expires-in "$EXPIRY_SECONDS"
```

Presigning is local: the link is signed with the profile's credentials and
works only while they do. With SSO or an assumed role those are temporary, so
the link dies with the session, often within hours, and nothing here can read
when that is without printing the credentials. So for such a profile, record
`expires` as "when the session ends, at the latest `EXPIRY_AT`", and tell the
user exactly that; a 7-day link needs a long-lived identity the user chooses
to use for it. Keep the bucket's Block Public Access on. Re-signing runs the
`presign` command alone.

## Unpublish

```sh
aws s3 rm "s3://$BUCKET/$OBJECT" --profile "$PROFILE" --region "$REGION"
```

On a versioned bucket the delete leaves the older versions behind, readable
by anyone with access to the bucket; say so when the bucket has versioning
on.

## Public copy

Do not open the bucket. Put CloudFront with Origin Access Control in front
of it instead, which the user sets up once in their own account; then the
link is the distribution's domain followed by `/$OBJECT`. Turning off Block
Public Access with `aws s3api put-public-access-block` exposes the whole
bucket and is not this skill's to do.

## Grant

`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/<prefix>/*`, and nothing on the bucket itself.
