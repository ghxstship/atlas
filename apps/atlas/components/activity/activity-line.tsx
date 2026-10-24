"use client";

import { Avatar } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import type { ActivityDescription } from "./describe";
import { peekHref as shellPeekHref } from "@/lib/shell/peek";

/**
 * What an entry acted on, each value its own text node (a key, a name, a role, a start), never one string built from
 * them: the en-XA check (gate 16) then reads each value as the data it is, even one holding a separator itself.
 */
export function ActivityTarget({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}

/**
 * One activity line (A59-030): who, the verb, and the thing acted on, named in the body font (a record
 * by its key and title, as a link that opens it in the peek), never a monospace kind. A run of identical
 * events reads once with a count. Section 11.10 item 2 keeps monospace for codes.
 */
export function ActivityLine({
  description,
  time,
  count = 1,
}: {
  description: ActivityDescription;
  time: string;
  count?: number;
}) {
  const t = useTranslations("activity.feed");
  const pathname = usePathname();
  const search = useSearchParams();
  const org = pathname.split("/")[1] ?? "";
  // A peek where the shell opens it, else the record page (lib/shell/peek).
  const peekHref = (key: string) => shellPeekHref(org, pathname, search.toString(), key) as Route;
  return (
    <article className="flex max-w-(--layout-peek) items-start gap-12">
      <Avatar name={description.actor} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <p className="m-0">
          <strong className="font-semibold">{description.actor}</strong>{" "}
          <span className="text-text-secondary">{description.action}</span>{" "}
          {description.recordKey ? (
            <NextLink
              href={peekHref(description.recordKey)}
              scroll={false}
              className="font-medium text-accent-text no-underline hover:underline"
            >
              <ActivityTarget parts={description.targetParts} />
            </NextLink>
          ) : (
            <span className="font-medium">
              <ActivityTarget parts={description.targetParts} />
            </span>
          )}
          {count > 1 ? <span className="text-text-secondary"> {t("times", { count })}</span> : null}{" "}
          <time className="text-text-secondary">{time}</time>
        </p>
        {description.comment ? (
          <div className="rounded-card border border-border-subtle bg-bg-surface px-12 py-8">
            {description.comment}
          </div>
        ) : null}
      </div>
    </article>
  );
}
