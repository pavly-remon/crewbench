import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Daemon-served static UI (Phase 2 milestone 1's goal: `crewbench ui`
// starts the daemon and serves this build) -- no dev-server proxy
// config needed here since Phase 2 is read-only and every request goes
// straight to the daemon's own port at runtime, resolved client-side
// from the URL the daemon itself opens. Routes are declared in code
// (src/router.tsx), not file-based -- skips the router-plugin's codegen
// step entirely, one less moving part for a route tree this small (5
// screens total across the whole phase).
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
