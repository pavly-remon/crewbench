import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { FolderGit2, Plus } from "lucide-react";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { Dialog } from "../components/dialog.js";
import { FolderBrowserDialog } from "../components/folder-browser-dialog.js";
import { OnboardingWizard } from "./onboarding-wizard.js";
import { useAddProject, useProjects } from "../api/projects.js";

/** Path is chosen through the folder browser (`FolderBrowserDialog`),
 * never typed -- a real absolute path only the server can resolve (see
 * that component's own docstring for why a browser page can't do this
 * itself). The field showing it is display-only. */
function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const addProject = useAddProject();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    addProject.mutate(
      { path, name: name || undefined },
      {
        onSuccess: () => {
          onOpenChange(false);
          setPath("");
          setName("");
        },
      },
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} title="Add project">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 text-sm">
            {/* Not a <label>: it would wrap both the read-only path
                display and the Browse button, and a <label> containing
                more than one interactive-ish element gets its whole text
                content computed as the accessible *name* of whichever
                control is inside -- the Browse button would announce as
                "Path No folder chosen yet", not "Browse…". Caught by
                this dialog's own test querying the button by its real
                name. */}
            <span>Path</span>
            <div className="flex gap-2">
              <p
                className={
                  "flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1.5 text-sm " +
                  (path ? "" : "text-[var(--color-fg-muted)]")
                }
              >
                {path || "No folder chosen yet"}
              </p>
              <Button type="button" variant="secondary" onClick={() => setBrowserOpen(true)}>
                Browse…
              </Button>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Display name (optional)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            />
          </label>
          {addProject.isError && <p className="text-sm text-red-500">{addProject.error.message}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={addProject.isPending || !path}>
              {addProject.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </Dialog>
      <FolderBrowserDialog open={browserOpen} onOpenChange={setBrowserOpen} onSelect={setPath} />
    </>
  );
}

export function ProjectsPage() {
  const { data: projects, isLoading, isError, error } = useProjects();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Phase 4 milestone 2, Design decision 3: the first-run wizard replaces
  // this whole page's content while there are genuinely zero registered
  // projects -- see OnboardingWizard's own docstring for why this is
  // gated on live query data, not a separate persisted "have I onboarded
  // before" flag. It naturally stops rendering the moment the wizard's
  // own "add a project" step succeeds, since that flips `projects` non-
  // empty on the very next render.
  if (!isLoading && !isError && projects?.length === 0) {
    return <OnboardingWizard />;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          <Plus size={16} className="mr-1.5" />
          Add project
        </Button>
      </div>

      {isLoading && <p className="text-sm text-[var(--color-fg-muted)]">Loading projects…</p>}
      {isError && <p className="text-sm text-red-500">{error.message}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects?.map((project) => (
          <Link key={project.id} to="/projects/$projectId" params={{ projectId: project.id }}>
            <Card className="flex h-full flex-col gap-2 hover:border-[var(--color-accent)]">
              <div className="flex items-center gap-2">
                <FolderGit2 size={16} className="text-[var(--color-fg-muted)]" />
                <span className="font-medium">{project.name}</span>
              </div>
              <p className="truncate text-xs text-[var(--color-fg-muted)]">{project.path}</p>
              <div className="mt-auto flex gap-4 pt-2 text-xs text-[var(--color-fg-muted)]">
                <span>{project.active_task_count} active</span>
                <span>{project.recent_task_count} recent</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
