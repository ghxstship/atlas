import type { LanguageSetting } from "@/i18n/negotiate";
import { getOrgWorkspaces } from "./active-workspace";
import { getOrgContext } from "./context";
import { getShellSettings } from "./org-settings";

/**
 * locale.language as resolved for the viewer in the org a route names, through the same per-request reads
 * the shell makes (membership, workspace filter, resolved settings); null when the viewer is not a member.
 */
export async function orgLanguage(slug: string): Promise<LanguageSetting | null> {
  const ctx = await getOrgContext(slug);
  if (!ctx) return null;
  const { active } = await getOrgWorkspaces(ctx.viewer.db, ctx.org.id);
  return (await getShellSettings(ctx.viewer.db, ctx.org.id, active?.id ?? null)).language;
}
