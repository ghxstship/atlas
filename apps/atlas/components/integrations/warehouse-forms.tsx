"use client";

import { Checkbox, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import {
  addWarehouseDestinationAction,
  retryDeadLetterAction,
  storeInboundSecretAction,
  storeWarehouseCredentialAction,
  warehouseDestinationAction,
} from "@/components/settings/contributions/a83-actions";
import { ActionForm, usePlatformT } from "@/components/platform/kit";

/**
 * Client forms of A83's panels on Settings, Integrations (warehouse delivery and provider webhooks). Copy comes
 * from the `platform` namespace; every form posts to a server action that writes with the viewer's client.
 */

/** Adds a warehouse destination; only available providers are offered, the others are named as not available yet. */
export function AddWarehouseDestinationForm({
  org,
  providers,
  unavailable,
  canIncludeConfidential,
}: {
  org: string;
  providers: readonly string[];
  unavailable: readonly string[];
  canIncludeConfidential: boolean;
}) {
  const t = usePlatformT();
  const [provider, setProvider] = useState(providers[0] ?? "S3");
  const [format, setFormat] = useState("Parquet");
  return (
    <ActionForm
      action={addWarehouseDestinationAction}
      hidden={{ org, provider, format }}
      label={t("warehouse.add.heading")}
      submitLabel={t("warehouse.add.submit")}
      success={t("warehouse.add.added")}
    >
      <Select
        label={t("warehouse.add.provider")}
        help={[
          t("warehouse.add.providerHelp"),
          ...unavailable.map((p) => t("warehouse.add.unavailable", { provider: p })),
        ].join(" ")}
        value={provider}
        options={providers.map((p) => ({ value: p, label: p }))}
        onChange={(e) => setProvider(e.target.value)}
      />
      <Input
        id="warehouse-name"
        name="name"
        required
        maxLength={120}
        label={t("warehouse.add.name")}
        help={t("warehouse.add.nameHelp")}
      />
      <Input
        id="warehouse-bucket"
        name="bucket"
        required
        maxLength={63}
        autoComplete="off"
        pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]"
        label={t("warehouse.add.bucket")}
      />
      <Input
        id="warehouse-region"
        name="region"
        maxLength={40}
        autoComplete="off"
        label={t("warehouse.add.region")}
        help={t("warehouse.add.regionHelp")}
      />
      <Input
        id="warehouse-endpoint"
        name="endpoint"
        type="url"
        maxLength={300}
        autoComplete="off"
        label={t("warehouse.add.endpoint")}
        help={t("warehouse.add.endpointHelp")}
      />
      <Input
        id="warehouse-prefix"
        name="prefix"
        maxLength={200}
        defaultValue="xos"
        label={t("warehouse.add.prefix")}
        help={t("warehouse.add.prefixHelp")}
      />
      <Select
        label={t("warehouse.add.format")}
        value={format}
        options={[
          { value: "Parquet", label: "Parquet" },
          { value: "CSV", label: "CSV" },
        ]}
        onChange={(e) => setFormat(e.target.value)}
      />
      <Input
        id="warehouse-hour"
        name="hour"
        type="number"
        min={0}
        max={23}
        step={1}
        required
        defaultValue="2"
        label={t("warehouse.add.hour")}
        help={t("warehouse.add.hourHelp")}
      />
      {canIncludeConfidential ? (
        <div className="flex flex-col gap-4">
          <Checkbox name="confidential" label={t("warehouse.add.confidential")} />
          <p className="m-0 text-text-12 text-text-secondary">
            {t("warehouse.add.confidentialHelp")}
          </p>
        </div>
      ) : null}
    </ActionForm>
  );
}

/** Stores or rotates a destination's bucket credential; it is never shown again. */
export function WarehouseCredentialForm({
  org,
  destination,
  name,
}: {
  org: string;
  destination: string;
  name: string;
}) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={storeWarehouseCredentialAction}
      hidden={{ org, destination }}
      label={`${t("warehouse.credential.label")}: ${name}`}
      submitLabel={t("warehouse.credential.submit")}
      submitVariant="secondary"
      success={t("warehouse.credential.saved")}
    >
      <Textarea
        id={`warehouse-secret-${destination}`}
        name="secret"
        label={t("warehouse.credential.label")}
        help={t("warehouse.credential.help")}
        required
        rows={3}
        maxLength={16384}
        autoComplete="off"
        spellCheck={false}
        width="100%"
      />
    </ActionForm>
  );
}

/** Deliver now, pause, resume or delete a destination. */
export function WarehouseDestinationActions({
  org,
  destination,
  name,
  paused,
}: {
  org: string;
  destination: string;
  name: string;
  paused: boolean;
}) {
  const t = usePlatformT();
  const button = (
    intent: string,
    label: string,
    success: string,
    variant: "primary" | "secondary" | "danger" | "ghost",
  ) => (
    <ActionForm
      action={warehouseDestinationAction}
      hidden={{ org, destination, intent }}
      label={`${label}: ${name}`}
      submitLabel={label}
      submitVariant={variant}
      success={success}
      inline
    />
  );
  return (
    <div className="flex flex-wrap items-start gap-8">
      {paused
        ? null
        : button(
            "deliver",
            t("warehouse.actions.deliverNow"),
            t("warehouse.actions.queued"),
            "secondary",
          )}
      {paused
        ? button("resume", t("warehouse.actions.resume"), t("warehouse.states.Active"), "secondary")
        : button("pause", t("warehouse.actions.pause"), t("warehouse.states.Paused"), "ghost")}
      {button("remove", t("warehouse.actions.remove"), t("warehouse.actions.removed"), "danger")}
    </div>
  );
}

/** Sends a dead-lettered provider webhook back, with the reason. */
export function RetryDeadLetterForm({
  org,
  event,
  provider,
}: {
  org: string;
  event: string;
  provider: string;
}) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={retryDeadLetterAction}
      hidden={{ org, event }}
      label={t("inbound.retryLabel", { provider })}
      submitLabel={t("inbound.retry")}
      submitVariant="secondary"
      success={t("inbound.retried")}
      inline
    >
      <Input
        id={`retry-reason-${event}`}
        name="reason"
        required
        maxLength={500}
        label={t("inbound.reason")}
        help={t("inbound.reasonHelp")}
      />
    </ActionForm>
  );
}

/** Stores the secret a provider signs one connection's webhooks with. */
export function InboundSecretForm({
  org,
  connection,
  name,
}: {
  org: string;
  connection: string;
  name: string;
}) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={storeInboundSecretAction}
      hidden={{ org, connection }}
      label={t("inbound.secrets.label", { name })}
      submitLabel={t("inbound.secrets.submit")}
      submitVariant="secondary"
      success={t("inbound.secrets.saved")}
      inline
    >
      <Input
        id={`inbound-secret-${connection}`}
        name="secret"
        type="password"
        required
        minLength={16}
        maxLength={1024}
        autoComplete="off"
        label={t("inbound.secrets.label", { name })}
        help={t("inbound.secrets.help")}
      />
    </ActionForm>
  );
}
