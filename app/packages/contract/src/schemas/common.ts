import { z } from "zod";

/** Ported from every schemas/<role>.json's shared "blocked" array shape:
 * actions a role needed but could not perform (denied/sandboxed). */
export const BlockedActionSchema = z
  .object({
    action: z.string(),
    reason: z.string(),
  })
  .strict();
export type BlockedAction = z.infer<typeof BlockedActionSchema>;

/** schema_version on state.json / index.json entries / status.json entries /
 * the dispatch envelope. Missing means legacy version 0 -- see
 * docs/app/contract/README.md's "schema_version" section. Current: 1. */
export const SCHEMA_VERSION = 1;
export const SchemaVersionSchema = z.number().int().optional();
