"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import {
  CLASSIFICATIONS,
  maxShareDays,
  shareLinkActive,
  type DataClassification,
  type ShareLink,
} from "@xos/data/share-links";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import {
  classifyFileAction,
  createShareLinkAction,
  loadShareLinksAction,
  revokeShareLinkAction,
  type CreatedLink,
} from "@/lib/files/share-actions";

/**
 * Sharing one file (Section 8.6, finding A65-016): its classification, its links and a form for a new
 * link. Loaded only when someone opens it, so record pages carry none of this code until then. The new
 * link's address and access code are shown once; only their hashes are kept.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function CopyField({
  id,
  label,
  value,
  help,
}: {
  id: string;
  label: string;
  value: string;
  help?: string;
}) {
  const t = useTranslations("compliance.share.created");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-end gap-8">
      <Input id={id} label={label} value={value} readOnly width="100%" help={help ?? ""} />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

function LinkRow({
  org,
  link,
  onRevoked,
}: {
  org: string;
  link: ShareLink;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("compliance.share") as unknown as Translate;
  const format = useFormatter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const active = shareLinkActive(link);
  const status = link.revokedAt
    ? t("row.revoked")
    : link.locked
      ? t("row.locked")
      : active
        ? null
        : t("row.expired");
  return (
    <li className="flex flex-wrap items-center justify-between gap-8 py-8">
      <span className="flex min-w-0 flex-col text-text-12 text-text-secondary">
        <span className="text-text-13 text-text-primary">
          {link.note ??
            t("row.made", {
              date: format.dateTime(new Date(link.createdAt), { dateStyle: "medium" }),
            })}
          {link.accessCodeRequired ? ` · ${t("row.codeRequired")}` : ""}
        </span>
        <span>
          {link.expiresAt
            ? t("row.expires", {
                date: format.dateTime(new Date(link.expiresAt), { dateStyle: "medium" }),
              })
            : t("row.never")}
          {" · "}
          {t("row.opened", { count: link.openCount })}
          {link.recipientEmail ? ` · ${t("row.for", { email: link.recipientEmail })}` : ""}
        </span>
        {status ? <span>{status}</span> : null}
        {error ? (
          <span role="alert" className="text-danger-text">
            {t(`errors.${error}`)}
          </span>
        ) : null}
      </span>
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={() =>
            start(async () => {
              const result = await revokeShareLinkAction(org, link.id);
              if (result.ok) onRevoked(link.id);
              else setError(result.error);
            })
          }
        >
          {t("row.revoke")}
        </Button>
      ) : null}
    </li>
  );
}

export function SharePanel({
  org,
  attachmentId,
  name,
  classification: initial,
}: {
  org: string;
  attachmentId: string;
  name: string;
  classification: DataClassification;
}) {
  const t = useTranslations("compliance") as unknown as Translate;
  const id = useId();
  const [classification, setClassification] = useState<DataClassification>(initial);
  const [links, setLinks] = useState<readonly ShareLink[] | null>(null);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const confidential = classification === "Confidential";
  const limit = maxShareDays(classification);

  const refresh = useCallback(() => {
    void loadShareLinksAction(org, attachmentId).then((result) => {
      if (result.ok) setLinks(result.data);
      else setError(result.error);
    });
  }, [org, attachmentId]);
  useEffect(refresh, [refresh]);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-12 rounded-md border border-border-subtle p-12"
    >
      <h3 id={`${id}-title`} className="m-0 text-heading-14 font-semibold">
        {t("share.title", { name })}
      </h3>

      <form
        className="flex flex-wrap items-end gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("classification");
          setError(null);
          setNotice(null);
          start(async () => {
            const result = await classifyFileAction(org, attachmentId, String(value));
            if (result.ok) {
              setClassification(result.data);
              setNotice(t("classification.saved"));
              refresh();
            } else setError(result.error);
          });
        }}
      >
        <Select
          id={`${id}-classification`}
          name="classification"
          label={t("classification.label")}
          help={t(`classification.rules.${classification}`)}
          value={classification}
          options={CLASSIFICATIONS.map((c) => ({
            value: c,
            label: t(`classification.levels.${c}`),
          }))}
        />
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          {t("classification.save")}
        </Button>
      </form>
      {notice ? (
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {notice}
        </p>
      ) : null}
      {error ? <InlineAlert tone="danger">{t(`share.errors.${error}`)}</InlineAlert> : null}

      <div className="flex flex-col gap-4">
        <h4 className="m-0 text-label-13 font-medium">{t("share.links")}</h4>
        {links === null ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("share.loading")}</p>
        ) : links.length === 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("share.noLinks")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {links.map((l) => (
              <LinkRow key={l.id} org={org} link={l} onRevoked={() => refresh()} />
            ))}
          </ul>
        )}
      </div>

      {created ? (
        <div className="flex flex-col gap-8" role="status">
          <h4 className="m-0 text-label-13 font-medium">{t("share.created.heading")}</h4>
          <p className="m-0 text-text-12 text-text-secondary">{t("share.created.copyOnce")}</p>
          <CopyField id={`${id}-url`} label={t("share.created.link")} value={created.url} />
          {created.accessCode ? (
            <CopyField
              id={`${id}-code`}
              label={t("share.created.code")}
              value={created.accessCode}
              help={t("share.created.codeHelp")}
            />
          ) : null}
        </div>
      ) : null}

      {limit === null ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("share.create.restricted")}</p>
      ) : (
        <form
          className="flex flex-col gap-8"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError(null);
            setNotice(null);
            start(async () => {
              const result = await createShareLinkAction(org, {
                attachmentId,
                expiresOn: String(form.get("expiresOn") ?? ""),
                accessCode: confidential || form.get("accessCode") === "on",
                recipientEmail: String(form.get("recipientEmail") ?? "").trim(),
                note: String(form.get("note") ?? ""),
              });
              if (result.ok) {
                setCreated(result.data);
                refresh();
              } else setError(result.error);
            });
          }}
        >
          <h4 className="m-0 text-label-13 font-medium">{t("share.create.heading")}</h4>
          <Input
            id={`${id}-expires`}
            name="expiresOn"
            type="date"
            label={t("share.create.expiresOn")}
            defaultValue={day(7)}
            min={day(0)}
            max={day(limit)}
            help={
              classification === "Public"
                ? t("share.create.noExpiry")
                : t("share.create.expiresHelp", { days: limit })
            }
          />
          {confidential ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("share.create.accessCodeForced")}
            </p>
          ) : (
            <Checkbox id={`${id}-code`} name="accessCode" label={t("share.create.accessCode")} />
          )}
          <Input
            id={`${id}-recipient`}
            name="recipientEmail"
            type="email"
            autoComplete="off"
            label={t("share.create.recipient")}
            help={confidential ? t("share.create.recipientHelp") : ""}
            required={confidential}
          />
          <Input id={`${id}-note`} name="note" label={t("share.create.note")} maxLength={200} />
          <div>
            <Button type="submit" size="sm" loading={pending}>
              {t("share.create.submit")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
