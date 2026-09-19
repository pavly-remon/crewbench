import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "crewbench-theme";

/** Per-viewer convenience only (browser storage per docs/app/CONTEXT.md's
 * artifact-storage guidance applied to this app too) -- defaults to
 * `prefers-color-scheme`, with an explicit toggle persisted locally.
 * Never anything the daemon needs to know about. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // private window / blocked storage -- theme just won't persist
    }
  }, []);

  return [theme, setTheme];
}
