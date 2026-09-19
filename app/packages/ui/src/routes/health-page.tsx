import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Card } from "../components/card.js";
import { Button } from "../components/button.js";
import { useDoctor, useRefreshDoctor } from "../api/doctor.js";
import type { ApiDoctorReport } from "@crewbench/contract";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-[var(--color-fg-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function boolLabel(value: boolean | null): string {
  return value === null ? "—" : value ? "yes" : "no";
}

function ReportCard({ report }: { report: ApiDoctorReport }) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold capitalize">{report.cli}</span>
        {report.ok ? <CheckCircle2 size={18} className="text-green-500" /> : <XCircle size={18} className="text-red-500" />}
      </div>
      <Field label="installed" value={boolLabel(report.installed)} />
      <Field label="version" value={report.version ?? "—"} />
      <Field label="config dir" value={report.config_dir ?? "—"} />
      <Field label="config dir writable" value={boolLabel(report.config_dir_writable)} />
      <Field label="network" value={boolLabel(report.network_ok)} />
      <Field label="logged in" value={boolLabel(report.logged_in)} />
      {report.errors.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 rounded-md bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
          {report.errors.map((error, i) => (
            <p key={i}>{error}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

export function HealthPage() {
  const { data, isLoading, isError, error } = useDoctor();
  const refresh = useRefreshDoctor();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Health</h1>
        <Button onClick={() => void refresh()}>
          <RefreshCw size={14} className="mr-1.5" />
          Refresh
        </Button>
      </div>
      {data && <p className="text-xs text-[var(--color-fg-muted)]">checked {new Date(data.checked_at).toLocaleString()}</p>}
      {isLoading && <p className="text-sm text-[var(--color-fg-muted)]">Checking CLIs…</p>}
      {isError && <p className="text-sm text-red-500">{error.message}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {data?.reports.map((report) => <ReportCard key={report.cli} report={report} />)}
      </div>
    </div>
  );
}
