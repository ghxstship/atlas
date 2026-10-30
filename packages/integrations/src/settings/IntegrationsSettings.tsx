"use client";

import { Button, EmptyState, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useActionState, useId, type ReactNode } from "react";

/**
 * The connector settings of Atlas Settings > Integrations (Section 17), contributed to A30's settings
 * page as a panel. The server panel reads the catalog and the org's connections with the viewer's
 * client and passes finished, translated copy and server actions; this component renders the forms
 * and shows each action's outcome. Every write is decided by row level security and the RPCs of
 * migration 0600; a refusal comes back as a sentence naming the next step.
 */

export interface IntegrationActionState {
  readonly ok?: boolean;
  readonly error?: string;
}

export type IntegrationAction = (
  state: IntegrationActionState,
  form: FormData,
) => Promise<IntegrationActionState>;

export interface ProviderOption {
  readonly code: string;
  readonly label: string;
  readonly categoryLabel: string;
  /** False when the org's plan lacks the provider's feature. */
  readonly available: boolean;
}

export interface ConnectionView {
  readonly id: string;
  readonly providerCode: string;
  readonly providerLabel: string;
  readonly displayName: string;
  readonly state: "Pending" | "Connected" | "Error" | "Paused" | "Disconnected";
  readonly stateLabel: string;
  readonly lastSynced: string | null;
  readonly lastError: string | null;
  readonly needsCredential: boolean;
  readonly credentialStored: boolean;
  /**
   * Set for providers whose connection stores a developer app's client ID and secret (UPS, FedEx): where to
   * create that app and which values to copy. The form then asks for the two values instead of a token.
   */
  readonly clientCredentialHelp?: string;
  readonly scopes: readonly { readonly value: string; readonly label: string }[];
  /**
   * For providers that sign in (Google Drive and OneDrive, B16): the Connect with Google or Connect with Microsoft
   * button, disabled with its reason while the platform app is not set up. It replaces the pasted credential.
   */
  readonly oauth?: { readonly label: string; readonly disabledReason: string | null };
  /** The provider account the connection signed in as. */
  readonly accountName?: string | null;
  /** What Atlas adds under the connection, such as the linking folder of a storage connection. */
  readonly extra?: ReactNode;
}

export interface IntegrationsCopy {
  readonly empty: string;
  readonly emptyAction: string;
  readonly readOnly: string;
  readonly addHeading: string;
  readonly provider: string;
  readonly providerHelp: string;
  readonly planGated: string;
  readonly name: string;
  readonly nameHelp: string;
  readonly add: string;
  readonly added: string;
  readonly saved: string;
  readonly lastSynced: string;
  readonly neverSynced: string;
  readonly lastError: string;
  readonly credentialHeading: string;
  readonly secret: string;
  readonly secretHelp: string;
  readonly kind: string;
  readonly kindOAuth: string;
  readonly kindKey: string;
  readonly kindServiceAccount: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretHelp: string;
  readonly storeCredential: string;
  readonly connect: string;
  readonly pause: string;
  readonly resume: string;
  readonly reconnect: string;
  readonly disconnect: string;
  readonly scope: string;
  readonly syncNow: string;
  readonly queued: string;
  readonly connectionsLabel: string;
}

export interface IntegrationsSettingsProps {
  readonly org: string;
  readonly canManage: boolean;
  readonly providers: readonly ProviderOption[];
  readonly connections: readonly ConnectionView[];
  readonly copy: IntegrationsCopy;
  readonly actions: {
    readonly create: IntegrationAction;
    readonly credential: IntegrationAction;
    readonly transition: IntegrationAction;
    readonly sync: IntegrationAction;
    /** Starts a provider sign-in and sends the browser to the provider (B16). */
    readonly oauth?: IntegrationAction;
  };
}

const INITIAL: IntegrationActionState = {};

function Outcome({ state, success }: { state: IntegrationActionState; success: string }) {
  if (state.error) return <InlineAlert tone="danger">{state.error}</InlineAlert>;
  if (state.ok) return <InlineAlert tone="success">{success}</InlineAlert>;
  return null;
}

function AddConnectionForm({
  org,
  providers,
  copy,
  action,
  nameId,
}: {
  org: string;
  providers: readonly ProviderOption[];
  copy: IntegrationsCopy;
  action: IntegrationAction;
  nameId: string;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  const id = useId();
  const options = providers
    .filter((p) => p.available)
    .map((p) => ({ value: p.code, label: `${p.categoryLabel}: ${p.label}` }));
  const gated = providers.filter((p) => !p.available).map((p) => p.label);
  return (
    <form
      action={submit}
      className="flex flex-col gap-12"
      aria-labelledby={`${id}-heading`}
      noValidate
    >
      <h3 id={`${id}-heading`} className="m-0 text-label-14 font-semibold">
        {copy.addHeading}
      </h3>
      <input type="hidden" name="org" value={org} />
      <Outcome state={state} success={copy.added} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id={`${id}-provider`}
          name="provider"
          label={copy.provider}
          help={copy.providerHelp}
          value={options[0]?.value ?? ""}
          options={options}
        />
        <Input
          id={nameId}
          name="displayName"
          label={copy.name}
          help={copy.nameHelp}
          maxLength={120}
          required
          autoComplete="off"
        />
        <Button type="submit" variant="primary" loading={pending}>
          {copy.add}
        </Button>
      </div>
      {gated.length > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{`${copy.planGated} ${gated.join(", ")}.`}</p>
      ) : null}
    </form>
  );
}

function CredentialForm({
  org,
  connection,
  copy,
  action,
}: {
  org: string;
  connection: ConnectionView;
  copy: IntegrationsCopy;
  action: IntegrationAction;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  const id = useId();
  return (
    <form
      action={submit}
      className="flex flex-col gap-8"
      aria-label={`${copy.credentialHeading}: ${connection.displayName}`}
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="connectionId" value={connection.id} />
      <Outcome state={state} success={copy.saved} />
      {connection.clientCredentialHelp === undefined ? (
        <>
          <Textarea
            id={`${id}-secret`}
            name="secret"
            label={copy.secret}
            help={copy.secretHelp}
            rows={3}
            required
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-end gap-12">
            <Select
              id={`${id}-kind`}
              name="kind"
              label={copy.kind}
              value="OAuth Token"
              options={[
                { value: "OAuth Token", label: copy.kindOAuth },
                { value: "API Key", label: copy.kindKey },
                { value: "Service Account", label: copy.kindServiceAccount },
              ]}
            />
            <Button type="submit" variant="secondary" loading={pending}>
              {copy.storeCredential}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Input
            id={`${id}-client-id`}
            name="clientId"
            label={copy.clientId}
            help={connection.clientCredentialHelp}
            maxLength={1024}
            required
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-end gap-12">
            <Input
              id={`${id}-client-secret`}
              name="clientSecret"
              type="password"
              label={copy.clientSecret}
              help={copy.clientSecretHelp}
              maxLength={1024}
              required
              autoComplete="off"
            />
            <Button type="submit" variant="secondary" loading={pending}>
              {copy.storeCredential}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function TransitionButton({
  org,
  connection,
  next,
  label,
  variant,
  action,
}: {
  org: string;
  connection: ConnectionView;
  next: ConnectionView["state"];
  label: string;
  variant: "primary" | "secondary" | "danger";
  action: IntegrationAction;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="connectionId" value={connection.id} />
      <input type="hidden" name="expected" value={connection.state} />
      <input type="hidden" name="next" value={next} />
      <Button
        type="submit"
        variant={variant}
        size="sm"
        loading={pending}
        aria-label={`${label}: ${connection.displayName}`}
      >
        {label}
      </Button>
      {state.error ? <InlineAlert tone="danger">{state.error}</InlineAlert> : null}
    </form>
  );
}

function OAuthConnectButton({
  org,
  connection,
  oauth,
  action,
}: {
  org: string;
  connection: ConnectionView;
  oauth: NonNullable<ConnectionView["oauth"]>;
  action: IntegrationAction;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  return (
    <form
      action={submit}
      className="flex flex-col gap-4"
      data-testid={`oauth-connect-${connection.providerCode}`}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="connectionId" value={connection.id} />
      <input type="hidden" name="provider" value={connection.providerCode} />
      <div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={pending}
          disabled={oauth.disabledReason !== null}
          aria-label={`${oauth.label}: ${connection.displayName}`}
        >
          {oauth.label}
        </Button>
      </div>
      {oauth.disabledReason ? (
        <p className="m-0 text-text-12 text-text-secondary">{oauth.disabledReason}</p>
      ) : null}
      {state.error ? <InlineAlert tone="danger">{state.error}</InlineAlert> : null}
    </form>
  );
}

function SyncForm({
  org,
  connection,
  copy,
  action,
}: {
  org: string;
  connection: ConnectionView;
  copy: IntegrationsCopy;
  action: IntegrationAction;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  const id = useId();
  return (
    <form action={submit} className="flex flex-col gap-8">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="connectionId" value={connection.id} />
      <input type="hidden" name="provider" value={connection.providerCode} />
      <Outcome state={state} success={copy.queued} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id={`${id}-scope`}
          name="scope"
          label={copy.scope}
          value={connection.scopes[0]?.value ?? ""}
          options={[...connection.scopes]}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={pending}
          aria-label={`${copy.syncNow}: ${connection.displayName}`}
        >
          {copy.syncNow}
        </Button>
      </div>
    </form>
  );
}

function ConnectionCard({
  org,
  connection,
  canManage,
  copy,
  actions,
}: {
  org: string;
  connection: ConnectionView;
  canManage: boolean;
  copy: IntegrationsCopy;
  actions: IntegrationsSettingsProps["actions"];
}) {
  const canConnect = !connection.needsCredential || connection.credentialStored;
  return (
    <li className="flex flex-col gap-12 rounded-8 border border-border-subtle p-12">
      <div className="flex flex-wrap items-baseline justify-between gap-8">
        <div className="flex flex-col gap-2">
          <span className="text-label-14 font-medium">{connection.displayName}</span>
          <span className="text-text-12 text-text-secondary">{connection.providerLabel}</span>
          {connection.accountName ? (
            <span className="text-text-12 text-text-secondary">{connection.accountName}</span>
          ) : null}
        </div>
        <span className="text-label-12 font-medium" data-state={connection.state}>
          {connection.stateLabel}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-4 text-text-12 sm:grid-cols-2">
        <div className="flex gap-4">
          <dt className="text-text-secondary">{copy.lastSynced}</dt>
          <dd className="m-0">{connection.lastSynced ?? copy.neverSynced}</dd>
        </div>
        {connection.lastError ? (
          <div className="flex gap-4">
            <dt className="text-text-secondary">{copy.lastError}</dt>
            <dd className="m-0">{connection.lastError}</dd>
          </div>
        ) : null}
      </dl>
      {canManage && connection.state !== "Disconnected" ? (
        <div className="flex flex-col gap-12">
          {connection.oauth && actions.oauth ? (
            <OAuthConnectButton
              org={org}
              connection={connection}
              oauth={connection.oauth}
              action={actions.oauth}
            />
          ) : connection.needsCredential ? (
            <CredentialForm
              org={org}
              connection={connection}
              copy={copy}
              action={actions.credential}
            />
          ) : null}
          <div className="flex flex-wrap gap-8">
            {connection.state === "Pending" && canConnect && !connection.oauth ? (
              <TransitionButton
                org={org}
                connection={connection}
                next="Connected"
                label={copy.connect}
                variant="primary"
                action={actions.transition}
              />
            ) : null}
            {connection.state === "Error" && !connection.oauth ? (
              <TransitionButton
                org={org}
                connection={connection}
                next="Connected"
                label={copy.reconnect}
                variant="primary"
                action={actions.transition}
              />
            ) : null}
            {connection.state === "Connected" ? (
              <TransitionButton
                org={org}
                connection={connection}
                next="Paused"
                label={copy.pause}
                variant="secondary"
                action={actions.transition}
              />
            ) : null}
            {connection.state === "Paused" ? (
              <TransitionButton
                org={org}
                connection={connection}
                next="Connected"
                label={copy.resume}
                variant="secondary"
                action={actions.transition}
              />
            ) : null}
            <TransitionButton
              org={org}
              connection={connection}
              next="Disconnected"
              label={copy.disconnect}
              variant="danger"
              action={actions.transition}
            />
          </div>
          {connection.state === "Connected" && connection.scopes.length > 0 ? (
            <SyncForm org={org} connection={connection} copy={copy} action={actions.sync} />
          ) : null}
          {connection.extra ?? null}
        </div>
      ) : null}
    </li>
  );
}

export function IntegrationsSettings({
  org,
  canManage,
  providers,
  connections,
  copy,
  actions,
}: IntegrationsSettingsProps) {
  const live = connections.filter((c) => c.state !== "Disconnected");
  const nameId = `${useId()}-connection-name`;
  return (
    <div className="flex max-w-layout-form flex-col gap-16">
      {!canManage ? <InlineAlert tone="info">{copy.readOnly}</InlineAlert> : null}
      {live.length === 0 && canManage ? (
        <EmptyState
          sentence={copy.empty}
          actionLabel={copy.emptyAction}
          icon="Link2"
          onAction={() => document.getElementById(nameId)?.focus()}
        />
      ) : live.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">{copy.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0" aria-label={copy.connectionsLabel}>
          {live.map((c) => (
            <ConnectionCard
              key={c.id}
              org={org}
              connection={c}
              canManage={canManage}
              copy={copy}
              actions={actions}
            />
          ))}
        </ul>
      )}
      {canManage ? (
        <AddConnectionForm
          org={org}
          providers={providers}
          copy={copy}
          action={actions.create}
          nameId={nameId}
        />
      ) : null}
    </div>
  );
}
