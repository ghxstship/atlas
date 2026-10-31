"use client";

import { InlineAlert } from "@xos/ui";
import type { IssueCheck } from "@xos/data/credentials";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import { loadIssueChecks } from "@/lib/credentials/actions";

/**
 * The issue form's checks (B8, app.credential_issue_check): read again whenever the category, the holder or the window
 * changes. A blocking item (training missing, a duplicate badge) names what to do with a link, and keeps Issue
 * disabled while it holds; the rest are warnings. Loaded with next/dynamic from the Issued page's form, so no other
 * page carries its code.
 */
export function IssueChecks({
  org,
  timeZone,
  requirementHrefs,
}: {
  org: string;
  timeZone: string;
  /** Where each requirement of the project's categories opens: its course or its certification. */
  requirementHrefs: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("credentials.checks");
  const anchor = useRef<HTMLDivElement>(null);
  const [checks, setChecks] = useState<readonly IssueCheck[]>([]);

  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    let latest = 0;
    const read = () => {
      const data = new FormData(form);
      const value = (name: string) => String(data.get(name) ?? "");
      if (!value("categoryId") || !value("holderPersonId")) {
        setChecks([]);
        return;
      }
      const ticket = ++latest;
      void loadIssueChecks({
        org,
        timeZone,
        categoryId: value("categoryId"),
        holderPersonId: value("holderPersonId"),
        validFrom: value("validFrom"),
        validTo: value("validTo"),
      }).then((next) => {
        if (ticket === latest) setChecks(next);
      });
    };
    read();
    form.addEventListener("change", read);
    return () => form.removeEventListener("change", read);
  }, [org, timeZone]);

  const blocking = checks.some((c) => c.blocking);
  useEffect(() => {
    const submit = anchor.current
      ?.closest("form")
      ?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = blocking;
  }, [blocking]);

  if (checks.length === 0) return <div ref={anchor} className="basis-full" />;
  const line = (c: IssueCheck) => {
    switch (c.code) {
      case "training_missing":
        return t("training_missing", { title: c.title ?? "" });
      case "training_expires_first":
        return t("training_expires_first", { title: c.title ?? "" });
      case "other_badge_on_project":
        return t("other_badge_on_project", { title: c.title ?? "" });
      case "booked_elsewhere":
        return t("booked_elsewhere", { project: c.projectKey ?? t("anotherProduction") });
      default:
        return t(c.code);
    }
  };
  const href = (c: IssueCheck) =>
    c.requirementId ? (requirementHrefs[c.requirementId] ?? null) : null;
  return (
    <div ref={anchor} className="basis-full" aria-live="polite">
      <InlineAlert tone={blocking ? "danger" : "warning"} title={t("title")}>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {checks.map((c, i) => {
            const to = href(c);
            return (
              <li key={`${c.code}-${c.requirementId ?? c.otherCredentialId ?? i}`}>
                {line(c)}
                {c.blocking ? ` ${t("blocking")}` : ""}
                {to ? (
                  <>
                    {" "}
                    <Link href={to as Route} className="underline">
                      {t("open")}
                    </Link>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      </InlineAlert>
    </div>
  );
}
