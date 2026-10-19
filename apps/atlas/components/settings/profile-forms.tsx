"use client";

import { Button, Checkbox, InlineAlert, Input, MoreFields, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
import {
  addProfileItemAction,
  autoJoinAction,
  carryCertificationAction,
  removeProfileItemAction,
  savePrivacyAction,
  saveProfileAction,
  type ProfileFormState,
} from "@/app/[org]/me/profile-actions";
import {
  createInviteLinkAction,
  decideJoinRequestAction,
  offboardingAction,
  revokeInviteLinkAction,
  saveOrganizationProfileAction,
  type PeopleFormState,
} from "@/app/[org]/settings/people-actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Catalog lookups with keys built at run time (refusal rules, sections); next-intl types only literals. */
function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "profiles");
  return (key, values) => (t as unknown as Translate)(key, values);
}

type State = ProfileFormState & PeopleFormState;
const INITIAL: State = {};
type Option = { readonly value: string; readonly label: string };

function Status({ state }: { state: State }) {
  const t = useCopy("profiles");
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok && !state.link) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("saved")}
      </p>
    );
  }
  return null;
}

function fieldError(t: Translate, state: State, name: string): string {
  const key = state.fieldErrors?.[name];
  return key ? t(`errors.${key}`) : "";
}

// Profile ---------------------------------------------------------------------------------------

export interface ProfileFormProps {
  readonly org: string;
  readonly profile: {
    readonly handle: string;
    readonly preferredName: string;
    readonly pronouns: string;
    readonly headline: string;
    readonly bio: string;
    readonly city: string;
    readonly countryCode: string;
    readonly rate: string;
    readonly rateCurrency: string;
    readonly rateUnit: string;
  };
  readonly profileUrl: string;
  readonly currencies: readonly Option[];
}

export function ProfileForm(props: ProfileFormProps) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(saveProfileAction, INITIAL);
  const p = props.profile;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex max-w-layout-form flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={props.org} />
      <Status state={state} />
      <Input
        id="profile-handle"
        name="handle"
        label={t("fields.handle")}
        help={t("fields.handleHelp", { url: props.profileUrl })}
        defaultValue={p.handle}
        spellCheck={false}
        width="100%"
        error={fieldError(t, state, "handle")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="profile-preferred"
          name="preferredName"
          label={t("fields.preferredName")}
          defaultValue={p.preferredName}
        />
        <Input
          id="profile-pronouns"
          name="pronouns"
          label={t("fields.pronouns")}
          help={t("fields.optional")}
          defaultValue={p.pronouns}
        />
      </div>
      <Input
        id="profile-headline"
        name="headline"
        label={t("fields.headline")}
        help={t("fields.headlineHelp")}
        defaultValue={p.headline}
        maxLength={120}
        width="100%"
        error={fieldError(t, state, "headline")}
      />
      <Textarea
        id="profile-bio"
        name="bio"
        label={t("fields.bio")}
        defaultValue={p.bio}
        maxLength={2000}
        width="100%"
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="profile-city"
          name="city"
          label={t("fields.city")}
          help={t("fields.cityHelp")}
          defaultValue={p.city}
        />
        <Input
          id="profile-country"
          name="countryCode"
          label={t("fields.country")}
          help={t("fields.countryHelp")}
          defaultValue={p.countryCode}
          maxLength={2}
          error={fieldError(t, state, "countryCode")}
        />
      </div>
      <MoreFields
        open={Boolean(state.fieldErrors?.["rate"] ?? state.fieldErrors?.["rateCurrency"])}
      >
        <fieldset className="m-0 flex flex-wrap items-end gap-12 border-0 p-0">
          <legend className="mb-8 text-label-13 font-medium">{t("fields.rate")}</legend>
          <Input
            id="profile-rate"
            name="rate"
            inputMode="decimal"
            label={t("fields.rateAmount")}
            help={t("fields.rateHelp")}
            defaultValue={p.rate}
            error={fieldError(t, state, "rate")}
          />
          <Select
            id="profile-rate-currency"
            name="rateCurrency"
            label={t("fields.rateCurrency")}
            value={p.rateCurrency || "USD"}
            options={[...props.currencies]}
            error={fieldError(t, state, "rateCurrency")}
          />
          <Select
            id="profile-rate-unit"
            name="rateUnit"
            label={t("fields.rateUnit")}
            value={p.rateUnit || "Day"}
            options={(["Hour", "Day", "Week", "Project"] as const).map((u) => ({
              value: u,
              label: t(`rateUnits.${u}`),
            }))}
          />
        </fieldset>
      </MoreFields>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("saveProfile")}
        </Button>
      </div>
    </form>
  );
}

// Privacy ---------------------------------------------------------------------------------------

export interface PrivacyFormProps {
  readonly org: string;
  readonly visibility: string;
  readonly searchIndexing: boolean;
  readonly marketplaceDiscoverable: boolean;
  readonly sections: readonly { readonly section: string; readonly value: string }[];
}

/** Section selects shown before More fields: with the three profile-wide fields, seven in all (gate 27). */
const VISIBLE_SECTIONS = 4;

export function PrivacyForm(props: PrivacyFormProps) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(savePrivacyAction, INITIAL);
  const [visibility, setVisibility] = useState(props.visibility);
  const levels = ["Private", "Network", "Public"] as const;
  const sectionSelect = (s: PrivacyFormProps["sections"][number]) => (
    <Select
      key={s.section}
      id={`section-${s.section}`}
      name={`section-${s.section}`}
      label={t(`sections.${s.section}`)}
      value={s.value}
      options={[
        { value: "inherit", label: t("privacy.inherit") },
        ...levels.map((v) => ({ value: v, label: t(`visibility.${v}`) })),
      ]}
    />
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex max-w-layout-form flex-col gap-16"
    >
      <input type="hidden" name="org" value={props.org} />
      <Status state={state} />
      <Select
        id="privacy-visibility"
        name="visibility"
        label={t("privacy.visibility")}
        help={t(`privacy.visibilityHelp.${visibility}`)}
        value={props.visibility}
        options={levels.map((v) => ({ value: v, label: t(`visibility.${v}`) }))}
        onChange={(e) => setVisibility(e.target.value)}
      />
      <div className="flex flex-col gap-4">
        <Checkbox
          id="privacy-indexing"
          name="searchIndexing"
          label={t("privacy.indexing")}
          defaultChecked={props.searchIndexing}
          disabled={visibility !== "Public"}
        />
        <p className="m-0 text-text-12 text-text-secondary">{t("privacy.indexingHelp")}</p>
      </div>
      <Checkbox
        id="privacy-discoverable"
        name="marketplaceDiscoverable"
        label={t("privacy.discoverable")}
        defaultChecked={props.marketplaceDiscoverable}
      />
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-heading-16 font-semibold">{t("privacy.sections")}</legend>
        <p className="m-0 text-text-12 text-text-secondary">{t("privacy.sectionsHelp")}</p>
        <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
          {props.sections.slice(0, VISIBLE_SECTIONS).map(sectionSelect)}
        </div>
        {props.sections.length > VISIBLE_SECTIONS ? (
          <MoreFields>
            <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
              {props.sections.slice(VISIBLE_SECTIONS).map(sectionSelect)}
            </div>
          </MoreFields>
        ) : null}
      </fieldset>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("privacy.save")}
        </Button>
      </div>
    </form>
  );
}

// Lists -----------------------------------------------------------------------------------------

export function AddItemForm({
  org,
  kind,
  submitLabel,
  children,
}: {
  org: string;
  kind: "skill" | "language" | "link" | "certification";
  submitLabel: string;
  children: ReactNode;
}) {
  const [state, action, pending] = useActionState(addProfileItemAction, INITIAL);
  const t = useCopy("profiles");
  const errors = Object.values(state.fieldErrors ?? {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="kind" value={kind} />
      <div className="flex flex-wrap items-end gap-12">{children}</div>
      {errors[0] ? <InlineAlert tone="danger">{t(`errors.${errors[0]}`)}</InlineAlert> : null}
      <Status state={state} />
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function RemoveItemButton({
  org,
  kind,
  id,
  label,
}: {
  org: string;
  kind: "skill" | "language" | "link" | "certification";
  id: string;
  label: string;
}) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(removeProfileItemAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        loading={pending}
        aria-label={t("removeNamed", { name: label })}
      >
        {t("remove")}
      </Button>
      {state.error ? <Status state={state} /> : null}
    </form>
  );
}

export function CarryCertificationButton({
  org,
  holderId,
  name,
}: {
  org: string;
  holderId: string;
  name: string;
}) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(carryCertificationAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="holderId" value={holderId} />
      <Button
        type="submit"
        size="sm"
        loading={pending}
        aria-label={t("certifications.carryNamed", { name })}
      >
        {t("certifications.carry")}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function AutoJoinButton({
  orgId,
  slug,
  name,
}: {
  orgId: string;
  slug: string;
  name: string;
}) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(autoJoinAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" size="sm" variant="primary" loading={pending}>
        {t("join.autoJoin", { name })}
      </Button>
      <Status state={state} />
    </form>
  );
}

// Organization profile -----------------------------------------------------------------------------

export interface OrgProfileFormProps {
  readonly org: string;
  readonly canEdit: boolean;
  readonly profileUrl: string;
  readonly profile: {
    readonly handle: string;
    readonly about: string;
    readonly websiteUrl: string;
    readonly contactEmail: string;
    readonly visibility: string;
    readonly searchIndexing: boolean;
  };
}

export function OrgProfileForm(props: OrgProfileFormProps) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(saveOrganizationProfileAction, INITIAL);
  const [visibility, setVisibility] = useState(props.profile.visibility);
  const disabled = !props.canEdit;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex max-w-layout-form flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={props.org} />
      <Status state={state} />
      <Input
        id="org-profile-handle"
        name="handle"
        label={t("fields.handle")}
        help={t("fields.orgHandleHelp", { url: props.profileUrl })}
        defaultValue={props.profile.handle}
        disabled={disabled}
        spellCheck={false}
        width="100%"
        error={fieldError(t, state, "handle")}
      />
      <Textarea
        id="org-profile-about"
        name="about"
        label={t("fields.about")}
        defaultValue={props.profile.about}
        disabled={disabled}
        maxLength={4000}
        width="100%"
      />
      <Input
        id="org-profile-website"
        name="websiteUrl"
        type="url"
        label={t("fields.website")}
        defaultValue={props.profile.websiteUrl}
        disabled={disabled}
        width="100%"
        error={fieldError(t, state, "websiteUrl")}
      />
      <Input
        id="org-profile-contact"
        name="contactEmail"
        type="email"
        label={t("fields.contactEmail")}
        defaultValue={props.profile.contactEmail}
        disabled={disabled}
        width="100%"
        error={fieldError(t, state, "contactEmail")}
      />
      <Select
        id="org-profile-visibility"
        name="visibility"
        label={t("privacy.visibility")}
        help={t(`privacy.orgVisibilityHelp.${visibility}`)}
        value={props.profile.visibility}
        disabled={disabled}
        options={(["Private", "Network", "Public"] as const).map((v) => ({
          value: v,
          label: t(`visibility.${v}`),
        }))}
        onChange={(e) => setVisibility(e.target.value)}
      />
      <div className="flex flex-col gap-4">
        <Checkbox
          id="org-profile-indexing"
          name="searchIndexing"
          label={t("privacy.indexing")}
          defaultChecked={props.profile.searchIndexing}
          disabled={disabled || visibility !== "Public"}
        />
        <p className="m-0 text-text-12 text-text-secondary">{t("privacy.indexingHelp")}</p>
      </div>
      {props.canEdit ? (
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("saveProfile")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

// Members: links, requests and offboarding ------------------------------------------------------

export function InviteLinkForm({ org, roles }: { org: string; roles: readonly Option[] }) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(createInviteLinkAction, INITIAL);
  const [copied, setCopied] = useState(false);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="link-role"
          name="roleId"
          label={t("join.linkRole")}
          value={roles[0]?.value ?? ""}
          options={[...roles]}
        />
        <Select
          id="link-days"
          name="days"
          label={t("join.linkExpires")}
          value="7"
          options={[1, 7, 14, 30].map((d) => ({
            value: String(d),
            label: t("join.days", { count: d }),
          }))}
        />
        <Input
          id="link-uses"
          name="maxUses"
          type="number"
          min={1}
          max={1000}
          label={t("join.linkUses")}
          defaultValue="25"
          error={fieldError(t, state, "maxUses")}
        />
      </div>
      <Status state={state} />
      {state.link ? (
        <div
          role="status"
          className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
        >
          <Input
            id="link-url"
            readOnly
            width="100%"
            label={t("join.linkCreated")}
            value={state.link}
          />
          <div className="flex items-center gap-12">
            <Button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(state.link ?? "");
                setCopied(true);
              }}
            >
              {t("join.copy")}
            </Button>
            {copied ? (
              <span className="text-text-13 text-success-text">{t("join.copied")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          {t("join.createLink")}
        </Button>
      </div>
    </form>
  );
}

export function RevokeLinkButton({ org, linkId }: { org: string; linkId: string }) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(revokeInviteLinkAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        {t("join.revoke")}
      </Button>
      {state.error ? <Status state={state} /> : null}
    </form>
  );
}

export function JoinRequestForm({
  org,
  requestId,
  name,
  roles,
}: {
  org: string;
  requestId: string;
  name: string;
  roles: readonly Option[];
}) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(decideJoinRequestAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-8">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex flex-wrap items-end gap-8">
        <Select
          id={`request-role-${requestId}`}
          name="roleId"
          label={t("join.roleFor", { name })}
          value={roles[roles.length - 1]?.value ?? ""}
          options={[...roles]}
        />
        <Button
          type="submit"
          name="decision"
          value="approve"
          size="sm"
          variant="primary"
          loading={pending}
        >
          {t("join.approve")}
        </Button>
        <Button type="submit" name="decision" value="decline" size="sm" variant="ghost">
          {t("join.decline")}
        </Button>
      </div>
      <Status state={state} />
    </form>
  );
}

export function OffboardingForm({
  org,
  offboardingId,
  name,
  openRecords,
  members,
}: {
  org: string;
  offboardingId: string;
  name: string;
  openRecords: number;
  members: readonly Option[];
}) {
  const t = useCopy("profiles");
  const [state, action, pending] = useActionState(offboardingAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-8">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="offboardingId" value={offboardingId} />
      <p className="m-0 text-text-13">{t("offboarding.summary", { name, count: openRecords })}</p>
      <div className="flex flex-wrap items-end gap-8">
        {openRecords > 0 ? (
          <>
            <Select
              id={`offboarding-to-${offboardingId}`}
              name="toPersonId"
              label={t("offboarding.reassignTo")}
              value={members[0]?.value ?? ""}
              options={[...members]}
            />
            <Button type="submit" name="intent" value="reassign" size="sm" loading={pending}>
              {t("offboarding.reassign")}
            </Button>
          </>
        ) : (
          <Button
            type="submit"
            name="intent"
            value="complete"
            size="sm"
            variant="primary"
            loading={pending}
          >
            {t("offboarding.complete")}
          </Button>
        )}
      </div>
      <Status state={state} />
    </form>
  );
}
