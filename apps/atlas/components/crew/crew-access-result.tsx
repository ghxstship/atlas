"use client";

import { Button, InlineAlert, QRCode, Tag } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import type { IssuedLink, IssueState } from "@/app/[org]/crew/access-links/actions";

/** The link and code of one worker, once, with a card to print. */
function IssuedCard({ link, projectName }: { link: IssuedLink; projectName: string }) {
  const t = useTranslations("crew.crewAccess.result");
  const format = useFormatter();
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const copy = async (what: "link" | "code", text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
  };
  const absolute = /^https?:\/\//.test(link.url);
  return (
    <li className="flex flex-col gap-8 rounded-card border border-border-subtle p-12 print:break-inside-avoid">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="m-0 text-text-14 font-semibold">{link.personName ?? t("unnamed")}</p>
          <p className="m-0 text-text-12 text-text-secondary">
            {t("card", {
              project: projectName,
              expires: format.dateTime(new Date(link.expiresAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </p>
          <p className="m-0 break-all font-mono text-text-12">{link.url}</p>
          <p className="m-0 text-text-13 print:hidden">
            {t("code")} <span className="font-mono font-semibold">{link.accessCode}</span>
          </p>
        </div>
        {absolute ? (
          <QRCode value={link.url} label={t("qr", { name: link.personName ?? "" })} size={120} />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-8 print:hidden">
        <Button type="button" variant="secondary" onClick={() => void copy("link", link.url)}>
          {t("copyLink")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void copy("code", link.accessCode)}
        >
          {t("copyCode")}
        </Button>
        {copied ? (
          <span role="status" className="text-text-12 text-text-secondary">
            {t(copied === "link" ? "copiedLink" : "copiedCode")}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Holds the tokens only in this component: nothing refreshes the page until the person closes it. */
export function ResultPanel({ state, closeHref }: { state: IssueState; closeHref: string }) {
  const t = useTranslations("crew.crewAccess.result");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const links = state.links ?? [];
  return (
    <section aria-labelledby="crew-access-result" className="flex flex-col gap-12">
      <h2 id="crew-access-result" className="m-0 text-heading-16 font-semibold print:hidden">
        {t("title", { count: links.length })}
      </h2>
      <InlineAlert tone="warning">{t("once")}</InlineAlert>
      <ul className="m-0 flex list-none flex-col gap-12 p-0">
        {links.map((link) => (
          <IssuedCard key={link.linkId} link={link} projectName={state.projectName ?? ""} />
        ))}
      </ul>
      <div className="flex flex-wrap gap-8 print:hidden">
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          {t("print")}
        </Button>
        {confirming ? (
          <>
            <p className="m-0 w-full text-text-13">{t("closeConfirm")}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                router.push(closeHref as Route);
                router.refresh();
              }}
            >
              {t("closeSure")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              {t("keepOpen")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            {t("close")}
          </Button>
        )}
      </div>
    </section>
  );
}
