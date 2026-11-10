"use client";

import { Button, InlineAlert, Input, Select } from "@xos/ui";
import { startTransition, useActionState, useEffect, useRef } from "react";
import {
  createOfferingRuleAction,
  removeOfferingRuleAction,
  type OfferingRuleState,
} from "./offering-actions";

/**
 * The offering rule controls (R3): the add form with its six fields and the Remove button of a
 * rule. Settings pages load this module on demand (next/dynamic), so it never reaches a page that
 * shows no rule controls. Every label arrives translated from the server.
 */

type Option = { readonly value: string; readonly label: string };

export interface OfferingRuleCopy {
  readonly offering: string;
  readonly roleType: string;
  readonly vendorClass: string;
  readonly mode: string;
  readonly capPerEngagement: string;
  readonly capPerPerson: string;
  readonly capHelp: string;
  readonly addRule: string;
  readonly added: string;
  readonly remove: string;
  /** Error sentences by key: conflict, invalid, crossOrg, notFound, unexpected. */
  readonly errors: Readonly<Record<string, string>>;
}

export interface OfferingRuleScope {
  readonly org: string;
  /** Empty for a rule of the whole org. */
  readonly projectId: string;
  readonly projectKey: string;
}

const INITIAL: OfferingRuleState = {};

function Hidden({ scope }: { scope: OfferingRuleScope }) {
  return (
    <>
      <input type="hidden" name="org" value={scope.org} />
      <input type="hidden" name="projectId" value={scope.projectId} />
      <input type="hidden" name="projectKey" value={scope.projectKey} />
    </>
  );
}

export function OfferingRuleForm({
  scope,
  copy,
  offerings,
  roleTypes,
  vendorClasses,
  modes,
}: {
  scope: OfferingRuleScope;
  copy: OfferingRuleCopy;
  offerings: readonly Option[];
  /** The first option is every role type (empty value). */
  roleTypes: readonly Option[];
  /** The first option is every vendor class (empty value). */
  vendorClasses: readonly Option[];
  modes: readonly Option[];
}) {
  const [state, run, pending] = useActionState(createOfferingRuleAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  const id = scope.projectId === "" ? "org-offering-rule" : "project-offering-rule";
  return (
    <form
      ref={form}
      aria-label={copy.addRule}
      data-testid="offering-rule-form"
      onSubmit={(event) => {
        // A transition keeps what the person chose when the rule is refused.
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => run(data));
      }}
      noValidate
      className="flex flex-col gap-12"
    >
      <Hidden scope={scope} />
      {state.error ? (
        <InlineAlert tone="danger">
          {copy.errors[state.error] ?? copy.errors["unexpected"]}
        </InlineAlert>
      ) : null}
      <div className="grid gap-12 sm:grid-cols-2">
        <Select
          id={`${id}-offering`}
          name="offering"
          label={copy.offering}
          options={[...offerings]}
        />
        <Select id={`${id}-role`} name="roleType" label={copy.roleType} options={[...roleTypes]} />
        <Select
          id={`${id}-class`}
          name="vendorClassId"
          label={copy.vendorClass}
          options={[...vendorClasses]}
        />
        <Select id={`${id}-mode`} name="mode" label={copy.mode} options={[...modes]} />
        <Input
          id={`${id}-cap-engagement`}
          name="capPerEngagement"
          type="number"
          inputMode="numeric"
          min={0}
          max={10000}
          label={copy.capPerEngagement}
          help={copy.capHelp}
          width="100%"
        />
        <Input
          id={`${id}-cap-person`}
          name="capPerPerson"
          type="number"
          inputMode="numeric"
          min={0}
          max={10000}
          label={copy.capPerPerson}
          help={copy.capHelp}
          width="100%"
        />
      </div>
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" loading={pending}>
          {copy.addRule}
        </Button>
        <p role="status" className="m-0 text-text-13 text-success-text">
          {state.ok ? copy.added : null}
        </p>
      </div>
    </form>
  );
}

export function RemoveOfferingRule({
  scope,
  ruleId,
  label,
  accessibleName,
  errors,
}: {
  scope: OfferingRuleScope;
  ruleId: string;
  label: string;
  /** Names the rule as well, for example "Remove Catering, Vendor". */
  accessibleName: string;
  errors: Readonly<Record<string, string>>;
}) {
  const [state, run, pending] = useActionState(removeOfferingRuleAction, INITIAL);
  return (
    <form action={run} className="flex flex-col items-end gap-4">
      <Hidden scope={scope} />
      <input type="hidden" name="id" value={ruleId} />
      <Button type="submit" variant="ghost" size="sm" loading={pending} aria-label={accessibleName}>
        {label}
      </Button>
      {state.error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {errors[state.error] ?? errors["unexpected"]}
        </p>
      ) : null}
    </form>
  );
}
