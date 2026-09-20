import { useMutation } from "@tanstack/react-query";
import type { ApiCli, ApiInstallPluginResponse } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

/** The onboarding wizard's "install the plugin" step (Phase 4 milestone
 * 2) -- `POST /api/plugin-install/:cli` *is* the confirmed action (the
 * phase prompt's own "run it only on confirmation" means the wizard
 * only calls this after the user clicks a real button, not that this
 * call itself needs a second server-side confirmation step). */
export function useInstallPlugin() {
  return useMutation({
    mutationFn: (cli: ApiCli) => apiFetch<ApiInstallPluginResponse>(`/api/plugin-install/${cli}`, { method: "POST" }),
  });
}
