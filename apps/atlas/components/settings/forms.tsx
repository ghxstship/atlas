"use client";

import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  inviteMemberAction,
  removeMemberAction,
  renameOrganizationAction,
  revokeInviteAction,
  setMemberRoleAction,
  type SettingsState,
} from "@/app/[org]/settings/actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { useStepUp } from "@/components/auth/security/step-up";
/** Client forms for the org settings pages; each keeps typed input after a failed submit. */

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "shell.settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

const INITIAL: SettingsState = {};

function MemberError({ state }: { state: SettingsState }) {
  const t = useCopy("shell.settings.members.errors");
  // A step-up refusal opens the step-up dialog instead of an alert (A99, S9-08).
  return state.error && state.error !== "step_up_required" ? (
    <InlineAlert tone="danger">{t(state.error)}</InlineAlert>
  ) : null;
}

// General ---------------------------------------------------------------------------------------

export function GeneralForm({ org, name }: { org: string; name: string }) {
  const t = useCopy("shell.settings");
  const auth = useCopy("shell.auth.errors");
  const [state, action, pending] = useActionState(renameOrganizationAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <MemberError state={state} />
      <Input
        id="general-name"
        name="name"
        required
        width="100%"
        label={t("general.name")}
        defaultValue={name}
        error={state.fieldErrors?.["name"] ? auth("orgName") : ""}
      />
      <Input
        id="general-address"
        readOnly
        width="100%"
        label={t("general.address")}
        help={t("general.addressHelp", { slug: org })}
        value={`/${org}`}
      />
      <div className="flex items-center gap-12">
        <Button type="submit" variant="primary" loading={pending}>
          {t("save")}
        </Button>
        {state.ok ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {t("saved")}
          </p>
        ) : null}
      </div>
    </form>
  );
}

// Members ---------------------------------------------------------------------------------------

export interface RoleOption {
  readonly id: string;
  readonly label: string;
}

export function InviteForm({
  org,
  roles,
  defaultRoleId,
}: {
  org: string;
  roles: readonly RoleOption[];
  defaultRoleId: string;
}) {
  const t = useCopy("shell.settings.members");
  const format = useFormatter();
  const [state, action, pending] = useActionState(inviteMemberAction, INITIAL);
  const [copied, setCopied] = useState(false);
  return (
    <section aria-labelledby="invite-heading" className="flex flex-col gap-12">
      <h2 id="invite-heading" className="m-0 text-heading-16 font-semibold">
        {t("invite.title")}
      </h2>
      <form
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        <MemberError state={state} />
        <Input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="off"
          required
          width="100%"
          label={t("invite.email")}
          error={state.fieldErrors?.["email"] ? t("errors.email") : ""}
        />
        <div className="flex flex-wrap gap-12">
          <Select
            id="invite-role"
            name="roleId"
            label={t("invite.role")}
            value={defaultRoleId}
            options={roles.map((r) => ({ value: r.id, label: r.label }))}
          />
          <Select
            id="invite-days"
            name="days"
            label={t("invite.expires")}
            value="14"
            options={[1, 7, 14, 30].map((d) => ({
              value: String(d),
              label: t("invite.days", { count: d }),
            }))}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("invite.submit")}
          </Button>
        </div>
      </form>
      {state.invite ? (
        <div
          role="status"
          className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
        >
          <p className="m-0 text-text-13">
            {t("invite.created", {
              email: state.invite.email,
              expires: format.relativeTime(new Date(state.invite.expiresAt)),
            })}
          </p>
          <Input
            id="invite-link"
            readOnly
            width="100%"
            label={t("invite.link")}
            value={state.invite.link}
          />
          <div className="flex items-center gap-12">
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(state.invite?.link ?? "");
                setCopied(true);
              }}
            >
              {t("invite.copy")}
            </Button>
            {copied ? (
              <span className="text-text-13 text-success-text">{t("invite.copied")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function MemberRoleSelect({
  org,
  membershipId,
  roleId,
  name,
  roles,
  disabled,
}: {
  org: string;
  membershipId: string;
  roleId: string;
  name: string;
  roles: readonly RoleOption[];
  disabled: boolean;
}) {
  const t = useCopy("shell.settings.members");
  const stepUp = useStepUp();
  const [state, action] = useActionState(setMemberRoleAction, INITIAL);
  const [, startTransition] = useTransition();
  // A role change asks for step-up (A99, S9-08): a refusal opens the dialog, and verifying submits the change again.
  const last = useRef<FormData | null>(null);
  const seen = useRef(state);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    const form = last.current;
    if (state.error === "step_up_required" && form) {
      stepUp.request(() => startTransition(() => action(form)));
    }
  }, [state, stepUp, action]);
  return (
    <div className="flex flex-col gap-4">
      <Select
        id={`role-${membershipId}`}
        label={t("roleFor", { name })}
        value={roleId}
        disabled={disabled}
        options={roles.map((r) => ({ value: r.id, label: r.label }))}
        onChange={(event) => {
          const form = new FormData();
          form.set("org", org);
          form.set("membershipId", membershipId);
          form.set("roleId", event.target.value);
          last.current = form;
          startTransition(() => action(form));
        }}
      />
      <MemberError state={state} />
      {stepUp.dialog}
    </div>
  );
}

export function RemoveMemberButton({
  org,
  orgName,
  membershipId,
  name,
}: {
  org: string;
  orgName: string;
  membershipId: string;
  name: string;
}) {
  const t = useCopy("shell.settings.members");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SettingsState, FormData>(async (prev, form) => {
    const result = await removeMemberAction(prev, form);
    if (result.ok) setOpen(false);
    return result;
  }, INITIAL);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm">
          {t("remove")}
        </Button>
      }
      title={t("removeTitle", { name })}
      description={t("removeBody", { name, org: orgName })}
      actions={
        <>
          <Button onClick={() => setOpen(false)}>{t("cancel")}</Button>
          <Button type="submit" form={`remove-${membershipId}`} variant="danger" loading={pending}>
            {t("remove")}
          </Button>
        </>
      }
    >
      <form id={`remove-${membershipId}`} action={action} onSubmit={keepInputOnSubmit(action)}>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <MemberError state={state} />
      </form>
    </Dialog>
  );
}

export function RevokeInviteButton({ org, inviteId }: { org: string; inviteId: string }) {
  const t = useCopy("shell.settings.members");
  const [state, action, pending] = useActionState(revokeInviteAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="ghost" size="sm" loading={pending}>
        {t("revoke")}
      </Button>
      <MemberError state={state} />
    </form>
  );
}
