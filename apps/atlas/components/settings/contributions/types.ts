import type { ReactNode } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A panel another module contributes to a settings page (ADR 0021 pattern for the settings tree).
 * Each contributor owns one file in this directory, `<agent>.tsx`, exporting `contributions`; the
 * generated index collects every file, so no contributor edits a shared list. After adding a file,
 * run `XOS_WRITE_GENERATED=1 pnpm --filter @xos/atlas exec vitest run test/settings-contributions.test.ts`;
 * the same test fails while the index is out of date.
 * The settings page renders the page header, the registry settings of the page (packages/schemas
 * settings files), then each contributed panel in `order`.
 */
export interface SettingsPanelProps {
  readonly ctx: OrgContext;
  readonly params: Readonly<Record<string, string>>;
}

export interface SettingsContribution {
  /** Sitemap node of the settings page: settings.* or me.*. */
  readonly node: string;
  /** Position among the page's panels, ascending; registry settings come first. */
  readonly order: number;
  /** Server component rendering the panel. It reads with the viewer's client, so RLS applies. */
  readonly Panel: (props: SettingsPanelProps) => Promise<ReactNode> | ReactNode;
}
