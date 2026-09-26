import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import type { ApiCli, ApiDoctorReport } from "@crewbench/contract";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { FolderBrowserDialog } from "../components/folder-browser-dialog.js";
import { useDoctor } from "../api/doctor.js";
import { useAddProject } from "../api/projects.js";
import { useInstallPlugin } from "../api/plugin-install.js";

function DoctorRow({ report }: { report: ApiDoctorReport }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm">
      {report.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-500" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-red-500" />}
      <div className="flex-1">
        <span className="font-medium capitalize">{report.cli}</span>
        {!report.ok && report.errors.length > 0 && (
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{report.errors[0]}</p>
        )}
      </div>
    </div>
  );
}

/** The "offer to install the plugin" step of the onboarding wizard
 * (Phase 4 milestone 2). Only shown for a CLI doctor already reports
 * `installed: true` -- installing crewbench *into* a CLI that isn't even
 * installed on this machine isn't a real, actionable offer. A single
 * click doesn't fire the real install immediately: it flips this row
 * into an inline "really install into <cli>?" confirm state first
 * (the phase prompt's own "run it only on confirmation," implemented as
 * a real, visible second step rather than a native `confirm()` dialog,
 * which this app avoids elsewhere too). */
function PluginInstallRow({ cli }: { cli: ApiCli }) {
  const [confirming, setConfirming] = useState(false);
  const install = useInstallPlugin();

  if (install.isSuccess) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm">
        {install.data.ok ? <CheckCircle2 size={16} className="text-green-500" /> : <XCircle size={16} className="text-red-500" />}
        <span className="font-medium capitalize">{cli}</span>
        <span className="text-xs text-[var(--color-fg-muted)]">{install.data.ok ? "plugin installed" : (install.data.error ?? "install failed")}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm">
      <span className="font-medium capitalize">{cli}</span>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-fg-muted)]">Install crewbench into {cli}?</span>
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={install.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => install.mutate(cli)} disabled={install.isPending}>
            {install.isPending ? "Installing…" : "Confirm"}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Install plugin
        </Button>
      )}
      {install.isError && <p className="text-xs text-red-500">{install.error.message}</p>}
    </div>
  );
}

/** The first-run wizard (Phase 4 milestone 2, Design decision 3) --
 * rendered by `ProjectsPage` itself only while `GET /api/projects`
 * returns empty, not a separate route. **A real, disclosed design
 * call**: this means the wizard reappears any time zero projects are
 * registered (e.g. every one was removed), not "shown once, ever" --
 * exactly what the plan's own wording says ("shown only when
 * `GET /api/projects` returns empty"), not a separate persisted
 * first-run flag this milestone didn't build. Sequences three existing
 * or newly-added pieces on one page (not a multi-step modal --
 * simplest correct way to satisfy "sequencing," disclosed as a judgment
 * call in the milestone log): doctor status, adding the first project
 * (reusing the same folder browser and `useAddProject()` the ordinary
 * "Add project" dialog already uses), and offering a plugin install per
 * CLI doctor already reports installed. The wizard has no explicit
 * "finish" step or button -- once a project is actually added,
 * `useAddProject()`'s own query invalidation flips `GET /api/projects`
 * non-empty, and `ProjectsPage` naturally stops rendering this
 * component on its very next render, no coordination needed. */
export function OnboardingWizard() {
  const { data: doctor, isLoading: doctorLoading } = useDoctor();
  const [path, setPath] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const addProject = useAddProject();

  const submitProject = (e: React.FormEvent) => {
    e.preventDefault();
    addProject.mutate({ path });
  };

  const installedClis = (doctor?.reports ?? []).filter((r) => r.installed === true);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Welcome to crewbench</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">Let's get you set up.</p>
      </div>

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">1. Check your CLIs</h2>
        {doctorLoading && <p className="text-sm text-[var(--color-fg-muted)]">Checking…</p>}
        <div className="flex flex-col gap-1.5">{doctor?.reports.map((r) => <DoctorRow key={r.cli} report={r} />)}</div>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">2. Add your first project</h2>
        <form onSubmit={submitProject} className="flex flex-col gap-2">
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
          {addProject.isError && <p className="text-sm text-red-500">{addProject.error.message}</p>}
          <Button type="submit" variant="primary" disabled={addProject.isPending || !path} className="self-start">
            {addProject.isPending ? "Adding…" : "Add project"}
          </Button>
        </form>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">3. Install the plugin (optional)</h2>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Installing the crewbench plugin lets you also run <code>/crewbench:new-task</code> and friends directly from that CLI.
        </p>
        {installedClis.length === 0 && !doctorLoading && (
          <p className="text-xs text-[var(--color-fg-muted)]">No detected CLIs to install into yet.</p>
        )}
        <div className="flex flex-col gap-1.5">
          {installedClis.map((r) => (
            <PluginInstallRow key={r.cli} cli={r.cli} />
          ))}
        </div>
      </Card>

      <FolderBrowserDialog open={browserOpen} onOpenChange={setBrowserOpen} onSelect={setPath} />
    </div>
  );
}
