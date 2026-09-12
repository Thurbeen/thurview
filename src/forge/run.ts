import { AxiError } from "axi-sdk-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 8 MB: a busy change request's discussions exceed the 1 MB default. */
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface RunOptions {
  /** Sent on stdin, for the API calls whose payload is a JSON document. */
  input?: string;
  cwd?: string;
}

/**
 * Drive a forge CLI. A missing binary and a failed call both become an
 * AxiError naming the command, so the agent is told which tool to install or
 * authenticate rather than seeing a decoded empty answer.
 */
export async function run(cli: string, args: string[], opts: RunOptions = {}): Promise<string> {
  try {
    const child = execFileP(cli, args, { cwd: opts.cwd, maxBuffer: MAX_OUTPUT });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    }
    const { stdout } = await child;
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT")
      throw new AxiError(`${cli} is not on PATH`, "FORGE_ERROR", [
        `Install ${cli} and authenticate it, or pass --forge to name the other forge`,
      ]);
    const detail = (err.stderr || err.message || "").trim().split("\n").slice(0, 3).join("; ");
    throw new AxiError(`${cli} ${args[0] ?? ""} failed: ${detail}`, "FORGE_ERROR", [
      `Check \`${cli} auth status\``,
      "Check the change request number and that the account can read the repository",
    ]);
  }
}

export async function runJson<T>(cli: string, args: string[], opts: RunOptions = {}): Promise<T> {
  const out = await run(cli, args, opts);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new AxiError(`${cli} returned output that is not JSON`, "FORGE_ERROR", [
      `Run \`${cli} ${args.join(" ")}\` by hand to see what it answered`,
    ]);
  }
}

/** True when the CLI exists and exits 0 for `args`; used for host discovery. */
export async function ok(cli: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cli, args, { maxBuffer: MAX_OUTPUT });
    return true;
  } catch {
    return false;
  }
}
