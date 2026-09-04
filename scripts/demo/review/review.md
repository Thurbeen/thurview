# Audit every login and cap sessions per user

**Summary**

- every login attempt, denied or not, and every logout now append one line to `audit.log`
- a user with five open sessions is refused a sixth
- one new module, no change to the session file format

**Why**

Support could not tell whether a locked-out user had tried to log in at all, and nothing stopped a script from opening unlimited sessions. The request was "log every attempt, not only successes, and put a lid on it".

## Data flow

[login()](anchor:login) reads all sessions, refuses when the user is at the [cap](anchor:cap), otherwise saves and then records the event. The denied path records too.

```sequence
label: Login
messages:
  - { from: caller, to: auth, label: login(user), anchor: login }
  - { from: auth, to: store, label: loadSessions(), anchor: loadSessions }
  - { from: auth, to: audit, label: audit("login-denied") when at cap, anchor: auditDenied }
  - { from: auth, to: store, label: saveSessions(), anchor: saveSessions }
  - { from: auth, to: audit, label: audit("login"), anchor: auditLogin }
```

The audit write happens after the session is saved, so a crash between the two leaves a session without a trail. That ordering is a question for the reader, not a defect.

## Call stack

```callstack
title: login() at base and head
base: [login, loadSessions, saveSessions]
head:
  - login
  - loadSessions
  - saveSessions
  - { calls: [login, auditFn], reason: appends after the save }
```

## State

```database
title: Files on disk
stores: [sessions, auditLog]
usecases:
  - id: login
    label: Login
    summary: Whole-file read and write of sessions.json, then one append.
    ops:
      - { op: read, store: sessions.sessions, actor: auth, label: load all sessions, anchor: loadSessions }
      - { op: write, store: sessions.sessions, actor: auth, label: save with the new session, anchor: saveSessions }
      - { op: write, store: auditLog.events, actor: audit, label: append login event, anchor: appendLog }
  - id: logout
    label: Logout
    ops:
      - { op: read, store: sessions.sessions, actor: auth, label: find the session, anchor: logout }
      - { op: write, store: sessions.sessions.id, actor: auth, label: drop by id, anchor: saveSessions }
      - { op: write, store: auditLog.events.user, actor: audit, label: append logout with the user, anchor: appendLog }
```

## Testing evidence

No tests in the repository. The cap and the denied path were not exercised by a test in this change.

## Decision log {collapsed}

- "log every attempt, not only successes": the denied branch calls audit before throwing, see [audit login-denied](anchor:auditDenied).
- The cap is a constant, [MAX_SESSIONS](anchor:maxSessions), not configuration. Nothing in the request asked for a setting.

```peek
auditFn
```
