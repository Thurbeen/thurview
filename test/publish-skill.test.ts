// The thurview-publish skill is a recipe the agent runs against the user's own
// cloud account, so its commands are the contract. Nothing here calls a cloud:
// it checks that every block parses, that every cloud command takes the user's
// own login and never a stored secret, that uploads are typed and uncached,
// that links expire within each provider's limit, and that whatever makes a
// copy public sits behind the confirmation step.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const SKILL = join(ROOT, "skills", "thurview-publish", "SKILL.md");
const source = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "";

interface Block {
  lang: string;
  body: string;
  heading: string;
  /** The prose between the heading and the block. */
  preface: string;
}

/** Every fenced block, with the nearest heading above it. */
function blocks(): Block[] {
  const out: Block[] = [];
  let heading = "";
  let preface = "";
  let open: Block | null = null;
  // a block nested in a list item is indented; its fence is still a fence
  for (const raw of source.split("\n")) {
    const line = raw.trimStart();
    if (open) {
      if (line.startsWith("```")) {
        out.push(open);
        open = null;
        preface = "";
      } else open.body += `${raw}\n`;
    } else if (line.startsWith("```"))
      open = { lang: line.slice(3).trim(), body: "", heading, preface };
    else if (/^#{2,4} /.test(line)) {
      heading = line.replace(/^#+ /, "");
      preface = "";
    } else preface += `${raw}\n`;
  }
  return out;
}

const sh = () => blocks().filter((b) => b.lang === "sh");

/** Each command line of the sh blocks, `\` continuations joined. */
function commands(): { line: string; heading: string }[] {
  return sh().flatMap((b) =>
    b.body
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((line) => ({ line: line.trim(), heading: b.heading }))
      .filter((c) => c.line && !c.line.startsWith("#")),
  );
}

const commandsWithPreface = () =>
  sh().flatMap((b) =>
    b.body
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((line) => ({ line: line.trim(), preface: b.preface })),
  );

const cloud = (prefix: RegExp) => commands().filter((c) => prefix.test(c.line));

function run(script: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-euc", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

describe("thurview-publish skill", () => {
  it("ships the skill, covering the four providers", () => {
    expect(existsSync(SKILL)).toBe(true);
    for (const provider of ["Azure", "S3", "Cloud Storage", "Cloudflare Pages"])
      expect(source).toContain(provider);
  });

  it("is reached from the review skill's section on sharing a copy", () => {
    const thurview = readFileSync(join(ROOT, "skills", "thurview", "SKILL.md"), "utf8");
    expect(thurview).toContain("thurview-publish");
  });

  it.each(sh().map((b, i) => [i, b] as const))("sh block %i parses", (_, b) => {
    expect(() => execFileSync("bash", ["-n"], { input: b.body })).not.toThrow();
  });

  it("drives every provider through the user's own CLI", () => {
    for (const cli of [/^az storage /, /^aws s3 /, /^gcloud storage /, /^npx --yes wrangler@\d/])
      expect(cloud(cli).length, String(cli)).toBeGreaterThan(0);
  });

  // A version written in prose is one Renovate cannot see, so every call names
  // the same one and a bump is a single search and replace.
  it("runs one pinned wrangler everywhere", () => {
    const versions = new Set(
      [...source.matchAll(/wrangler@(\S+)/g)].map((m) => m[1]!.replace(/[`.,]+$/, "")),
    );
    expect([...versions]).toHaveLength(1);
    expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("never hands a cloud a stored secret, only the user's login", () => {
    const secrets =
      /--account-key|--connection-string|--sas-token|--private-key-file|aws configure set|AWS_SECRET_ACCESS_KEY=|CLOUDFLARE_API_TOKEN=|AZURE_STORAGE_KEY=/;
    for (const c of commands()) expect(c.line, c.line).not.toMatch(secrets);
    for (const c of cloud(/^az storage blob /))
      expect(c.line, c.line).toContain("--auth-mode login");
  });

  it("uploads the page as uncached UTF-8 HTML, overwriting in place", () => {
    const uploads = cloud(/^(az storage blob upload |aws s3 cp |gcloud storage cp )/);
    expect(uploads.length).toBeGreaterThanOrEqual(3);
    for (const { line } of uploads) {
      expect(line, line).toMatch(/content-type[ =]"text\/html; charset=utf-8"/);
      expect(line, line).toMatch(/cache-control[ =]"no-cache"/);
      expect(line, line).toContain("$OBJECT");
    }
    for (const { line } of cloud(/^az storage blob upload /)) expect(line).toContain("--overwrite");
  });

  it("puts every copy at one unguessable path per review", () => {
    const block = sh().find((b) => b.body.includes("randomBytes"));
    expect(block, "a block that mints the slug").toBeDefined();
    const mint = (env: Record<string, string> = {}) =>
      run(`${block!.body}\necho "$SLUG $OBJECT"`, { PREFIX: "thurview", ...env });
    const [slug, object] = mint().split(" ");
    expect(slug).toMatch(/^r[0-9a-f]{24}$/);
    expect(object).toBe(`thurview/${slug}/index.html`);
    expect(mint().split(" ")[0]).not.toBe(slug);
    // an update keeps the slug the config recorded, so the link already sent still works
    expect(mint({ SLUG: slug! })).toBe(`${slug} thurview/${slug}/index.html`);
    // with no prefix the key would land outside the grant on <prefix>/*
    expect(() => mint({ PREFIX: "" })).toThrow();
  });

  it("signs links for the requested days, clamped to each cloud's limit", () => {
    const block = sh().find((b) => b.body.includes("EXPIRY_SECONDS="));
    expect(block, "a block that computes the expiry").toBeDefined();
    const expiry = (days?: string, provider = "azure") =>
      run(`${block!.body}\necho "$EXPIRY_SECONDS $EXPIRY_AT"`, {
        PROVIDER: provider,
        ...(days ? { EXPIRY_DAYS: days } : {}),
      });
    expect(expiry().split(" ")[0]).toBe("604800");
    expect(expiry("2").split(" ")[0]).toBe("172800");
    for (const provider of ["azure", "aws"])
      expect(expiry("30", provider).split(" ")[0]).toBe("604800");
    // a URL signed by impersonating a service account lives 12 hours at most
    expect(expiry(undefined, "gcp").split(" ")[0]).toBe("43200");
    // a link dead on issue, or a fraction bash cannot do arithmetic on, is refused
    for (const bad of ["0", "00", "08", "0.5", "-1", "seven"]) expect(() => expiry(bad)).toThrow();
    // Azure takes an absolute UTC time in this exact shape
    const at = expiry("1").split(" ")[1]!;
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
    const hours = (Date.parse(at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("signs read-only, expiring links from the user's own identity", () => {
    const sas = cloud(/^az storage blob generate-sas /);
    const presign = cloud(/^aws s3 presign /);
    const gcs = cloud(/^gcloud storage sign-url /);
    for (const list of [sas, presign, gcs]) expect(list.length).toBeGreaterThan(0);
    for (const { line } of sas)
      for (const flag of ["--as-user", "--permissions r ", "--https-only", '--expiry "$EXPIRY_AT"'])
        expect(line, line).toContain(flag);
    for (const { line } of presign) expect(line).toContain('--expires-in "$EXPIRY_SECONDS"');
    for (const { line } of gcs) {
      expect(line).toContain('--duration="${EXPIRY_SECONDS}s"');
      expect(line).toContain("--impersonate-service-account");
    }
  });

  it("can take a copy down on every provider", () => {
    for (const cli of [
      /^az storage blob delete /,
      /^aws s3 rm /,
      /^gcloud storage rm /,
      /^npx --yes wrangler@\S+ pages deployment delete /,
    ])
      expect(cloud(cli).length, String(cli)).toBeGreaterThan(0);
  });

  it("keeps whatever makes a copy public under the confirmation step", () => {
    const opensUp =
      /\$web|allUsers|public-read|--static-website|put-public-access-block|wrangler@\S+ pages deploy /;
    const publicOnes = commands().filter((c) => opensUp.test(c.line));
    expect(publicOnes.length).toBeGreaterThan(0);
    for (const c of publicOnes) expect(c.heading, c.line).toMatch(/public/i);
    // and the prose leading up to each one asks the user before it runs
    for (const c of commandsWithPreface().filter((c) => opensUp.test(c.line)))
      expect(c.preface, c.line).toMatch(/confirm/i);
    expect(source).toMatch(/This will be public/);
  });

  // A link travels further than the conversation it was sent in.
  it("exports without the reader's threads unless the user asks for them", () => {
    const exports = commands().filter((c) => /^thurview export /.test(c.line));
    expect(exports.length).toBeGreaterThan(0);
    for (const { line } of exports) {
      expect(line).not.toContain("#");
      expect(line).toMatch(/ --no-threads$/);
    }
  });

  it("keeps its targets in a config block with a scope and no secret in it", () => {
    const yaml = blocks().find((b) => b.lang === "yaml" && b.body.includes("targets:"));
    expect(yaml, "the config block").toBeDefined();
    const config = parseYaml(yaml!.body) as {
      default: string;
      targets: Record<string, Record<string, unknown>>;
    } & Record<string, unknown>;
    for (const key of ["default", "prefix", "expiry_days", "targets", "published"])
      expect(config, key).toHaveProperty(key);
    expect(config.targets).toHaveProperty(config.default);
    const providers = Object.values(config.targets).map((t) => t["provider"]);
    expect(new Set(providers)).toEqual(new Set(["azure", "aws", "gcp", "cloudflare"]));
    // the example shows both shapes of scope, on hosts no real organisation owns
    const scopes = Object.values(config.targets).flatMap((t) => [
      ...((t["allow_remotes"] as string[]) ?? []),
      ...((t["deny_remotes"] as string[]) ?? []),
    ]);
    expect(Object.values(config.targets).some((t) => t["deny_remotes"])).toBe(true);
    expect(Object.values(config.targets).some((t) => t["allow_remotes"])).toBe(true);
    for (const glob of scopes) expect(glob).toMatch(/example/);
    expect(yaml!.body).not.toMatch(/\b(key|secret|token|password)\b\s*:/i);
  });

  it("checks the target's scope before it exports anything", () => {
    const scope = source.indexOf("scripts/check-scope.mjs");
    const exporting = source.indexOf("thurview export --review");
    expect(scope).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(exporting);
    expect(existsSync(join(ROOT, "skills", "thurview-publish", "scripts", "check-scope.mjs"))).toBe(
      true,
    );
  });

  it("signs in interactively by default, and leaves environment tokens to non-interactive runs", () => {
    const signingIn = source.slice(
      source.indexOf("## Signing in"),
      source.indexOf("## The config"),
    );
    for (const login of ["az login", "aws sso login", "gcloud auth login", "wrangler login"])
      expect(signingIn).toContain(login);
    expect(signingIn).toMatch(/Interactive, the default/);
    expect(signingIn).toMatch(/Non-interactive only[\s\S]*CLOUDFLARE_API_TOKEN/);
  });
});
