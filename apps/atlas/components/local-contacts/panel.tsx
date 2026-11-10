"use client";

import {
  LOCAL_CONTACT_AUDIENCES,
  LOCAL_CONTACT_ROLES,
  type LocalContact,
} from "@xos/data/local-contacts";
import { Button, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { deleteLocalContactAction, saveLocalContactAction, type LocalContactForm } from "./actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A contact as the panel shows it: the phone formatted and, when it dials, its tel: number, worked out on the server. */
export type ShownContact = LocalContact & {
  readonly phoneDisplay: string | null;
  readonly tel: string | null;
};

/**
 * Local contacts of a day sheet or a venue (B5, G-56): role, name, title, organization, a tel: link for a number that
 * dials (E.164; a work phone stored before A139 shows formatted, without the call button) and a mailto: link, with
 * Add and Edit for writers. A Member row names a member of the org, read live from the directory; a Contact row is
 * typed. Copy lives under `<namespace>.localContacts`, in show.json for the day sheet and places.json for the venue.
 */
export function LocalContactsPanel({
  org,
  namespace,
  home,
  day,
  contacts,
  members,
  canWrite,
}: {
  org: string;
  namespace: "show" | "places";
  /** Where new rows go: the project (with the sheet's day for This day) or the venue. */
  home: { readonly projectId: string } | { readonly venueId: string };
  /** The day sheet's day; null on the venue peek. */
  day: string | null;
  contacts: readonly ShownContact[];
  members: readonly { readonly membershipId: string; readonly name: string }[];
  canWrite: boolean;
}) {
  const t = useTranslations(`${namespace}.localContacts`) as unknown as Translate;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const remove = (id: string) =>
    start(async () => {
      const r = await deleteLocalContactAction(org, id);
      setError(r.ok ? null : t(`errors.${r.key}`));
    });
  return (
    <section aria-label={t("title")} className="flex flex-col gap-8">
      <h3 className="m-0 text-label-14 font-semibold">{t("title")}</h3>
      {contacts.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {contacts.map((c) =>
          editing === c.id ? (
            <li key={c.id} className="py-8">
              <ContactForm
                t={t}
                org={org}
                members={members}
                contact={c}
                target={{ id: c.id, ...(day !== null && c.projectId ? { day: c.day } : {}) }}
                allowDayScope={day !== null && c.venueId === null}
                day={day}
                onDone={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-8 py-8">
              <span className="flex flex-col gap-2">
                <span className="text-text-14">
                  <span className="text-text-12 text-text-secondary">{t(`roles.${c.role}`)}</span>{" "}
                  {c.displayName ?? ""}
                  {c.title ? (
                    <span className="text-text-13 text-text-secondary"> · {c.title}</span>
                  ) : null}
                </span>
                {c.organizationName ? (
                  <span className="text-text-12 text-text-secondary">{c.organizationName}</span>
                ) : null}
                <span className="flex flex-wrap gap-12 text-text-13">
                  {c.phoneDisplay ? (
                    c.tel ? (
                      <a className="text-text-link" href={`tel:${c.tel}`}>
                        {c.phoneDisplay}
                      </a>
                    ) : (
                      <span>{c.phoneDisplay}</span>
                    )
                  ) : null}
                  {c.email ? (
                    <a className="text-text-link" href={`mailto:${c.email}`}>
                      {c.email}
                    </a>
                  ) : null}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {[
                    c.venueId ? t("scope.venue") : c.day ? t("scope.thisDay") : t("scope.everyDay"),
                    t(`audience.${c.audience}`),
                    c.source === "Member" ? t("source.Member") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {canWrite && (c.venueId === null || namespace === "places") ? (
                <span className="flex gap-4">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(c.id)}>
                    {t("edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => remove(c.id)}
                  >
                    {t("remove", { name: c.displayName ?? "" })}
                  </Button>
                </span>
              ) : null}
            </li>
          ),
        )}
      </ul>
      {error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
      {canWrite ? (
        editing === "new" ? (
          <ContactForm
            t={t}
            org={org}
            members={members}
            target={
              "venueId" in home ? { venueId: home.venueId } : { projectId: home.projectId, day }
            }
            allowDayScope={day !== null}
            day={day}
            onDone={() => setEditing(null)}
          />
        ) : (
          <div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing("new")}>
              {t("add")}
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

function ContactForm({
  t,
  org,
  members,
  contact,
  target,
  allowDayScope,
  day,
  onDone,
}: {
  t: Translate;
  org: string;
  members: readonly { readonly membershipId: string; readonly name: string }[];
  contact?: LocalContact;
  target: Parameters<typeof saveLocalContactAction>[1];
  allowDayScope: boolean;
  day: string | null;
  onDone: () => void;
}) {
  const [source, setSource] = useState<"Member" | "Contact">(contact?.source ?? "Contact");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const value = (name: string) => {
          const v = data.get(name);
          return typeof v === "string" ? v : "";
        };
        const form: LocalContactForm = {
          role: value("role"),
          title: value("title"),
          audience: value("audience"),
          notes: value("notes"),
          ...(source === "Member"
            ? { membershipId: value("membershipId") }
            : { name: value("name"), phone: value("phone"), email: value("email") }),
        };
        const scoped =
          allowDayScope && !("venueId" in target)
            ? { ...target, day: value("scope") === "thisDay" ? day : null }
            : target;
        start(async () => {
          const r = await saveLocalContactAction(org, scoped, form);
          if (r.ok) onDone();
          else setError(t(`errors.${r.key}`));
        });
      }}
    >
      <Select
        name="source"
        label={t("fields.source")}
        value={source}
        onChange={(e) => setSource(e.target.value === "Member" ? "Member" : "Contact")}
        options={[
          { value: "Contact", label: t("source.Contact") },
          { value: "Member", label: t("source.Member") },
        ]}
      />
      {source === "Member" ? (
        <FieldSelect
          name="membershipId"
          label={t("fields.member")}
          help={t("fields.memberHelp")}
          defaultValue={contact?.membershipId ?? members[0]?.membershipId ?? ""}
          options={members.map((m) => ({ value: m.membershipId, label: m.name }))}
        />
      ) : (
        <>
          <Input
            name="name"
            label={t("fields.name")}
            required
            defaultValue={contact?.source === "Contact" ? (contact.displayName ?? "") : ""}
          />
          <Input
            name="phone"
            type="tel"
            label={t("fields.phone")}
            help={t("fields.phoneHelp")}
            defaultValue={contact?.source === "Contact" ? (contact.phone ?? "") : ""}
          />
          <Input
            name="email"
            type="email"
            label={t("fields.email")}
            defaultValue={contact?.source === "Contact" ? (contact.email ?? "") : ""}
          />
        </>
      )}
      <Input name="title" label={t("fields.title")} defaultValue={contact?.title ?? ""} />
      <FieldSelect
        name="role"
        label={t("fields.role")}
        defaultValue={contact?.role ?? "Production"}
        options={LOCAL_CONTACT_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
      />
      {allowDayScope ? (
        <FieldSelect
          name="scope"
          label={t("fields.scope")}
          defaultValue={contact?.day ? "thisDay" : "everyDay"}
          options={[
            { value: "everyDay", label: t("scope.everyDay") },
            { value: "thisDay", label: t("scope.thisDay") },
          ]}
        />
      ) : null}
      <FieldSelect
        name="audience"
        label={t("fields.audience")}
        help={t("fields.audienceHelp")}
        defaultValue={contact?.audience ?? "Internal"}
        options={LOCAL_CONTACT_AUDIENCES.map((a) => ({ value: a, label: t(`audience.${a}`) }))}
      />
      <Textarea
        name="notes"
        label={t("fields.notes")}
        rows={2}
        defaultValue={contact?.notes ?? ""}
      />
      {error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex gap-8">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

/** A select that starts on a value and keeps the person's choice, for a form read on submit. */
function FieldSelect({
  defaultValue,
  ...props
}: {
  name: string;
  label: string;
  help?: string;
  defaultValue: string;
  options: { value: string; label: string }[];
}) {
  const [value, setValue] = useState(defaultValue);
  return <Select {...props} value={value} onChange={(e) => setValue(e.target.value)} />;
}
