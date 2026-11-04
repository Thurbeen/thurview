import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";

// Minified: the bundle is served on every page load and copied whole into
// every exported page and snapshot. The source map keeps stack traces readable.
await mkdir("dist/ui", { recursive: true });
await build({
  entryPoints: ["src/ui/app.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/ui/app.js",
  minify: true,
  sourcemap: true,
  logLevel: "warning",
});
await build({
  entryPoints: ["src/ui/app.css"],
  outfile: "dist/ui/app.css",
  minify: true,
  logLevel: "warning",
});
await copyFile("src/ui/index.html", "dist/ui/index.html");
await cp("src/ui/assets", "dist/ui/assets", { recursive: true });
