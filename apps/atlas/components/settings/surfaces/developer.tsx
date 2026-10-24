import { getSubscription, listMembers, listRoleCapabilities, listRoles } from "@xos/data";
import {
  capabilityGroupsOf,
  listApiKeys,
  listCapabilityGroups,
  listPersonalTokens,
  listServiceAccounts,
  orgAllowsPersonalTokens,
  type PersonalToken,
} from "@xos/data/developer";
import { listEventTypes, listWebhookDeliveries, listWebhookEndpoints } from "@xos/data/webhooks";
import { InlineAlert } from "@/components/ui";
import {
  createApiKeyAction,
  createPersonalTokenAction,
  createServiceAccountAction,
  createWebhookAction,
  removeWebhookAction,
  replayDeliveryAction,
  retireServiceAccountAction,
  revokeApiKeyAction,
  revokePersonalTokenAction,
  toggleWebhookAction,
} from "@/app/[org]/settings/surface-actions";
import { planHasFeature } from "@/lib/settings/plan";
import type { OrgContext } from "@/lib/shell/context";
import type { SettingsPanelProps } from "../contributions/types";
import { SurfaceButton, SurfaceForm, type SecretCopy } from "./forms";
import {
  Chip,
  Code,
  expiryOptions,
  hasExpired,
  shownPrefix,
  formatters,
  LoadFailed,
  P,
  Quiet,
  Rows,
  Section,
  Subsection,
  TextLink,
  type Formatters,
} from "./kit";

/**
 * API access panels (A86, RRR-131, finding A65-004):
 *   Settings, API Keys and Service Accounts   service accounts, org API keys (Section 4.5.6 org item 33) and the
 *                                             personal tokens members hold in the org
 *   Settings, Webhooks                        endpoints, recent deliveries and replay (item 34, Section 10.1)
 *   Personal settings, Developer              the member's own personal API tokens (personal item 15)
 * Keys, tokens and webhook signing secrets are shown once, right after creation.
 */

function secretCopy(f: Formatters, kind: "key" | "token" | "webhook"): SecretCopy {
  return {
    title: f.t(`${P}.secret.${kind}.title`),
    body: f.t(`${P}.secret.${kind}.body`),
    field: f.t(`${P}.secret.${kind}.field`),
    copy: f.t(`${P}.secret.copy`),
    copied: f.t(`${P}.secret.copied`),
  };
}

/** A capability group in plain words, as the consent screen names it (Section 11.10 item 2). */
function scopeLabel(f: Formatters, group: string): string {
  return f.t(`authSecurity.scopes.${group}`);
}

function scopeOptions(f: Formatters, groups: readonly string[]) {
  return groups.map((g) => ({ value: g, label: scopeLabel(f, g) }));
}

function scopeList(f: Formatters, groups: readonly string[]): string {
  return f.t(`${P}.scopesList`, { scopes: groups.map((g) => scopeLabel(f, g)).join(", ") });
}

function confirm(f: Formatters, key: string, values: Record<string, string> = {}) {
  return {
    title: f.t(`${P}.${key}.title`, values),
    body: f.t(`${P}.${key}.body`, values),
    confirmLabel: f.t(`${P}.${key}.confirm`),
    cancelLabel: f.t(`${P}.cancel`),
  };
}

async function hasPlanFeature(ctx: OrgContext, feature: string): Promise<boolean> {
  const subscription = await getSubscription(ctx.viewer.db, ctx.org.id);
  return subscription.ok && planHasFeature(subscription.data.planCode, feature);
}

function NotInPlan({
  f,
  slug,
  feature,
}: {
  f: Formatters;
  slug: string;
  feature: "apiKeys" | "webhooks";
}) {
  return (
    <InlineAlert tone="info">
      {f.t(`${P}.plan.${feature}`)}{" "}
      <TextLink href={`/${slug}/settings/billing-and-plan`}>{f.t(`${P}.plan.billing`)}</TextLink>
    </InlineAlert>
  );
}

// Service accounts -----------------------------------------------------------------------------------------

export async function ServiceAccountsPanel({ ctx }: SettingsPanelProps) {
  const [f, accounts, roles, inPlan] = await Promise.all([
    formatters(ctx),
    listServiceAccounts(ctx.viewer.db, ctx.org.id),
    listRoles(ctx.viewer.db, ctx.org.id),
    hasPlanFeature(ctx, "api_keys"),
  ]);
  if (!accounts.ok || !roles.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.api_keys.manage");
  const roleOptions = roles.data
    .filter((r) => r.band > 1)
    .map((r) => ({
      value: r.id,
      label: r.system ? f.t(`shell.roles.${r.code}`) : (r.name ?? r.code),
    }));
  return (
    <Section
      id="service-accounts"
      title={f.t(`${P}.serviceAccounts.title`)}
      description={f.t(`${P}.serviceAccounts.description`)}
    >
      {!inPlan ? <NotInPlan f={f} slug={ctx.org.slug} feature="apiKeys" /> : null}
      {accounts.data.length === 0 ? (
        <Quiet>{f.t(`${P}.serviceAccounts.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.serviceAccounts.title`)}
          rows={accounts.data.map((a) => ({
            id: a.id,
            title: a.name,
            meta: [
              f.t(`${P}.serviceAccounts.created`, { date: f.day(a.createdAt) }),
              a.expiresAt
                ? f.t(`${P}.expiry.until`, { date: f.day(a.expiresAt) })
                : f.t(`${P}.expiry.never`),
            ],
            actions: canEdit ? (
              <SurfaceButton
                action={retireServiceAccountAction}
                hidden={{ org: ctx.org.slug, id: a.id }}
                label={f.t(`${P}.serviceAccounts.retire`)}
                confirm={confirm(f, "serviceAccounts.retireConfirm", { name: a.name })}
              />
            ) : undefined,
          }))}
        />
      )}
      {canEdit && inPlan ? (
        <Subsection title={f.t(`${P}.serviceAccounts.add`)}>
          <SurfaceForm
            id="service-account-create"
            action={createServiceAccountAction}
            label={f.t(`${P}.serviceAccounts.add`)}
            hidden={{ org: ctx.org.slug }}
            submitLabel={f.t(`${P}.serviceAccounts.addSubmit`)}
            doneLabel={f.t(`${P}.serviceAccounts.added`)}
            fields={[
              {
                kind: "text",
                name: "name",
                label: f.t(`${P}.fields.name`),
                required: true,
                maxLength: 200,
              },
              {
                kind: "select",
                name: "roleId",
                label: f.t(`${P}.serviceAccounts.role`),
                help: f.t(`${P}.serviceAccounts.roleHelp`),
                options: roleOptions,
                prompt: f.t(`${P}.choose`),
              },
              {
                kind: "select",
                name: "expiresIn",
                label: f.t(`${P}.fields.expires`),
                options: [{ value: "", label: f.t(`${P}.expiry.never`) }, ...expiryOptions(f.t)],
                defaultValue: "",
              },
            ]}
          />
        </Subsection>
      ) : null}
    </Section>
  );
}

// Org API keys ---------------------------------------------------------------------------------------------

export async function ApiKeysPanel({ ctx }: SettingsPanelProps) {
  const [f, keys, accounts, groups, inPlan] = await Promise.all([
    formatters(ctx),
    listApiKeys(ctx.viewer.db, ctx.org.id),
    listServiceAccounts(ctx.viewer.db, ctx.org.id),
    listCapabilityGroups(ctx.viewer.db),
    hasPlanFeature(ctx, "api_keys"),
  ]);
  if (!keys.ok || !accounts.ok || !groups.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.api_keys.manage");
  const accountName = (id: string | null) =>
    id === null
      ? f.t(`${P}.apiKeys.noAccount`)
      : (accounts.data.find((a) => a.id === id)?.name ?? f.t(`${P}.apiKeys.retiredAccount`));
  return (
    <Section
      id="api-keys"
      title={f.t(`${P}.apiKeys.title`)}
      description={f.t(`${P}.apiKeys.description`)}
    >
      {keys.data.length === 0 ? (
        <Quiet>{f.t(`${P}.apiKeys.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.apiKeys.title`)}
          rows={keys.data.map((k) => ({
            id: k.id,
            title: (
              <>
                {k.name}
                {k.revokedAt ? (
                  <Chip tone="danger">{f.t(`${P}.revoked`)}</Chip>
                ) : hasExpired(k.expiresAt) ? (
                  <Chip tone="warning">{f.t(`${P}.expired`)}</Chip>
                ) : (
                  <Chip tone="success">{f.t(`${P}.active`)}</Chip>
                )}
              </>
            ),
            meta: [
              <Code key="p">{shownPrefix(k.prefix)}</Code>,
              f.t(`${P}.apiKeys.actsAs`, { account: accountName(k.serviceAccountId) }),
              scopeList(f, k.scopes),
              f.t(`${P}.expiry.until`, { date: f.day(k.expiresAt) }),
              k.lastUsedAt
                ? f.t(`${P}.lastUsed`, { date: f.when(k.lastUsedAt) })
                : f.t(`${P}.neverUsed`),
            ],
            actions:
              canEdit && !k.revokedAt ? (
                <SurfaceButton
                  action={revokeApiKeyAction}
                  hidden={{ org: ctx.org.slug, id: k.id }}
                  label={f.t(`${P}.revoke`)}
                  confirm={confirm(f, "apiKeys.revokeConfirm", { name: k.name })}
                />
              ) : undefined,
          }))}
        />
      )}
      {canEdit && inPlan ? (
        <Subsection title={f.t(`${P}.apiKeys.add`)}>
          {accounts.data.length === 0 ? (
            <Quiet>{f.t(`${P}.apiKeys.needsAccount`)}</Quiet>
          ) : (
            <SurfaceForm
              id="api-key-create"
              action={createApiKeyAction}
              label={f.t(`${P}.apiKeys.add`)}
              hidden={{ org: ctx.org.slug }}
              submitLabel={f.t(`${P}.apiKeys.addSubmit`)}
              secret={secretCopy(f, "key")}
              fields={[
                {
                  kind: "text",
                  name: "name",
                  label: f.t(`${P}.fields.name`),
                  required: true,
                  maxLength: 200,
                },
                {
                  kind: "select",
                  name: "serviceAccountId",
                  label: f.t(`${P}.apiKeys.account`),
                  options: accounts.data.map((a) => ({ value: a.id, label: a.name })),
                  defaultValue: accounts.data[0]?.id ?? "",
                },
                {
                  kind: "select",
                  name: "expiresIn",
                  label: f.t(`${P}.fields.expires`),
                  options: expiryOptions(f.t),
                  defaultValue: "90",
                },
                {
                  kind: "checkboxes",
                  name: "scopes",
                  label: f.t(`${P}.fields.scopes`),
                  help: f.t(`${P}.apiKeys.scopesHelp`),
                  options: scopeOptions(f, groups.data),
                },
              ]}
            />
          )}
        </Subsection>
      ) : null}
    </Section>
  );
}

// Personal tokens --------------------------------------------------------------------------------------------

function tokenRows(
  f: Formatters,
  tokens: readonly PersonalToken[],
  revoke: (t: PersonalToken) => boolean,
  slug: string,
  showOwner?: (t: PersonalToken) => string,
) {
  return tokens.map((tok) => ({
    id: tok.id,
    title: (
      <>
        {tok.name}
        {tok.revokedAt ? (
          <Chip tone="danger">{f.t(`${P}.revoked`)}</Chip>
        ) : hasExpired(tok.expiresAt) ? (
          <Chip tone="warning">{f.t(`${P}.expired`)}</Chip>
        ) : (
          <Chip tone="success">{f.t(`${P}.active`)}</Chip>
        )}
      </>
    ),
    meta: [
      <Code key="p">{shownPrefix(tok.prefix)}</Code>,
      showOwner ? showOwner(tok) : null,
      scopeList(f, tok.scopes),
      f.t(`${P}.expiry.until`, { date: f.day(tok.expiresAt) }),
      tok.lastUsedAt
        ? f.t(`${P}.lastUsed`, { date: f.when(tok.lastUsedAt) })
        : f.t(`${P}.neverUsed`),
    ],
    actions:
      revoke(tok) && !tok.revokedAt ? (
        <SurfaceButton
          action={revokePersonalTokenAction}
          hidden={{ org: slug, id: tok.id }}
          label={f.t(`${P}.revoke`)}
          confirm={confirm(f, "tokens.revokeConfirm", { name: tok.name })}
        />
      ) : undefined,
  }));
}

/** On the org's API page: every member's personal token, so an admin can revoke one. */
export async function OrgPersonalTokensPanel({ ctx }: SettingsPanelProps) {
  const [f, tokens, allowed] = await Promise.all([
    formatters(ctx),
    listPersonalTokens(ctx.viewer.db, { orgId: ctx.org.id }),
    orgAllowsPersonalTokens(ctx.viewer.db, ctx.org.id),
  ]);
  if (!tokens.ok || !allowed.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.api_keys.manage");
  const members = await listMembers(ctx.viewer.db, ctx.org.id);
  const owner = (tok: PersonalToken) =>
    f.t(`${P}.tokens.owner`, {
      name:
        (members.ok ? members.data.find((m) => m.personId === tok.personId)?.fullName : null) ??
        f.t(`${P}.someone`),
    });
  return (
    <Section
      id="org-personal-tokens"
      title={f.t(`${P}.tokens.orgTitle`)}
      description={f.t(allowed.data ? `${P}.tokens.orgOn` : `${P}.tokens.orgOff`)}
    >
      {tokens.data.length === 0 ? (
        <Quiet>{f.t(`${P}.tokens.orgNone`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.tokens.orgTitle`)}
          rows={tokenRows(f, tokens.data, () => canEdit, ctx.org.slug, owner)}
        />
      )}
    </Section>
  );
}

/** Personal settings, Developer: the member's own tokens for this org and a form for a new one. */
export async function MyTokensPanel({ ctx }: SettingsPanelProps) {
  const personId = ctx.viewer.person?.id ?? "";
  const [f, tokens, allowed, held] = await Promise.all([
    formatters(ctx),
    listPersonalTokens(ctx.viewer.db, { personId, orgId: ctx.org.id }),
    orgAllowsPersonalTokens(ctx.viewer.db, ctx.org.id),
    listRoleCapabilities(
      ctx.viewer.db,
      ctx.org.roles.map((r) => r.id),
    ),
  ]);
  if (!tokens.ok || !allowed.ok || !held.ok) return <LoadFailed t={f.t} />;
  const groups = capabilityGroupsOf(held.data.keys());
  return (
    <Section
      id="my-tokens"
      title={f.t(`${P}.tokens.title`)}
      description={f.t(`${P}.tokens.description`)}
    >
      {tokens.data.length === 0 ? (
        <Quiet>{f.t(`${P}.tokens.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.tokens.title`)}
          rows={tokenRows(f, tokens.data, () => true, ctx.org.slug)}
        />
      )}
      {allowed.data ? (
        <Subsection title={f.t(`${P}.tokens.add`)}>
          <SurfaceForm
            id="personal-token-create"
            action={createPersonalTokenAction}
            label={f.t(`${P}.tokens.add`)}
            hidden={{ org: ctx.org.slug }}
            submitLabel={f.t(`${P}.tokens.addSubmit`)}
            secret={secretCopy(f, "token")}
            fields={[
              {
                kind: "text",
                name: "name",
                label: f.t(`${P}.fields.name`),
                required: true,
                maxLength: 200,
              },
              {
                kind: "select",
                name: "expiresIn",
                label: f.t(`${P}.fields.expires`),
                options: expiryOptions(f.t),
                defaultValue: "90",
              },
              {
                kind: "checkboxes",
                name: "scopes",
                label: f.t(`${P}.fields.scopes`),
                help: f.t(`${P}.tokens.scopesHelp`),
                options: scopeOptions(f, groups),
              },
            ]}
          />
        </Subsection>
      ) : (
        <InlineAlert tone="info">{f.t(`${P}.tokens.off`)}</InlineAlert>
      )}
    </Section>
  );
}

// Webhooks ---------------------------------------------------------------------------------------------------

export async function WebhooksPanel({ ctx }: SettingsPanelProps) {
  const [f, endpoints, events, deliveries, inPlan] = await Promise.all([
    formatters(ctx),
    listWebhookEndpoints(ctx.viewer.db, ctx.org.id),
    listEventTypes(ctx.viewer.db),
    listWebhookDeliveries(ctx.viewer.db, ctx.org.id, 20),
    hasPlanFeature(ctx, "webhooks"),
  ]);
  if (!endpoints.ok || !events.ok || !deliveries.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.webhooks.manage");
  const endpointUrl = (id: string) => endpoints.data.find((e) => e.id === id)?.url ?? "";
  return (
    <>
      <Section
        id="webhooks"
        title={f.t(`${P}.webhooks.title`)}
        description={f.t(`${P}.webhooks.description`)}
      >
        {!inPlan ? <NotInPlan f={f} slug={ctx.org.slug} feature="webhooks" /> : null}
        {!canEdit ? <Quiet>{f.t(`${P}.webhooks.needsCapability`)}</Quiet> : null}
        {canEdit && endpoints.data.length === 0 ? <Quiet>{f.t(`${P}.webhooks.none`)}</Quiet> : null}
        {endpoints.data.length > 0 ? (
          <Rows
            label={f.t(`${P}.webhooks.title`)}
            rows={endpoints.data.map((e) => ({
              id: e.id,
              title: (
                <>
                  <span className="break-all">{e.url}</span>
                  {e.disabledAt ? (
                    <Chip tone="warning">{f.t(`${P}.webhooks.paused`)}</Chip>
                  ) : (
                    <Chip tone="success">{f.t(`${P}.active`)}</Chip>
                  )}
                </>
              ),
              meta: [
                e.description,
                f.t(`${P}.webhooks.events`, {
                  count: e.events.length,
                  events: e.events.join(", "),
                }),
              ],
              actions: canEdit ? (
                <>
                  <SurfaceButton
                    action={toggleWebhookAction}
                    hidden={{ org: ctx.org.slug, id: e.id, disable: e.disabledAt ? "" : "on" }}
                    label={f.t(e.disabledAt ? `${P}.webhooks.resume` : `${P}.webhooks.pause`)}
                  />
                  <SurfaceButton
                    action={removeWebhookAction}
                    hidden={{ org: ctx.org.slug, id: e.id }}
                    label={f.t(`${P}.remove`)}
                    confirm={confirm(f, "webhooks.removeConfirm", { url: e.url })}
                  />
                </>
              ) : undefined,
            }))}
          />
        ) : null}
        {canEdit && inPlan ? (
          <Subsection title={f.t(`${P}.webhooks.add`)}>
            <SurfaceForm
              id="webhook-create"
              action={createWebhookAction}
              label={f.t(`${P}.webhooks.add`)}
              hidden={{ org: ctx.org.slug }}
              submitLabel={f.t(`${P}.webhooks.addSubmit`)}
              secret={secretCopy(f, "webhook")}
              fields={[
                {
                  kind: "url",
                  name: "url",
                  label: f.t(`${P}.webhooks.url`),
                  help: f.t(`${P}.webhooks.urlHelp`),
                  required: true,
                  maxLength: 2000,
                },
                {
                  kind: "text",
                  name: "description",
                  label: f.t(`${P}.fields.description`),
                  maxLength: 300,
                },
                {
                  kind: "checkboxes",
                  name: "events",
                  label: f.t(`${P}.webhooks.eventTypes`),
                  options: events.data.map((e) => ({ value: e.code, label: e.code })),
                },
              ]}
            />
          </Subsection>
        ) : null}
      </Section>
      {canEdit ? (
        <Section
          id="webhook-deliveries"
          title={f.t(`${P}.deliveries.title`)}
          description={f.t(`${P}.deliveries.description`)}
        >
          {deliveries.data.length === 0 ? (
            <Quiet>{f.t(`${P}.deliveries.none`)}</Quiet>
          ) : (
            <Rows
              label={f.t(`${P}.deliveries.title`)}
              rows={deliveries.data.map((d) => ({
                id: d.id,
                title: (
                  <>
                    <span className="break-all">{endpointUrl(d.endpointId)}</span>
                    <Chip
                      tone={
                        d.status === "Delivered"
                          ? "success"
                          : d.status === "Expired"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {f.t(`${P}.deliveries.status.${d.status}`)}
                    </Chip>
                  </>
                ),
                meta: [
                  f.when(d.createdAt),
                  f.t(`${P}.deliveries.attempts`, { count: d.attempts }),
                  d.lastResponseStatus !== null
                    ? f.t(`${P}.deliveries.response`, { status: d.lastResponseStatus })
                    : null,
                  d.replay ? f.t(`${P}.deliveries.replay`) : null,
                ],
                actions: (
                  <SurfaceButton
                    action={replayDeliveryAction}
                    hidden={{ org: ctx.org.slug, id: d.id }}
                    label={f.t(`${P}.deliveries.send`)}
                  />
                ),
              }))}
            />
          )}
        </Section>
      ) : null}
    </>
  );
}
