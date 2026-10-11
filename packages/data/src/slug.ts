/**
 * Org slug rules (organizations_slug_format, migration 0202), free of client dependencies so forms
 * can suggest and check slugs in the browser. The database still decides.
 */

/** Whether a value has the org slug format (organizations_slug_format); the RPC still decides. */
export function isOrgSlug(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length >= 2 && value.length <= 48;
}

/** A slug suggestion from an org name: lowercase, hyphenated, 2 to 48 characters. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : "";
}
