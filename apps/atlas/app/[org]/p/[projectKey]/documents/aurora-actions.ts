"use server";

import { saveDraftDocument } from "@xos/data/ai";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Saves a governance draft Aurora wrote (B15, G-240) as a project document, as the viewer: the
 * documents policy (knowledge.document.write on the project) decides the row, and the Markdown file
 * becomes the first version once it scans Clean. Its first line is the AI label with the date and
 * the person who reviewed it (legal/ai-features-notice.md section 7).
 */
export async function saveGovernanceDraftAction(input: {
  readonly org: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly title: string;
  readonly body: string;
}): Promise<
  | { readonly ok: true; readonly documentId: string }
  | { readonly ok: false; readonly error: string }
> {
  const ctx = await getOrgContext(input.org);
  const t = await getTranslate();
  if (!ctx) return { ok: false, error: t("aurora.entry.governance.saveFailed") };
  const title = input.title.trim();
  if (title === "" || input.body.trim() === "")
    return { ok: false, error: t("aurora.entry.governance.saveEmpty") };
  const today = new Intl.DateTimeFormat(await getLocale(), { dateStyle: "long" }).format(
    new Date(),
  );
  const label = t("aurora.entry.governance.label", {
    date: today,
    person: ctx.viewer.person?.fullName ?? ctx.viewer.email ?? "",
  });
  const result = await saveDraftDocument(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: input.projectId,
    title,
    markdown: `${label}\n\n# ${title}\n\n${input.body.trim()}\n`,
  });
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error.kind === "refusal"
          ? result.error.message
          : t("aurora.entry.governance.saveFailed"),
    };
  }
  if (/^[A-Z][A-Z0-9]{1,9}$/.test(input.projectKey))
    revalidatePath(`/${ctx.org.slug}/p/${input.projectKey}`, "layout");
  return { ok: true, documentId: result.data.documentId };
}
