"use client";

import { Avatar } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ActivityDescription } from "./describe";

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
  const peekHref = (key: string) => {
    const q = new URLSearchParams(search.toString());
    q.set("peek", key);
    q.delete("full");
    return `${pathname}?${q.toString()}` as Route;
  };
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
              {description.target}
            </NextLink>
          ) : (
            <span className="font-medium">{description.target}</span>
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
