/** Tokenize a gate command string into argv, the way it needs to run
 * without a shell (child_process.spawn(..., {shell: false})). Ported
 * field-for-field from crewbench_gate.py's _split(), including the fix it
 * documents: tokenizing with POSIX escaping rules mangles a Windows path
 * (backslash treated as an escape char); tokenizing without POSIX rules
 * preserves backslashes but leaves the literal quote characters in each
 * token. This implementation does what the Python fix does -- split on
 * whitespace outside quotes, treat backslash as a literal character
 * always, then strip one matching pair of leading/trailing quote
 * characters from each token afterward. */
export function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let hasToken = false;

  for (const ch of command) {
    if (inQuote) {
      current += ch;
      hasToken = true;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);

  return tokens.map(stripOneQuotePair);
}

function stripOneQuotePair(token: string): string {
  if (token.length >= 2 && token[0] === token[token.length - 1] && (token[0] === '"' || token[0] === "'")) {
    return token.slice(1, -1);
  }
  return token;
}
