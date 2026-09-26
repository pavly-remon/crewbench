import type { Issue, PreviousIssueStatus, RawIssue, RegisteredIssue } from "./types.js";

/** Assigns stable ids to this round's raw issues -- "R<round>-<n>", per
 * schemas/code-reviewer.json's documented convention (e.g. "R1-3" = round
 * 1, 3rd issue). The engine assigns these, not the reviewer -- the
 * reviewer's own briefs ask it to number issues this way, but the engine
 * is the source of truth (a role that gets it wrong is corrected here). */
export function assignIssueIds(round: number, rawIssues: RawIssue[]): Issue[] {
  return rawIssues.map((issue, index) => ({ ...issue, id: `R${round}-${index + 1}` }));
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

export type MatchMethod = "id" | "file+category+title" | "unmatched";

export interface MatchedPreviousIssue {
  registryEntry: RegisteredIssue;
  status: "resolved" | "still_present";
  method: MatchMethod;
}

/** Matches this round's `previous_issues[]` (the reviewer's resolved/
 * still_present verdicts on prior rounds' issues) back to the engine's
 * registry entries. Ported from docs/app/phase-1-plan.md's milestone 3
 * description: "matched by id first, falling back to file + category +
 * similar title ... record which matching method was used" -- the engine
 * never trusts a role's self-reported id blindly, since a role echoing
 * the wrong id (or a new CLI/model that doesn't follow the convention as
 * precisely) shouldn't silently lose an issue's history. */
export function matchPreviousIssues(
  registry: RegisteredIssue[],
  previousIssues: PreviousIssueStatus[],
): MatchedPreviousIssue[] {
  const openRegistry = registry.filter((entry) => entry.status !== "resolved");
  const matched: MatchedPreviousIssue[] = [];
  const claimedIds = new Set<string>();

  for (const reported of previousIssues) {
    const byId = openRegistry.find((entry) => entry.id === reported.id && !claimedIds.has(entry.id));
    if (byId) {
      claimedIds.add(byId.id);
      matched.push({ registryEntry: byId, status: reported.status, method: "id" });
      continue;
    }
    // Fallback: file + category + similar title (the reviewer's `note`
    // stands in for a "title" -- there's no separate title field).
    const candidates = openRegistry.filter((entry) => !claimedIds.has(entry.id));
    let best: { entry: RegisteredIssue; score: number } | null = null;
    for (const entry of candidates) {
      const score = titleSimilarity(entry.change, reported.note);
      if (score > 0.3 && (!best || score > best.score)) best = { entry, score };
    }
    if (best) {
      claimedIds.add(best.entry.id);
      matched.push({ registryEntry: best.entry, status: reported.status, method: "file+category+title" });
    }
  }
  return matched;
}

/** Advances the registry to a new round: adds this round's freshly-id'd
 * issues as new `open` entries, and applies matchPreviousIssues()'s
 * verdicts to existing ones (resolved -> "resolved",
 * still_present -> "still_present" with consecutiveStillPresent
 * incremented -- stuckDetection() reads that counter). An entry with no
 * verdict this round (the reviewer didn't mention it) keeps its previous
 * status unchanged, neither resolved nor counted toward the oscillation
 * streak. */
export function updateRegistry(
  registry: RegisteredIssue[],
  round: number,
  newIssues: Issue[],
  matchedPrevious: MatchedPreviousIssue[],
): RegisteredIssue[] {
  const updated = registry.map((entry) => {
    const match = matchedPrevious.find((m) => m.registryEntry.id === entry.id);
    if (!match) return entry;
    if (match.status === "resolved") {
      return { ...entry, status: "resolved" as const, consecutiveStillPresent: 0 };
    }
    return {
      ...entry,
      status: "still_present" as const,
      consecutiveStillPresent: entry.consecutiveStillPresent + 1,
    };
  });
  const added: RegisteredIssue[] = newIssues.map((issue) => ({
    id: issue.id,
    firstSeenRound: round,
    file: issue.file,
    category: issue.category,
    severity: issue.severity,
    change: issue.change,
    status: "open",
    consecutiveStillPresent: 0,
  }));
  return [...updated, ...added];
}
