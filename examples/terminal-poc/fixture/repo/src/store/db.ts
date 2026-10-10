export interface Db {
  run(sql: string, ...args: unknown[]): Promise<void>;
  get<T>(sql: string, ...args: unknown[]): Promise<T | undefined>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id       INTEGER PRIMARY KEY,
  body     TEXT    NOT NULL,
  attempts INTEGER NOT NULL,
  due_at   INTEGER NOT NULL
);`;

export declare const db: Db;
