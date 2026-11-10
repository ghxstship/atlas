import { getSubscription } from "@xos/data";
import {
  asDbClient,
  listConnections,
  providerEntry,
  providersIn,
  scopesFor,
  isProviderCode,
  usesClientCredentials,
} from "@xos/integrations";
import {
  IntegrationsSettings,
  type ConnectionView,
  type IntegrationsCopy,
} from "@xos/integrations/settings";
import { getLocale, getTranslations } from "next-intl/server";
import { StoragePicker } from "@/components/lazy-ui/storage-picker";
import { InlineAlert } from "@/components/ui";
import { connectStorageAction } from "@/lib/integrations/storage-actions";
import { storageOAuthClient } from "@/lib/integrations/storage-oauth";
import { planHasFeature } from "@/lib/settings/plan";
import { getTranslate } from "@/lib/shell/translate";
import {
  createIntegrationAction,
  storeIntegrationCredentialAction,
  syncIntegrationAction,
  transitionIntegrationAction,
} from "./a19-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A19's panel on Settings > Integrations (Section 17): the org's connections with their state, last
 * sync and last error, the credential form (stored in Vault, never shown again; UPS and FedEx take their
 * developer app's client ID and secret, from which the connector mints access tokens), connect, pause,
 * resume and disconnect, sync now, and adding a connection from the catalog. It reads with the
 * viewer's client, so row level security decides what appears; people without
 * org.integrations.manage see the connections read-only.
 */

const COPY_KEYS = [
  "empty",
  "emptyAction",
  "readOnly",
  "addHeading",
  "provider",
  "providerHelp",
  "planGated",
  "name",
  "nameHelp",
  "add",
  "added",
  "saved",
  "lastSynced",
  "neverSynced",
  "lastError",
  "credentialHeading",
  "secret",
  "secretHelp",
  "kind",
  "kindOAuth",
  "kindKey",
  "kindServiceAccount",
  "clientId",
  "clientSecret",
  "clientSecretHelp",
  "storeCredential",
  "connect",
  "pause",
  "resume",
  "reconnect",
  "disconnect",
  "scope",
  "syncNow",
  "queued",
  "connectionsLabel",
] as const satisfies readonly (keyof IntegrationsCopy)[];

async function IntegrationsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [connections, subscription, locale] = await Promise.all([
    listConnections(asDbClient(ctx.viewer.db)),
    getSubscription(ctx.viewer.db, ctx.org.id),
    getLocale(),
  ]);
  const canManage = ctx.capabilities.has("org.integrations.manage");
  if (!subscription.ok || (!connections.ok && connections.error.kind !== "not-found")) {
    return <InlineAlert tone="danger">{t("integrations.settings.loadFailed")}</InlineAlert>;
  }
  const rows = connections.ok ? connections.data : [];
  // B16 (ADR 0155 D5): Google Drive and OneDrive sign in, and an Admin chooses the folder writers link from.
  const s = (await getTranslations("storageLinks")) as unknown as (key: string) => string;
  const signIn = (code: string): ConnectionView["oauth"] => {
    if (code !== "google_drive" && code !== "onedrive_sharepoint") return undefined;
    const google = code === "google_drive";
    return {
      label: s(google ? "connectGoogle" : "connectMicrosoft"),
      disabledReason:
        storageOAuthClient(code) === null
          ? s(google ? "notSetUpGoogle" : "notSetUpMicrosoft")
          : null,
    };
  };
  const linkingFolder = (c: (typeof rows)[number]) => {
    if (!canManage || c.connection_state !== "Connected") return undefined;
    if (c.provider_code !== "google_drive" && c.provider_code !== "onedrive_sharepoint")
      return undefined;
    const root =
      typeof c.provider_settings["link_root_id"] === "string"
        ? c.provider_settings["link_root_id"]
        : null;
    return (
      <details className="flex flex-col gap-8" data-testid="linking-folder">
        <summary className="cursor-pointer text-label-13 font-medium">
          {s("linkingFolder")}: {root ?? s("linkingFolderNone")}
        </summary>
        <p className="m-0 text-text-12 text-text-secondary">{s("linkingFolderHelp")}</p>
        <StoragePicker
          org={ctx.org.slug}
          connectionId={c.id}
          mode="admin"
          labels={{
            loading: s("pickerLoading"),
            empty: s("pickerEmpty"),
            up: s("pickerUp"),
            choose: s("pickerChoose"),
            open: s("pickerOpen"),
            useFolder: s("useFolder"),
          }}
        />
      </details>
    );
  };
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const copy = Object.fromEntries(
    COPY_KEYS.map((k) => [k, t(`integrations.settings.${k}`)]),
  ) as unknown as IntegrationsCopy;
  const providers = providersIn().map((p) => ({
    code: p.code,
    label: t(`integrations.providers.${p.code}`),
    categoryLabel: t(`integrations.categories.${p.category}`),
    available:
      p.requiredFeature === null || planHasFeature(subscription.data.planCode, p.requiredFeature),
  }));
  const views: ConnectionView[] = rows.map((c) => ({
    id: c.id,
    providerCode: c.provider_code,
    providerLabel: isProviderCode(c.provider_code)
      ? t(`integrations.providers.${c.provider_code}`)
      : c.provider_code,
    displayName: c.display_name,
    state: c.connection_state,
    stateLabel: t(`integrations.states.${c.connection_state}`),
    lastSynced: c.last_synced_at === null ? null : when.format(new Date(c.last_synced_at)),
    lastError: c.last_error_message,
    needsCredential: providerEntry(c.provider_code)?.needsCredential ?? true,
    credentialStored: c.credential_stored_at !== null,
    ...(usesClientCredentials(c.provider_code)
      ? { clientCredentialHelp: t(`integrations.clientCredentialHelp.${c.provider_code}`) }
      : {}),
    scopes: isProviderCode(c.provider_code)
      ? scopesFor(c.provider_code).map((s) => ({ value: s, label: t(`integrations.scopes.${s}`) }))
      : [],
    ...(signIn(c.provider_code) ? { oauth: signIn(c.provider_code) } : {}),
    accountName: c.external_account_name,
    ...(linkingFolder(c) ? { extra: linkingFolder(c) } : {}),
  }));
  return (
    <section aria-labelledby="integrations-heading" className="flex flex-col gap-12">
      <h2 id="integrations-heading" className="m-0 text-heading-16 font-semibold">
        {t("integrations.settings.heading")}
      </h2>
      <IntegrationsSettings
        org={ctx.org.slug}
        canManage={canManage}
        providers={providers}
        connections={views}
        copy={copy}
        actions={{
          create: createIntegrationAction,
          credential: storeIntegrationCredentialAction,
          transition: transitionIntegrationAction,
          sync: syncIntegrationAction,
          oauth: connectStorageAction,
        }}
      />
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.integrations", order: 10, Panel: IntegrationsPanel },
];
