/** Ported field-for-field from crewbench_dispatch.py's
 * SANDBOX_ERROR_SIGNATURES / classify_sandbox_error(). Best-effort pattern
 * matching a raw child error against a typical sandbox-failure signature --
 * not a guarantee. */
const SANDBOX_ERROR_SIGNATURES: [RegExp, string][] = [
  [
    /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|network is unreachable/i,
    "the host sandbox likely blocks network — the child CLI can't reach its API",
  ],
  [
    /\bEACCES\b|permission denied.*\.(claude|codex|gemini|copilot)/i,
    "the host sandbox likely blocks writing to the child CLI's config/auth directory",
  ],
  [
    /not logged in|no credentials|unauthenticated|please (run|sign in)|401 unauthorized/i,
    "the child CLI doesn't appear to be logged in",
  ],
];

export function classifySandboxError(text: string | null | undefined): string | null {
  for (const [pattern, hint] of SANDBOX_ERROR_SIGNATURES) {
    if (pattern.test(text ?? "")) return hint;
  }
  return null;
}
