import { listEnabledAiFeatures, type AiFeature } from "@xos/data/ai";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The Aurora features the viewer may use in this org now: turned on in Settings, AI Features and
 * included in the plan (app.ai_enabled_features, migration 0650). Read once per request; the shell
 * hands it to every client entry point (A95, finding A65-020), and server pages read the same cached
 * answer, so an entry point is absent from the first paint when its switch is off. A failed read
 * hides every entry point and is logged: Aurora is never offered when we cannot tell it is allowed.
 */
export const getAiFeatures = cache(async (ctx: OrgContext): Promise<readonly AiFeature[]> => {
  const result = await listEnabledAiFeatures(ctx.viewer.db, ctx.org.id);
  if (result.ok) return result.data;
  console.error("Cannot read the enabled AI features; hiding every AI entry point", result.error);
  return [];
});

/** Whether one feature's entry points show for the viewer. */
export async function aiFeatureOn(ctx: OrgContext, feature: AiFeature): Promise<boolean> {
  return (await getAiFeatures(ctx)).includes(feature);
}
