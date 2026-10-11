import { db } from "../store/db.js";

export interface Pending {
  id: number;
  body: string;
  attempts: number;
  dueAt: number;
}

/** One row per event; the worker is the only reader. */
export async function enqueue(body: string): Promise<void> {
  await db.run("INSERT INTO outbox (body, attempts, due_at) VALUES (?, 0, ?)", body, Date.now());
}

/** The oldest due event, leased so a second worker cannot take it too. */
export async function lease(now: number): Promise<Pending | undefined> {
  return db.get(
    "UPDATE outbox SET due_at = ? WHERE id = (SELECT id FROM outbox WHERE due_at <= ? ORDER BY id LIMIT 1) RETURNING *",
    now + 30_000,
    now,
  );
}

export async function reschedule(id: number, attempts: number, dueAt: number): Promise<void> {
  await db.run("UPDATE outbox SET attempts = ?, due_at = ? WHERE id = ?", attempts, dueAt, id);
}

export async function done(id: number): Promise<void> {
  await db.run("DELETE FROM outbox WHERE id = ?", id);
}
