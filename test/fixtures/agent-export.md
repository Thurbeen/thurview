# Export fixture

- Repository: fixture-repo
- Document: review
- Reviewed: branch feature
- Revision: 1
- Base: BASE_SHA
- Head: HEAD_SHA

## Verdict

Request changes (revision 1)

```text
Please address the open item.
```

## Reader feedback

### 1. Comment — open

Revision: 1
Thread: THREAD_ID
Target: review.md:3 (document block)
Anchor: src/auth.ts:3-5 at HEAD_SHA

Quoted text:

```text
Login checks the user.
```

Reviewer:

```text
Handle **empty** users.
Keep the error explicit.
```

### 2. Question — resolved

Revision: 1
Thread: THREAD_ID
Target: src/auth.ts:1-2 at BASE_SHA

Quoted text:

```text
export function login(user: string) {
  return check(user);
```

Reviewer:

```text
Why keep check?
```

Agent:

```text
It validates the user.
```

## What to do

- [ ] Address item 1 (thread THREAD_ID).
