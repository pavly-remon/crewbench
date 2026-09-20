import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiFsBrowseResponseSchema } from "@crewbench/contract";

/** `GET /api/fs/browse?path=` -- the "Add project" dialog's directory
 * browser, replacing manual path entry. Lists real directories under
 * `path` (default: the server process's home directory -- this daemon
 * only ever binds 127.0.0.1 with a fresh per-run bearer token, so "the
 * server's own home dir" and "the person sitting at this machine's home
 * dir" are the same thing in every real deployment of this app). No
 * access restriction beyond what the OS itself enforces (readdir simply
 * fails with EACCES/ENOENT, reported as a normal 400) -- this daemon
 * already has unrestricted local filesystem access for every project it
 * drives; a directory listing endpoint doesn't cross any trust boundary
 * this app doesn't already cross elsewhere. */
export function registerFsBrowseRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string } }>("/api/fs/browse", async (request, reply) => {
    const target = resolve(request.query.path && request.query.path.trim() ? request.query.path : homedir());

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reply.code(400).send({ error: `can't list ${target}: ${message}` });
      return;
    }

    // Dotfiles excluded (the common file-picker convention -- a project
    // that itself lives at a dot-prefixed path is a real, disclosed edge
    // case this doesn't cover). `is_git_repo` is a hint only, it doesn't
    // gate navigation or selection -- see this schema's own docstring in
    // @crewbench/contract for why.
    const entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({
        name: d.name,
        path: join(target, d.name),
        is_git_repo: existsSync(join(target, d.name, ".git")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = dirname(target);
    await reply.send(
      ApiFsBrowseResponseSchema.parse({
        path: target,
        parent: parent === target ? null : parent,
        entries,
      }),
    );
  });
}
