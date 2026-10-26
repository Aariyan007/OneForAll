// Removes credentials from text before it leaves the server (prompts to the model provider). Sensitive FILES are
// already excluded at ingestion (.env, private keys, .npmrc); this catches secrets embedded in ordinary source files.
// Deliberately conservative: it targets recognisable credential shapes, not every long string.

const MASK = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9-]{20,}\b/g, // sk- style secret keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

// user:password@ inside connection URLs; keeps the user and host.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;

// key = "value" / key: 'value' / KEY=value where the key names a secret.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`,;]{4,})\3/gi;

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return MASK;
    });
  }
  out = out.replace(URL_PASSWORD, (_match, head: string, _password: string, at: string) => {
    count++;
    return `${head}${MASK}${at}`;
  });
  out = out.replace(ASSIGNMENT, (match, key: string, sep: string, quote: string, value: string) => {
    if (value === MASK || /^\d+$/.test(value)) return match; // already masked, or a number such as a length setting
    count++;
    return `${key}${sep}${quote}${MASK}${quote}`;
  });
  return { text: out, count };
}
