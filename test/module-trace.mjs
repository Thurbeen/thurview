// Preloaded with `node --import`: records every module URL the process
// resolves into the file named by THURVIEW_MODULE_TRACE, one per line, so a
// test can state which modules a command loads.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { appendFileSync } from "node:fs";
      export async function resolve(specifier, context, next) {
        const r = await next(specifier, context);
        appendFileSync(process.env.THURVIEW_MODULE_TRACE, r.url + "\\n");
        return r;
      }
    `),
);
