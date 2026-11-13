/**
 * A canon GL account's name in the request's language (crawl 4.9: es-US reports read
 * "Expense · Environment · 5400"). xpms.dim_gl_account holds the English name and xpms.canon_labels
 * has no es-US glAccount labels yet, so the app catalog carries them under `reports.glAccounts.<code>`;
 * an account the catalog does not know keeps its canon name. The code is never translated.
 */
export function glAccountName(
  code: string,
  canonName: string | undefined,
  t: (key: string) => string,
  has: (key: string) => boolean,
): string {
  const key = `reports.glAccounts.${code}`;
  return has(key) ? t(key) : (canonName ?? code);
}
