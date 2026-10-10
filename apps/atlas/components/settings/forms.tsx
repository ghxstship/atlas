"use client";

import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useState, useTransition, type CSSProperties } from "react";
import {
  checkAccentAction,
  inviteMemberAction,
  removeMemberAction,
  renameOrganizationAction,
  revokeInviteAction,
  setMemberRoleAction,
  type SettingsState,
} from "@/app/[org]/settings/actions";
import type { AccentCheck } from "@/lib/brand/contrast";

/** Client forms for the org settings pages; each keeps typed input after a failed submit. */

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "shell.settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

const INITIAL: SettingsState = {};

function MemberError({ state }: { state: SettingsState }) {
  const t = useCopy("shell.settings.members.errors");
  return state.error ? <InlineAlert tone="danger">{t(state.error)}</InlineAlert> : null;
}

// General ---------------------------------------------------------------------------------------

export function GeneralForm({ org, name }: { org: string; name: string }) {
  const t = useCopy("shell.settings");
  const auth = useCopy("shell.auth.errors");
  const [state, action, pending] = useActionState(renameOrganizationAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
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
      <form action={action} className="flex flex-col gap-12" noValidate>
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
  const [state, action] = useActionState(setMemberRoleAction, INITIAL);
  const [, startTransition] = useTransition();
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
          startTransition(() => action(form));
        }}
      />
      <MemberError state={state} />
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
      <form id={`remove-${membershipId}`} action={action}>
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
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="ghost" size="sm" loading={pending}>
        {t("revoke")}
      </Button>
      <MemberError state={state} />
    </form>
  );
}

// White label ------------------------------------------------------------------------------------

export function BrandEditor({ initialAccent }: { initialAccent: string }) {
  const t = useCopy("shell.settings.whiteLabel");
  const [accent, setAccent] = useState(initialAccent);
  const [check, setCheck] = useState<AccentCheck | null>(null);
  const valid = /^#[0-9a-fA-F]{6}$/.test(accent);

  useEffect(() => {
    if (!valid) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await checkAccentAction(accent);
      if (!cancelled) setCheck(result);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accent, valid]);

  const current = valid ? check : null;
  return (
    <div className="flex flex-col gap-16">
      <div className="flex items-end gap-12">
        <Input
          id="brand-accent"
          name="accent"
          spellCheck={false}
          label={t("accent")}
          help={t("accentHelp")}
          value={accent}
          onChange={(e) => setAccent(e.target.value.trim())}
          error={valid ? "" : t("invalid")}
        />
        <input
          type="color"
          aria-label={t("accent")}
          value={valid ? accent : initialAccent}
          onChange={(e) => setAccent(e.target.value.toUpperCase())}
          className="h-control-md w-48 cursor-pointer rounded-control border border-border-control bg-bg-surface"
        />
      </div>
      {current ? (
        current.passes ? (
          <InlineAlert tone="success">{t("passes")}</InlineAlert>
        ) : (
          <InlineAlert tone="danger" title={t("fails", { count: current.failures.length })}>
            <ul className="m-0 ps-16">
              {current.failures.map((f) => (
                <li key={`${f.theme}-${f.rule}-${f.fg}-${f.bg}`}>
                  {t("failure", {
                    rule: f.rule,
                    theme: f.theme,
                    ratio: f.ratio.toFixed(2),
                    min: f.min,
                  })}
                </li>
              ))}
            </ul>
          </InlineAlert>
        )
      ) : null}
      <section aria-labelledby="brand-preview" className="flex flex-col gap-8">
        <h2 id="brand-preview" className="m-0 text-heading-16 font-semibold">
          {t("preview")}
        </h2>
        <div
          className="flex gap-12 rounded-card border border-border-subtle p-16"
          style={
            current?.passes ? ({ "--color-accent-default": accent } as CSSProperties) : undefined
          }
        >
          <Button variant="primary" tabIndex={-1}>
            {t("previewAction")}
          </Button>
        </div>
      </section>
    </div>
  );
}
