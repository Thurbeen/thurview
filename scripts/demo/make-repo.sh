#!/usr/bin/env bash
# Build the small git repository the demo reviews: a session service on main and
# an `audit-logins` branch that adds an audit trail and a per-user session cap.
# Usage: make-repo.sh <dir>
set -euo pipefail
dir="$1"
rm -rf "$dir"
mkdir -p "$dir/src"
cd "$dir"
git init -q -b main
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
cat >src/store.ts <<'TS'
import { readFile, writeFile } from "node:fs/promises";

export interface Session {
  id: string;
  user: string;
  createdAt: string;
}

export async function loadSessions(path: string): Promise<Session[]> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as Session[];
}

export async function saveSessions(path: string, sessions: Session[]): Promise<void> {
  await writeFile(path, JSON.stringify(sessions, null, 2));
}
TS
cat >src/auth.ts <<'TS'
import { loadSessions, saveSessions, type Session } from "./store";

const FILE = "sessions.json";

export async function login(user: string): Promise<Session> {
  const sessions = await loadSessions(FILE);
  const session: Session = { id: String(Date.now()), user, createdAt: new Date().toISOString() };
  sessions.push(session);
  await saveSessions(FILE, sessions);
  return session;
}

export async function logout(id: string): Promise<void> {
  const sessions = await loadSessions(FILE);
  await saveSessions(FILE, sessions.filter((s) => s.id !== id));
}
TS
printf '# session service\n\nLogin and logout, sessions in a JSON file.\n' >README.md
git add . && git commit -q -m "feat: session service"
git checkout -q -b audit-logins
cat >src/audit.ts <<'TS'
import { appendFile } from "node:fs/promises";

export type AuditEvent = "login" | "login-denied" | "logout";

export async function audit(event: AuditEvent, user: string): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), event, user });
  await appendFile("audit.log", line + "\n");
}
TS
cat >src/auth.ts <<'TS'
import { loadSessions, saveSessions, type Session } from "./store";
import { audit } from "./audit";

const FILE = "sessions.json";
const MAX_SESSIONS = 5;

export async function login(user: string): Promise<Session> {
  const sessions = await loadSessions(FILE);
  if (sessions.filter((s) => s.user === user).length >= MAX_SESSIONS) {
    await audit("login-denied", user);
    throw new Error(`too many sessions for ${user}`);
  }
  const session: Session = { id: String(Date.now()), user, createdAt: new Date().toISOString() };
  sessions.push(session);
  await saveSessions(FILE, sessions);
  await audit("login", user);
  return session;
}

export async function logout(id: string): Promise<void> {
  const sessions = await loadSessions(FILE);
  const gone = sessions.find((s) => s.id === id);
  await saveSessions(FILE, sessions.filter((s) => s.id !== id));
  if (gone) await audit("logout", gone.user);
}
TS
git add . && git commit -q -m "feat: audit logins and cap sessions per user"
