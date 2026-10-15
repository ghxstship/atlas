"use client";

import type { UridCategory } from "@xos/data/places";
import type { AssertionWord, CapabilityDirection } from "@xos/data/reconciliation";
import { Checkbox, Input, Select, Textarea } from "@xos/ui";
import { reconcileProjectAction, saveCapabilityStatementAction } from "@/app/[org]/places/actions";
import { ActionForm, useCopy } from "../kit/form";
import { UridPicker } from "../kit/urid-picker";

/**
 * Adds a requirement of the project, or a capability a venue provides, in the one shape that makes
 * reconciliation a join. A capability carries a canon assertion word; silence is UNKNOWN.
 */
export function StatementForm({
  org,
  projectId,
  direction,
  categories,
  venues,
  words,
}: {
  org: string;
  projectId: string;
  direction: CapabilityDirection;
  categories: readonly UridCategory[];
  venues: readonly { id: string; name: string }[];
  words: readonly AssertionWord[];
}) {
  const t = useCopy("places");
  const require = direction === "Require";
  const prefix = require ? "req" : "cap";
  return (
    <ActionForm
      action={saveCapabilityStatementAction}
      org={org}
      hidden={{ projectId, direction }}
      submitLabel={require ? t("reconciliation.addRequirement") : t("reconciliation.addCapability")}
      successMessage={t("kit.saved")}
    >
      {(error) => (
        <>
          <UridPicker
            id={`${prefix}-urid`}
            name="urid"
            label={t("reconciliation.fields.urid")}
            noMatch={t("spaces.fields.uridNoMatch")}
            value={null}
            categories={categories}
          />
          <Textarea
            id={`${prefix}-description`}
            name="description"
            required
            rows={2}
            width="100%"
            label={
              require ? t("reconciliation.fields.needed") : t("reconciliation.fields.provided")
            }
            error={error("description")}
          />
          <Input
            id={`${prefix}-quantity`}
            name="quantity"
            type="number"
            min="0"
            step="any"
            label={t("reconciliation.fields.quantity")}
            help={t("spaces.fields.unknownHelp")}
            error={error("quantity")}
          />
          {require ? (
            <Checkbox
              id={`${prefix}-critical`}
              name="critical"
              label={t("reconciliation.fields.critical")}
            />
          ) : (
            <>
              <Select
                id={`${prefix}-venue`}
                name="venueId"
                label={t("reconciliation.fields.venue")}
                value={venues[0]?.id ?? ""}
                options={venues.map((v) => ({ value: v.id, label: v.name }))}
                error={error("venueId")}
              />
              <Select
                id={`${prefix}-assertion`}
                name="assertionWord"
                label={t("reconciliation.fields.assertion")}
                help={t("reconciliation.fields.assertionHelp")}
                value="UNKNOWN"
                options={words.map((w) => ({
                  value: w.word,
                  label: t(`reconciliation.words.${w.word}`),
                }))}
              />
            </>
          )}
        </>
      )}
    </ActionForm>
  );
}

/** Runs app.reconcile_project for the project. */
export function ReconcileForm({ org, projectId }: { org: string; projectId: string }) {
  const t = useCopy("places");
  return (
    <ActionForm
      action={reconcileProjectAction}
      org={org}
      hidden={{ projectId }}
      submitLabel={t("reconciliation.run")}
      successMessage={t("reconciliation.ran")}
    >
      {() => (
        <Input
          id="reconcile-note"
          name="note"
          width="100%"
          label={t("reconciliation.fields.note")}
        />
      )}
    </ActionForm>
  );
}
