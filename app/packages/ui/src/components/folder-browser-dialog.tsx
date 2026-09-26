import { useState } from "react";
import { ArrowUp, Folder, GitBranch } from "lucide-react";
import { Dialog } from "./dialog.js";
import { Button } from "./button.js";
import { useBrowseDirectory } from "../api/fs.js";

/** Server-side directory browser for the "Add project" dialog, replacing
 * free-text path entry. A browser page's own file-picker APIs
 * (`<input webkitdirectory>`) don't expose a real filesystem path to
 * page JS at all, by design -- only a folder name and a relative file
 * list -- so a real path-based picker for a locally-hosted app like this
 * one has to come from the server side, which already has real
 * filesystem access (`routes/fs-browse.ts`). Resets to the daemon's
 * default starting directory (`path: null`) every time it opens, not
 * wherever it was last closed -- simplest predictable behavior, matching
 * how a native "Open" dialog starts fresh each time in most apps. */
export function FolderBrowserDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useBrowseDirectory(path, open);

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) setPath(null); // fresh start next time it opens
  };

  return (
    <Dialog open={open} onOpenChange={close} title="Choose a project folder" widthClassName="max-w-lg">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            className="shrink-0 px-2"
            disabled={!data?.parent}
            onClick={() => data?.parent && setPath(data.parent)}
            aria-label="Go up one directory"
          >
            <ArrowUp size={14} />
          </Button>
          <p className="truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1.5 text-xs">
            {data?.path ?? "…"}
          </p>
        </div>

        <div className="flex h-72 flex-col gap-0.5 overflow-y-auto rounded-md border border-[var(--color-border)] p-1">
          {isLoading && <p className="p-2 text-sm text-[var(--color-fg-muted)]">Loading…</p>}
          {isError && <p className="p-2 text-sm text-red-500">{error.message}</p>}
          {!isLoading && !isError && data?.entries.length === 0 && (
            <p className="p-2 text-sm text-[var(--color-fg-muted)]">No subfolders here.</p>
          )}
          {data?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => setPath(entry.path)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg-subtle)]"
            >
              <Folder size={14} className="shrink-0 text-[var(--color-fg-muted)]" />
              <span className="flex-1 truncate">{entry.name}</span>
              {entry.is_git_repo && (
                <span title="git repo">
                  <GitBranch size={13} className="shrink-0 text-[var(--color-accent)]" />
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!data?.path}
            onClick={() => {
              if (data?.path) {
                onSelect(data.path);
                close(false);
              }
            }}
          >
            Select this folder
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
