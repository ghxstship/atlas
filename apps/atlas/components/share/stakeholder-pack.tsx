import type { PackMeta, PackRefusal, PublicPackItem } from "@xos/data/stakeholder-packs";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert, Input } from "@/components/ui";

/**
 * The server-rendered parts of a stakeholder pack page (B2, ADR 0141). Every form here posts natively to a URL
 * action, so a click before hydration still works and no client code loads.
 */

/** The code form. A device with grants of this recipient opens with no code, so the field is only asked for without. */
export async function PackCodeForm({
  token,
  reason,
  hasGrants,
}: {
  token: string;
  reason: PackRefusal | null;
  hasGrants: boolean;
}) {
  const t = await getTranslations("compliance.stakeholderPack");
  const locked = reason === "pack_locked" || reason === "pack_link_expired";
  return (
    <div className="mx-auto flex max-w-layout-form flex-col gap-16">
      <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
      {reason && reason !== "pack_grant" ? (
        <InlineAlert tone={locked ? "danger" : "warning"}>{t(`refusals.${reason}`)}</InlineAlert>
      ) : null}
      {locked ? null : (
        <form method="post" action={`/share/pack/${token}/open`} className="flex flex-col gap-12">
          <Input
            width="100%"
            id="pack-access-code"
            name="accessCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required={!hasGrants}
            label={t("accessCode")}
            help={t("accessCodeHelp")}
            autoFocus
          />
          <Button type="submit" variant="primary" className="w-full">
            {t("submit")}
          </Button>
        </form>
      )}
    </div>
  );
}

export async function PackHeader({
  meta,
  recipientName,
}: {
  meta: PackMeta;
  recipientName: string;
}) {
  const t = await getTranslations("compliance.stakeholderPack");
  return (
    <header
      className="flex flex-col gap-4 border-t-4 pt-12"
      style={meta.brandAccentHex ? { borderColor: meta.brandAccentHex } : undefined}
    >
      <p className="m-0 text-text-13 text-text-secondary">
        {meta.brandName} · {meta.projectName}
      </p>
      <h1 className="m-0 text-heading-24 font-semibold">{meta.packName}</h1>
      <p className="m-0 text-text-13 text-text-secondary">{t("for", { name: recipientName })}</p>
      {meta.message ? <p className="m-0 whitespace-pre-line text-text-14">{meta.message}</p> : null}
    </header>
  );
}

/** One item: a link to a live item or a download, and the acknowledgement it asks for. */
export async function PackItemRow({
  token,
  item,
  signedOn,
}: {
  token: string;
  item: PublicPackItem;
  signedOn: string | null;
}) {
  const t = await getTranslations("compliance.stakeholderPack");
  const base = `/share/pack/${token}/items/${item.id}`;
  return (
    <li className="flex flex-col gap-8 py-12">
      <span className="flex flex-wrap items-center justify-between gap-8">
        <span className="text-text-14 text-text-primary">{item.title}</span>
        {!item.available ? (
          <span className="text-text-12 text-text-secondary">{t("unavailable")}</span>
        ) : item.kind === "File" ? (
          <form method="post" action={`${base}/file`}>
            <Button type="submit" size="sm" variant="secondary">
              {t("download")}
            </Button>
          </form>
        ) : (
          <a className="text-label-13 text-accent-text underline" href={base}>
            {t("view")}
          </a>
        )}
      </span>
      {item.requiresAcknowledgement && item.available ? (
        signedOn ? (
          <span className="text-text-12 text-text-secondary">
            {t("signedOn", { date: signedOn })}
          </span>
        ) : (
          <form method="post" action={`${base}/sign`} className="flex flex-col gap-8">
            <Input
              width="100%"
              id={`sign-${item.id}`}
              name="signerName"
              maxLength={200}
              required
              label={t("signerName")}
              help={t("signerHelp")}
            />
            <div>
              <Button type="submit" size="sm" variant="secondary">
                {t("sign")}
              </Button>
            </div>
          </form>
        )
      ) : null}
    </li>
  );
}
