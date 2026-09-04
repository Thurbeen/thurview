import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";

await mkdir("dist/ui", { recursive: true });
await build({
  entryPoints: ["src/ui/app.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "dist/ui/app.js",
  sourcemap: true,
  logLevel: "warning",
});
await copyFile("src/ui/index.html", "dist/ui/index.html");
await copyFile("src/ui/app.css", "dist/ui/app.css");
await cp("src/ui/assets", "dist/ui/assets", { recursive: true });
