"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useActionState, useRef, useState } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { pauseSubscriptionAction, resumeSubscriptionAction } from "@/lib/billing/actions";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";
import {
  addBlocklistEntryAction,
  confirmAgentProposalAction,
  registerMcpConnectorAction,
  rejectAgentProposalAction,
  removeBlocklistEntryAction,
  type B16State,
} from "./contributions/b16-actions";

/**
 * B16's settings forms (RRR-240, ADR 0155): the member blocklist, the subscription pause, registering an MCP connector
 * and confirming what a connected app proposed. Copy comes from the server as props; each form posts to a server
 * action that lets the database decide, and shows the outcome under it.
 */

type Action = (state: B16State, form: FormData) => Promise<B16State>;

function Outcome({ state }: { state: B16State }) {
  if (!state.message) return null;
  return (
    <div aria-live="polite">
      <InlineAlert tone={state.ok ? "success" : "danger"}>{state.message}</InlineAlert>
    </div>
  );
}

// Blocklist ------------------------------------------------------------------------------------------------------

export function BlocklistAddForm({
  org,
  labels,
}: {
  org: string;
  labels: {
    kind: string;
    kinds: { Email: string; Domain: string };
    value: string;
    valueHelp: string;
    reason: string;
    add: string;
  };
}) {
  const [state, dispatch, pending] = useActionState(addBlocklistEntryAction, {});
  return (
    <form action={dispatch} className="flex flex-col gap-12" data-testid="blocklist-add-form">
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          name="kind"
          label={labels.kind}
          value="Domain"
          options={[
            { value: "Domain", label: labels.kinds.Domain },
            { value: "Email", label: labels.kinds.Email },
          ]}
        />
        <Input name="value" label={labels.value} help={labels.valueHelp} required maxLength={320} />
        <Input name="reason" label={labels.reason} maxLength={500} />
      </div>
      <Outcome state={state} />
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {labels.add}
        </Button>
      </div>
    </form>
  );
}

/** A Remove control confirmed in a dialog, posting the given fields. */
function ConfirmedRemove({
  action,
  fields,
  formId,
  labels,
}: {
  action: Action;
  fields: Readonly<Record<string, string>>;
  formId: string;
  labels: { trigger: string; title: string; body: string; cancel: string };
}) {
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState(action, {});
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.ok) setOpen(false);
  }
  return (
    <div className="flex flex-col items-end gap-4">
      <form id={formId} action={dispatch} className="hidden">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button type="button" size="sm" variant="ghost">
            {labels.trigger}
          </Button>
        }
        title={labels.title}
        description={labels.body}
        actions={
          <>
            <Button type="button" onClick={() => setOpen(false)}>
              {labels.cancel}
            </Button>
            <Button type="submit" form={formId} variant="danger" loading={pending}>
              {labels.trigger}
            </Button>
          </>
        }
      >
        {state.message && !state.ok ? (
          <InlineAlert tone="danger">{state.message}</InlineAlert>
        ) : null}
      </Dialog>
      {state.message && !open ? <Outcome state={state} /> : null}
    </div>
  );
}

export function BlocklistRemove({
  org,
  entryId,
  labels,
}: {
  org: string;
  entryId: string;
  labels: { trigger: string; title: string; body: string; cancel: string };
}) {
  return (
    <ConfirmedRemove
      action={removeBlocklistEntryAction}
      fields={{ org, entryId }}
      formId={`blocklist-remove-${entryId}`}
      labels={labels}
    />
  );
}

// Pause --------------------------------------------------------------------------------------------------------

function PauseOutcome({
  state,
  refusals,
  success,
}: {
  state: PlatformActionState;
  refusals: Readonly<Record<string, string>>;
  success: string;
}) {
  if (state.rule && state.rule !== "step_up_required") {
    return <InlineAlert tone="warning">{refusals[state.rule] ?? refusals["other"]}</InlineAlert>;
  }
  if (state.error) return <InlineAlert tone="danger">{refusals["other"]}</InlineAlert>;
  if (state.ok) return <InlineAlert tone="success">{success}</InlineAlert>;
  return null;
}

const stepUpRefused = (state: PlatformActionState) => state.rule === "step_up_required";

/** The months select, with the dates each choice gives, and the Pause button. */
export function PauseForm({
  org,
  previews,
  labels,
  refusals,
}: {
  org: string;
  /** One sentence per choice of 1 to 6 months: "Pauses on ... Billing and changes resume on ...". */
  previews: readonly string[];
  labels: { months: string; options: readonly string[]; pause: string; paused: string };
  refusals: Readonly<Record<string, string>>;
}) {
  const [state, dispatch, pending] = useActionState(
    pauseSubscriptionAction,
    INITIAL_PLATFORM_STATE,
  );
  const [months, setMonths] = useState("1");
  const ref = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(state, stepUpRefused, ref);
  return (
    <>
      <form ref={ref} action={dispatch} className="flex flex-col gap-12" data-testid="pause-form">
        <input type="hidden" name="org" value={org} />
        <Select
          name="months"
          label={labels.months}
          value="1"
          options={labels.options.map((label, i) => ({ value: String(i + 1), label }))}
          onChange={(e) => setMonths(e.target.value)}
        />
        <p className="m-0 text-text-13" data-testid="pause-preview">
          {previews[Number(months) - 1]}
        </p>
        <div aria-live="polite">
          <PauseOutcome state={state} refusals={refusals} success={labels.paused} />
        </div>
        <div>
          <Button type="submit" variant="secondary" loading={pending}>
            {labels.pause}
          </Button>
        </div>
      </form>
      {stepUp}
    </>
  );
}

/** Resume now (after the pause started) or Cancel scheduled pause (before it). */
export function ResumeForm({
  org,
  label,
  note,
  done,
  refusals,
}: {
  org: string;
  label: string;
  note: string | null;
  done: string;
  refusals: Readonly<Record<string, string>>;
}) {
  const [state, dispatch, pending] = useActionState(
    resumeSubscriptionAction,
    INITIAL_PLATFORM_STATE,
  );
  const ref = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(state, stepUpRefused, ref);
  return (
    <>
      <form ref={ref} action={dispatch} className="flex flex-col gap-8" data-testid="resume-form">
        <input type="hidden" name="org" value={org} />
        {note ? <p className="m-0 text-text-13 text-text-secondary">{note}</p> : null}
        <div aria-live="polite">
          <PauseOutcome state={state} refusals={refusals} success={done} />
        </div>
        <div>
          <Button type="submit" variant="secondary" loading={pending}>
            {label}
          </Button>
        </div>
      </form>
      {stepUp}
    </>
  );
}

// MCP connectors -----------------------------------------------------------------------------------------------

function CopyValue({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-8">
      <span className="text-label-13 font-medium">{label}</span>
      <code
        className="rounded-control bg-surface-sunken px-6 py-2 text-text-12 break-all"
        data-testid={`copy-${label}`}
      >
        {value}
      </code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? copiedLabel : copyLabel}
      </Button>
    </div>
  );
}

export function McpConnectorForm({
  org,
  groups,
  defaults,
  labels,
}: {
  org: string;
  /** The capability groups an Admin may give by default (never a Restricted one). */
  groups: readonly { value: string; label: string }[];
  defaults: readonly string[];
  labels: {
    kind: string;
    kinds: { Claude: string; ChatGPT: string; Other: string };
    name: string;
    redirect: string;
    redirectHelp: string;
    scopes: string;
    scopesHelp: string;
    register: string;
    serverUrl: string;
    clientId: string;
    copy: string;
    copied: string;
    steps: { Claude: string; ChatGPT: string; Other: string };
  };
}) {
  const [state, dispatch, pending] = useActionState(registerMcpConnectorAction, {});
  const [kind, setKind] = useState<"Claude" | "ChatGPT" | "Other">("Claude");
  return (
    <form action={dispatch} className="flex flex-col gap-12" data-testid="mcp-connector-form">
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          name="kind"
          label={labels.kind}
          value="Claude"
          options={(["Claude", "ChatGPT", "Other"] as const).map((k) => ({
            value: k,
            label: labels.kinds[k],
          }))}
          onChange={(e) => setKind(e.target.value as "Claude" | "ChatGPT" | "Other")}
        />
        <Input name="name" label={labels.name} maxLength={120} />
        {kind === "Other" ? (
          <Input
            name="redirectUri"
            label={labels.redirect}
            help={labels.redirectHelp}
            type="url"
            required
          />
        ) : null}
      </div>
      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-4 text-label-13 font-medium">{labels.scopes}</legend>
        <p className="m-0 text-text-12 text-text-secondary">{labels.scopesHelp}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {groups.map((g) => (
            <Checkbox
              key={g.value}
              name="scope"
              value={g.value}
              label={g.label}
              defaultChecked={defaults.includes(g.value)}
            />
          ))}
        </div>
      </fieldset>
      {state.connector ? (
        <div className="flex flex-col gap-8" data-testid="mcp-connector-result">
          <InlineAlert tone="success">{state.message}</InlineAlert>
          <CopyValue
            label={labels.serverUrl}
            value={state.connector.serverUrl}
            copyLabel={labels.copy}
            copiedLabel={labels.copied}
          />
          <CopyValue
            label={labels.clientId}
            value={state.connector.clientId}
            copyLabel={labels.copy}
            copiedLabel={labels.copied}
          />
          <p className="m-0 text-text-13">
            {labels.steps[state.connector.kind as "Claude" | "ChatGPT" | "Other"] ??
              labels.steps.Other}
          </p>
        </div>
      ) : (
        <Outcome state={state} />
      )}
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {labels.register}
        </Button>
      </div>
    </form>
  );
}

// Proposals ----------------------------------------------------------------------------------------------------

export function ProposalDecision({
  org,
  suggestionId,
  labels,
}: {
  org: string;
  suggestionId: string;
  labels: { confirm: string; reject: string };
}) {
  const [confirmed, confirm, confirming] = useActionState(confirmAgentProposalAction, {});
  const [rejected, reject, rejecting] = useActionState(rejectAgentProposalAction, {});
  const latest = (confirmed.at ?? 0) >= (rejected.at ?? 0) ? confirmed : rejected;
  if (latest.ok) return <Outcome state={latest} />;
  return (
    <div className="flex flex-col items-start gap-8">
      <div className="flex flex-wrap gap-8">
        <form action={confirm}>
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="suggestionId" value={suggestionId} />
          <Button type="submit" size="sm" variant="secondary" loading={confirming}>
            {labels.confirm}
          </Button>
        </form>
        <form action={reject}>
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="suggestionId" value={suggestionId} />
          <Button type="submit" size="sm" variant="ghost" loading={rejecting}>
            {labels.reject}
          </Button>
        </form>
      </div>
      <Outcome state={latest} />
    </div>
  );
}
