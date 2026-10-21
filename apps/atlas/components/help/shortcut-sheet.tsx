"use client";

import { fillRoute, getNode } from "@xos/ia";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { Keys } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { clientSitemap } from "@/ia/sitemap.client.generated";
import { useShellKeys } from "@/components/shell/shell-keys-context";

type Translate = (key: string) => string;

/**
 * The shortcut sheet in Help (Section 11.2: `?` shows the shortcut sheet; Section 11.16). It reads the
 * shortcut registry (packages/schemas/shortcuts.yaml) for the groups and labels and the person's own
 * keys from the shell, so it shows exactly what the keys do for them, on their platform. Navigation
 * shortcuts to sections the person cannot open, and shortcuts they left without keys, are not listed.
 */
export function ShortcutSheet({ org }: { readonly org: string }) {
  const t = useTranslations() as unknown as Translate;
  const keys = useShellKeys();
  const shell = SHORTCUT_REGISTRY.shells.atlas;
  const route = getNode(clientSitemap, "me.keyboard-shortcuts").node.route;
  return (
    <div className="flex flex-col gap-12">
      {shell.groups.map((group) => {
        const rows = shell.shortcuts.filter((s) => s.group === group.id && keys.display[s.id]);
        if (rows.length === 0) return null;
        return (
          <section
            key={group.id}
            aria-labelledby={`help-shortcuts-${group.id}`}
            className="flex flex-col gap-4"
          >
            <h4
              id={`help-shortcuts-${group.id}`}
              className="m-0 text-text-11 font-medium text-text-secondary"
            >
              {t(group.label)}
            </h4>
            <dl className="m-0 flex flex-col gap-4">
              {rows.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-8">
                  <dt>{t(s.label)}</dt>
                  <dd className="m-0">
                    <Keys keys={keys.display[s.id] ?? ""} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      {route ? (
        <Link
          href={fillRoute(route, { org }) as Route}
          className="self-start text-text-12 font-medium text-accent-text underline"
        >
          {t("help.shortcuts.customize")}
        </Link>
      ) : null}
    </div>
  );
}
