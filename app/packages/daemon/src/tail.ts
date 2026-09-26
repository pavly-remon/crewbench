import { open } from "node:fs/promises";
import { CrewbenchEventSchema, type CrewbenchEvent } from "@crewbench/contract";

/** Per-file incremental read state: the byte offset already consumed, and
 * a possibly-partial trailing line left over from the last read (a writer
 * can be mid-append when this reads, per events.md's own note that a
 * torn/partial last line is expected after a crash -- the same tolerance
 * applies here mid-write, not just after one). */
export interface TailState {
  offset: number;
  partial: string;
}

export function initialTailState(): TailState {
  return { offset: 0, partial: "" };
}

/** Reads only the bytes appended to `path` since `state.offset`, splits
 * them into complete lines (holding back an incomplete trailing line for
 * the next call), and parses each complete line as a `CrewbenchEvent`.
 * A line that isn't valid JSON or doesn't match the event schema is
 * skipped, not thrown -- the same "torn line from a crash mid-write"
 * tolerance `readEvents`-style readers elsewhere in this codebase already
 * assume, and it means one malformed line can never wedge the tail.
 * Returns the parsed events plus the new `TailState` to pass on the next
 * call. If the file doesn't exist yet (a task with no events.jsonl at
 * all, or not created yet), returns no events and the same state
 * unchanged. */
export async function tailNewEvents(path: string, state: TailState): Promise<{ events: CrewbenchEvent[]; state: TailState }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { events: [], state };
  }
  try {
    const stat = await handle.stat();
    if (stat.size < state.offset) {
      // The file shrank -- most likely truncated/replaced out from under
      // us. Re-read from the start rather than erroring, since a
      // shrunk-but-still-present events.jsonl is a real (if unusual)
      // possibility this reader shouldn't crash on.
      state = initialTailState();
    }
    if (stat.size === state.offset) {
      return { events: [], state };
    }
    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);
    const chunk = state.partial + buffer.toString("utf-8");
    const lines = chunk.split("\n");
    const partial = lines.pop() ?? ""; // last element is "" if chunk ended in \n, or an incomplete line otherwise
    const events: CrewbenchEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = CrewbenchEventSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) events.push(parsed.data);
      } catch {
        continue;
      }
    }
    return { events, state: { offset: stat.size, partial } };
  } finally {
    await handle.close();
  }
}
