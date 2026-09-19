import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** Where `packages/ui`'s Vite build lands relative to this file, in this
 * repo's monorepo dev layout (`app/packages/daemon/src` and
 * `app/packages/ui/dist` are siblings under `app/packages/`) --
 * `CREWBENCH_UI_DIST` overrides it, same override pattern every other
 * "where do I find my files" lookup in this app uses
 * (`CREWBENCH_ROOT`/`CREWBENCH_HOME`). Phase 4's packaged npm install
 * will need its own resolution strategy (the UI ships bundled with the
 * published package, not two directories up from a source checkout) --
 * out of scope here, same boundary Phase 1's `findRoot()` already drew
 * for the plugin root. */
function defaultUiDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
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
