import type { Route } from "next";
import Link from "next/link";
import { Badge, BrandMark } from "@/components/ui";
import type { Conversation } from "@/lib/conversations";
import { formatDateTime } from "@/lib/format";
import type { Translate } from "@/lib/shell/translate";

/** The conversation list: org, subject, context, last activity and unread count. */
export function ConversationList({
  conversations,
  activeKey,
  locale,
  t,
}: {
  conversations: readonly Conversation[];
  activeKey?: string;
  locale: string;
  t: Translate;
}) {
  const metaLine = (c: Conversation) =>
    [c.orgName, c.context ?? t("gateway.messages.withOrg"), formatDateTime(locale, c.at)]
      .filter(Boolean)
      .join(" · ");
  return (
    <nav aria-label={t("nav.gateway.primary.messages")}>
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
        {conversations.map((c) => (
          <li key={c.key}>
            <Link
              href={`/messages/${c.key}` as Route}
              aria-current={c.key === activeKey ? "page" : undefined}
              className="flex min-h-touch-min items-start gap-12 px-16 py-12 text-text-primary no-underline hover:bg-bg-hover aria-[current=page]:bg-bg-hover"
            >
              <BrandMark name={c.orgName} size="sm" iconOnly />
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="flex items-center gap-8">
                  <span
                    className={`truncate ${c.unread > 0 ? "font-semibold" : "font-medium"}`}
                    title={c.subject}
                  >
                    {c.subject}
                  </span>
                  {c.unread > 0 ? (
                    <Badge
                      count={c.unread}
                      tone="accent"
                      label={t("gateway.messages.unread", { n: c.unread })}
                    />
                  ) : null}
                </span>
                {/* A longer translation ellipsizes with the whole line as its title. */}
                <span className="truncate text-text-13 text-text-secondary" title={metaLine(c)}>
                  {metaLine(c)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
