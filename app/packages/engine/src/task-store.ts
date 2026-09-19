import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, type TaskState, type TaskCommand } from "@crewbench/contract";
import { appendEvent, atomicWriteJson, lockedReadModifyWrite, nowIso, readJsonOrDefault } from "./contract-fs.js";

/** Ported from crewbench_state.py's make_slug()/make_task_id(). Same id
 * shape as the plugin: `YYYYMMDD-HHMM-<up to 5 word kebab slug>-<4 hex>`
 * -- both sides must agree on this exactly, since a task created by
 * either one is read by the other (docs/app/contract/README.md's "Task
 * ids" section). */
export function makeSlug(text: string, maxWords = 5): string {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, maxWords);
  return words.join("-") || "task";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function makeTaskId(text: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `${stamp}-${makeSlug(text)}-${randomBytes(2).toString("hex")}`;
}

function statePath(taskDir: string): string {
  return join(taskDir, "state.json");
}
function stateLockPath(taskDir: string): string {
  return join(taskDir, ".state.json.lock");
}
function indexPath(taskDir: string): string {
  // <root>/tasks/<id> -> <root>/index.json
  return join(taskDir, "..", "..", "index.json");
}
function indexLockPath(taskDir: string): string {
  return join(taskDir, "..", "..", ".index.json.lock");
}

interface IndexEntry {
  schema_version: number;
  id: string;
  command: TaskCommand | undefined;
  title: string | undefined;
  phase: string | undefined;
  round: number | undefined;
  updated_at: string | undefined;
}

function indexEntry(state: TaskState): IndexEntry {
  return {
    schema_version: (state.schema_version as number | undefined) ?? SCHEMA_VERSION,
    id: state.id,
    command: state.command,
    title: state.title,
    phase: state.phase,
    round: state.round,
    updated_at: state.updated_at,
  };
}

export async function loadState(taskDir: string): Promise<TaskState> {
  const path = statePath(taskDir);
  if (!existsSync(path)) {
    throw new Error(`no state.json in ${taskDir} — run createTask first`);
  }
  return JSON.parse(await readFile(path, "utf-8")) as TaskState;
}

/** Holds locks across load -> mutate -> save for both state.json and
 * index.json -- same two-lock scheme (per-task state lock, then the
 * shared root index lock) as crewbench_state.py's mutate_state(), so
 * concurrent Node-side writers never lose an update to either file (see
 * contract-fs.ts's locking-scope note for what this does and doesn't
 * guard against). `mutateFn` receives null when state.json doesn't exist
 * yet (the create case). */
export async function mutateState(
  taskDir: string,
  mutateFn: (state: TaskState | null) => TaskState | Promise<TaskState>,
): Promise<TaskState> {
  return lockedReadModifyWrite(stateLockPath(taskDir), async () => {
    const path = statePath(taskDir);
    const current = existsSync(path) ? (JSON.parse(await readFile(path, "utf-8")) as TaskState) : null;
    const next = await mutateFn(current);
    next.updated_at = nowIso();
    await atomicWriteJson(path, next);
    return lockedReadModifyWrite(indexLockPath(taskDir), async () => {
      const index = await readJsonOrDefault<Record<string, IndexEntry>>(indexPath(taskDir), {});
      index[next.id] = indexEntry(next);
      await atomicWriteJson(indexPath(taskDir), index);
      return next;
    });
  });
}

export interface CreateTaskParams {
  id: string;
  command: TaskCommand;
  title: string;
  baseCommit?: string | null;
  branch?: string | null;
  designSpecFile?: string | null;
  jiraKey?: string | null;
  /** Phase 3's ownership marker (docs/app/phase-3-plan.md's Design
   * decision 5) -- only the daemon's own task-creation endpoint passes
   * `"app"`. Omitted (not `null`) when unset, matching
   * `TaskStateSchema.owner`'s truly-optional shape: an absent field
   * reads as `"plugin"`, the historical default every task before this
   * phase (and every `crewbench run`-created task, which the CLI itself
   * drives synchronously and the daemon must never also try to reattach
   * to) already has. */
  owner?: "plugin" | "app";
}

/** Ported from crewbench_state.py's cmd_new(). Emits `task.created`, same
 * as the plugin's `crewbench_state.py new`. */
export async function createTask(taskDir: string, params: CreateTaskParams): Promise<TaskState> {
  const state = await mutateState(taskDir, () => ({
    schema_version: SCHEMA_VERSION,
    id: params.id,
    command: params.command,
    title: params.title,
    created_at: nowIso(),
    updated_at: nowIso(),
    phase: "scoping",
    round: 0,
    lineup: {},
    base_commit: params.baseCommit ?? null,
    branch: params.branch ?? null,
    worktree: null,
    jira_key: params.jiraKey ?? null,
    host_override: null,
    doctor: {},
    acceptance_criteria: [],
    design_spec_file: params.designSpecFile ?? null,
    spec_file: null,
    rounds: [],
    usage: {},
    notes: [],
    ...(params.owner ? { owner: params.owner } : {}),
  }));
  await appendEvent(taskDir, "task.created", { command: params.command, title: params.title, jira_key: params.jiraKey ?? null });
  return state;
}

/** Sets a top-level field, emitting `task.phase_changed`/
 * `task.round_started` when `key` is exactly "phase"/"round" and the
 * value actually changed -- ported from crewbench_state.py's cmd_set()'s
 * event-emission rule (Phase 0 milestone 3). Only top-level keys are
 * supported (the Python side's dotted-path set_at() isn't ported here;
 * every field this engine writes is top-level, so it wasn't needed). */
export async function setField(taskDir: string, key: string, value: unknown): Promise<TaskState> {
  let oldValue: unknown;
  const state = await mutateState(taskDir, (current) => {
    if (!current) throw new Error(`no state.json in ${taskDir} — run createTask first`);
    oldValue = (current as Record<string, unknown>)[key];
    return { ...current, [key]: value } as TaskState;
  });
  if (key === "phase" && oldValue !== value) {
    await appendEvent(taskDir, "task.phase_changed", { from: oldValue ?? null, to: value });
  } else if (key === "round" && oldValue !== value) {
    await appendEvent(taskDir, "task.round_started", { round: value });
  }
  return state;
}

/** Appends to a list field, creating it if missing -- ported from
 * crewbench_state.py's cmd_append(). Emits `task.note_added` when
 * `key === "notes"`. */
export async function appendField(taskDir: string, key: string, value: unknown): Promise<TaskState> {
  const state = await mutateState(taskDir, (current) => {
    if (!current) throw new Error(`no state.json in ${taskDir} — run createTask first`);
    const existing = (current as Record<string, unknown>)[key];
    const list = Array.isArray(existing) ? existing : [];
    return { ...current, [key]: [...list, value] } as TaskState;
  });
  if (key === "notes") {
    await appendEvent(taskDir, "task.note_added", { note: value });
  }
  return state;
}

export interface TaskIndexRow {
  id: string;
  command?: TaskCommand;
  title?: string;
  phase?: string;
  round?: number;
  updated_at?: string;
}

/** Ported from crewbench_state.py's cmd_list(): newest-first, tolerant of
 * a missing/unparseable index.json (returns an empty list rather than
 * throwing). */
export async function listTasks(root: string): Promise<TaskIndexRow[]> {
  const index = await readJsonOrDefault<Record<string, TaskIndexRow>>(join(root, "index.json"), {});
  return Object.values(index).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}
