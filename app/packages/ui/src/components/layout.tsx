import { Link, Outlet, useParams } from "@tanstack/react-router";
import { Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "../lib/theme.js";
import { cn } from "../lib/cn.js";

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next: Record<string, "light" | "dark" | "system"> = { light: "dark", dark: "system", system: "light" };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;
  return (
    <button
      aria-label={`Theme: ${theme}. Click to change.`}
      onClick={() => setTheme(next[theme] ?? "system")}
      className="rounded-md p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
    >
      <Icon size={18} />
    </button>
  );
}

export function Layout() {
  const params = useParams({ strict: false }) as { projectId?: string };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] px-4">
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold tracking-tight">
            crewbench
          </Link>
          {params.projectId && (
            <>
              <Link
                to="/projects/$projectId"
                params={{ projectId: params.projectId }}
                className={cn("text-[var(--color-fg-muted)] [&.active]:text-[var(--color-fg)]")}
                activeProps={{ className: "text-[var(--color-fg)]" }}
              >
                Board
              </Link>
              <Link
                to="/projects/$projectId/usage"
                params={{ projectId: params.projectId }}
                className={cn("text-[var(--color-fg-muted)] [&.active]:text-[var(--color-fg)]")}
                activeProps={{ className: "text-[var(--color-fg)]" }}
              >
                Usage
              </Link>
            </>
          )}
          <Link
            to="/health"
            className={cn("text-[var(--color-fg-muted)] [&.active]:text-[var(--color-fg)]")}
            activeProps={{ className: "text-[var(--color-fg)]" }}
          >
            Health
          </Link>
        </nav>
        <ThemeToggle />
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}
