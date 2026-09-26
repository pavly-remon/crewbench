---
name: open
description: Open a task (or the crewbench UI itself) in the browser, if the crewbench app's daemon is running on this machine. Read-only.
argument-hint: "[task-id]"
disable-model-invocation: true
---

# crewbench: open

You open the crewbench web UI (the daemon-hosted app, `crewbench ui` --
see `docs/app/CONTEXT.md` for what it is) to a task, or to its front page
if no task id is given. You never start the daemon yourself, never read
or transmit its auth token, and never change any file.

Argument (optional task id): $ARGUMENTS

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Before anything else, run `python3 <root>/bin/crewbench_banner.py` and show
its output verbatim.

## Why this can't just print an authenticated link

The app's daemon (Phase 2 of `docs/app/CONTEXT.md`'s build) generates a
fresh bearer token in memory every time it starts and **never writes it
to disk anywhere** — a deliberate security decision (loopback-only
binding plus a process-lifetime-only token, so nothing on this machine's
filesystem can leak API access to it), unchanged by this skill. That
means this skill can find *where* a running daemon is, but can never
authenticate a browser tab on its own. The person opening the link
authenticates through whatever tab already has the token — the one that
opened automatically when they last ran `crewbench ui`, or `location.hash`
in an already-open tab. If no such tab is open, the real page still
loads, it's just not authenticated yet.

## Workflow

1. Run:

   ```
   python3 <root>/bin/crewbench_daemon_probe.py [task-id]
   ```

   passing the task id argument only if one was given. Its own docstring
   has the full discovery story (checks `~/.crewbench/config.json`'s own
   `port` field first, falls back to scanning the daemon's real default
   port range) — you don't need to re-derive any of that.

2. If the result's `"found"` is `false`: tell the user no running
   crewbench daemon was found on this machine, and that they can start
   one with `crewbench ui` (or `npx crewbench ui` if it isn't installed
   globally). Don't guess a URL or suggest a port — nothing is running.

3. If `"found"` is `true`: open the real `"url"` field in the user's
   default browser (the same open-a-URL mechanism you'd use for any other
   link — e.g. macOS's `open`, Linux's `xdg-open`, Windows' `start`, or
   simply print it and let the user click it if you have no way to open a
   browser directly). **Real, disclosed limitation, corrected here after
   review caught this skill's own earlier wording overstating what's
   possible**: the UI has no token-entry field anywhere — its bootstrap
   code (`bootstrapToken()`) only ever reads a token from `location.hash`
   once, at page load, so there is nothing to "paste into." Tell the user
   plainly, accurately: if they already have another crewbench UI tab
   open, switch to it (or copy that tab's own address-bar URL, which
   still carries its `#token=...` fragment, into this new tab) — a fresh
   tab with no token in its own URL will load the real page but every
   `/api/` call will 401 until it has one. If no tab is open anywhere,
   the simplest real fix is running `crewbench ui` themselves, which
   opens one correctly authenticated from the start.

4. Never dump the raw JSON from step 1 on the user — translate it into a
   short, plain-language result either way.
