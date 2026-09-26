import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import type { Project } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { useProfile, useDetectProfile, useSaveProfile } from "../api/profile.js";

function CommandsEditor({ profile, onChange }: { profile: Project; onChange: (next: Project) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-xs">
        install
        <input
          value={profile.install ?? ""}
          onChange={(e) => onChange({ ...profile, install: e.target.value || null })}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
        />
      </label>
      {(["lint", "typecheck", "test", "test_changed", "build", "format_check"] as const).map((field) => (
        <label key={field} className="flex flex-col gap-1 text-xs">
          {field}
          <input
            value={profile.commands[field] ?? ""}
            onChange={(e) => onChange({ ...profile, commands: { ...profile.commands, [field]: e.target.value || null } })}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
      ))}
    </div>
  );
}

/** Project profile: refresh/edit/confirm (Phase 3 milestone 4), mirroring
 * `packages/cli`'s `crewbench profile refresh` (`commands/profile.ts`)
 * and `packages/engine`'s `detectProfile()` -- detection never saves
 * itself, this page shows the proposal and only confirms it on an
 * explicit save, same "never write silently" rule. `languages`/
 * `frameworks`/`source_dirs`/`test_patterns`/`agy_allow_rules` are shown
 * read-only (detected facts about the repo, not settings a person tunes
 * by hand); only the command strings and `package_manager`/`install` are
 * editable, matching what a person would realistically want to correct
 * (a wrong or missing detected command). */
export function ProfilePage() {
  const { projectId } = useParams({ from: "/projects/$projectId/profile" });
  const { data: saved, isLoading } = useProfile(projectId);
  const detect = useDetectProfile(projectId);
  const save = useSaveProfile(projectId);

  const [draft, setDraft] = useState<Project | null>(null);

  useEffect(() => {
    if (draft === null && saved !== undefined) setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const onRefresh = () => {
    detect.mutate(undefined, { onSuccess: (fresh) => setDraft(fresh) });
  };

  const onSave = () => {
    if (!draft) return;
    save.mutate({ ...draft, confirmed: true });
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Project profile</h1>
        <Button onClick={onRefresh} disabled={detect.isPending}>
          <RefreshCw size={14} className="mr-1.5" />
          {detect.isPending ? "Detecting…" : "Refresh"}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>}
      {!isLoading && !saved && !draft && (
        <p className="text-sm text-[var(--color-fg-muted)]">No project profile yet -- click Refresh to detect one.</p>
      )}

      {draft && (
        <>
          <Card className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs">
              package manager
              <input
                value={draft.package_manager ?? ""}
                onChange={(e) => setDraft({ ...draft, package_manager: e.target.value || null })}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
              />
            </label>
            <CommandsEditor profile={draft} onChange={setDraft} />
          </Card>

          <Card className="flex flex-col gap-1 text-xs text-[var(--color-fg-muted)]">
            <p>languages: {draft.languages.join(", ") || "—"}</p>
            <p>frameworks: {draft.frameworks.join(", ") || "—"}</p>
            <p>source dirs: {draft.source_dirs.join(", ") || "—"}</p>
          </Card>

          <div className="flex items-center justify-between">
            {!draft.confirmed && <p className="text-xs text-amber-500">not yet confirmed -- this proposal hasn't been saved</p>}
            <div className="ml-auto flex gap-2">
              <Button variant="primary" onClick={onSave} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Confirm and save"}
              </Button>
            </div>
          </div>
          {save.isError && <p className="text-sm text-red-500">{save.error.message}</p>}
        </>
      )}
    </div>
  );
}
