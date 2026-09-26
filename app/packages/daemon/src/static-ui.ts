import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** Where the built UI lands relative to this file, resolved for either
 * layout this module can actually run from (Phase 4 milestone 1):
 *
 * 1. **The published/bundled `crewbench` package**
 *    (`packages/cli/scripts/build-publish.mjs`): esbuild inlines this
 *    entire module into one file at `publish/bin.js`, and that script
 *    copies `packages/ui/dist` to `publish/ui-dist` as a direct sibling
 *    of it -- so `import.meta.url` here resolves to `publish/bin.js`'s
 *    own location, and `ui-dist` sits right next to it.
 * 2. **This repo's monorepo dev layout** (unbundled, `tsc -b`'s own
 *    per-package output): this file compiles to
 *    `packages/daemon/dist/static-ui.js`, two directories above
 *    `packages/ui/dist` (`packages/daemon/dist` and `packages/ui/dist`
 *    are siblings under `packages/`) -- the same path this function
 *    always used before this milestone.
 *
 * Tries the packaged (bundled) layout first since it's a plain sibling
 * check, falls back to the dev layout -- no environment flag needed,
 * both branches are cheap `existsSync` checks. `CREWBENCH_UI_DIST`
 * overrides either one, same override pattern every other "where do I
 * find my files" lookup in this app uses
 * (`CREWBENCH_ROOT`/`CREWBENCH_HOME`), unchanged by this milestone --
 * still what the daemon/UI test suites set explicitly rather than
 * relying on either real layout existing on disk. */
function defaultUiDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = join(here, "ui-dist");
  if (existsSync(join(packaged, "index.html"))) return packaged;
  return join(here, "..", "..", "ui", "dist");
}

/** Serves the built UI (if present) as static files, with an SPA
 * fallback to `index.html` for any GET that isn't `/api/*` and doesn't
 * match a real file -- client-side routes like `/projects/<id>` are
 * handled by `packages/ui`'s own router, not the server. If no build is
 * found (e.g. running the daemon's own test suite, or a dev setup that
 * hasn't run `pnpm --filter @crewbench/ui build` yet), this is a no-op:
 * `crewbench ui` still starts and the API still works, just with nothing
 * to open in a browser -- printing the API URL either way (`ui.ts`
 * already does), never crashing over a missing frontend build. */
export async function registerUiStatic(app: FastifyInstance): Promise<void> {
  const dist = process.env.CREWBENCH_UI_DIST ?? defaultUiDist();
  const indexHtml = join(dist, "index.html");
  if (!existsSync(indexHtml)) return;

  await app.register(fastifyStatic, { root: dist, index: ["index.html"] });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
}
