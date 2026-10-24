"use client";

import { InlineAlert, type QuickAddResolver, type QuickAddTokenType } from "@xos/ui";
import { useTranslations } from "next-intl";
import { resolveQuickAddAction, type ResolveQuickAddInput } from "@/lib/quick-add/actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

type Resolvable = Exclude<QuickAddTokenType, "date">;

/**
 * A resolver that asks the server which people, tags, kinds and scopes a line names (Section 11.7).
 * The server answers only with what the person may see; a failed request leaves every token as text.
 */
export function quickAddResolver(
  org: string,
  scope: Omit<ResolveQuickAddInput, "tokens">,
): QuickAddResolver {
  return async (tokens) => {
    const result = await resolveQuickAddAction(org, {
      ...scope,
      tokens: tokens.flatMap((t) =>
        t.type === "date" ? [] : [{ type: t.type as Resolvable, value: t.value }],
      ),
    });
    return result.ok ? result.data : {};
  };
}

/** What a quick add save refused or failed with: the catalog sentence and the database's correction. */
export function QuickAddAlert({ error }: { error: { key: string; detail?: string } | null }) {
  const t = useTranslations() as unknown as Translate;
  if (!error) return null;
  return (
    <div>
      <InlineAlert tone="danger" title={t(error.key)}>
        {error.detail ?? t("work.errors.next")}
      </InlineAlert>
    </div>
  );
}
