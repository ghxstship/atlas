import {
  amIPlatformStaff,
  FEEDBACK_STATES,
  feedbackScreenshotUrl,
  listFeedbackForTriage,
  type FeedbackItem,
  type FeedbackState,
} from "@xos/data/feedback";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TriageForm } from "@/components/help/triage-form";
import { InlineAlert } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("firstRun.triage");
  return { title: t("title"), robots: { index: false } };
}

/**
 * Product feedback triage for platform staff (Section 11.7, A96, migration 1531): every submission from Atlas and
 * Gateway, newest first, filtered by state, each with its sender, page context, screenshot (a five-minute link once
 * the upload scan found it Clean) and a triage form. Anyone who is not platform staff gets 404, like any page they
 * may not see. The operator console (A90) is the long-term home for this list.
 */
export default async function FeedbackTriagePage({ searchParams }: PageProps<"/support/feedback">) {
  const viewer = await getViewer();
  if (!viewer?.person) notFound();
  const staff = await amIPlatformStaff(viewer.db);
  if (!staff.ok || !staff.data) notFound();
  const requested = (await searchParams)["state"];
  const state = FEEDBACK_STATES.find((s) => s === requested) ?? null;
  const [t, locale, items] = await Promise.all([
    getTranslations("firstRun.triage"),
    getLocale(),
    listFeedbackForTriage(viewer.db, state),
  ]);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  const links = new Map<string, string>();
  if (items.ok) {
    await Promise.all(
      items.data
        .filter((i) => i.screenshotPath !== null && i.screenshotScan === "Clean")
        .map(async (i) => {
          const url = await feedbackScreenshotUrl(viewer.db, i.screenshotPath ?? "");
          if (url.ok) links.set(i.id, url.data);
        }),
    );
  }
  const screenshot = (item: FeedbackItem) => {
    if (item.screenshotPath === null) return null;
    const link = links.get(item.id);
    if (link)
      return (
        <a
          className="text-text-13 font-medium text-accent-text underline"
          href={link}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t("openScreenshot")}
        </a>
      );
    return (
      <span className="text-text-12 text-text-secondary">
        {item.screenshotScan === "Infected" || item.screenshotScan === "Scan Failed"
          ? t("screenshotBlocked")
          : t("screenshotScanning")}
      </span>
    );
  };
  const filters: readonly (FeedbackState | "All")[] = ["All", ...FEEDBACK_STATES];
  return (
    <main id="content" className="mx-auto flex max-w-layout-reading flex-col gap-16 p-24">
      <header className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-24 font-semibold">{t("title")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">{t("description")}</p>
      </header>
      <nav aria-label={t("filter")} className="flex flex-wrap gap-8">
        {filters.map((f) => {
          const active = (f === "All" && state === null) || f === state;
          return (
            <Link
              key={f}
              href={(f === "All" ? "/support/feedback" : `/support/feedback?state=${f}`) as Route}
              aria-current={active ? "page" : undefined}
              className={`rounded-control px-12 py-4 text-text-13 ${active ? "bg-bg-selected font-medium" : "text-text-secondary hover:bg-bg-hover"}`}
            >
              {t(`filters.${f}`)}
            </Link>
          );
        })}
      </nav>
      {!items.ok ? (
        <InlineAlert tone="danger">{t("failed")}</InlineAlert>
      ) : items.data.length === 0 ? (
        <p className="m-0 text-text-secondary">{t("empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-16 p-0">
          {items.data.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
              data-testid="feedback-item"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="font-medium">{item.number}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("sent", { when: when(item.createdAt), app: item.app })}
                </span>
              </div>
              <p className="m-0 whitespace-pre-wrap text-text-14">{item.message}</p>
              <p className="m-0 flex flex-wrap gap-x-12 text-text-12 text-text-secondary">
                <span>
                  {item.senderName ? t("from", { name: item.senderName }) : t("fromUnknown")}
                </span>
                {item.route ? <span>{t("page", { route: item.route })}</span> : null}
              </p>
              {screenshot(item)}
              <TriageForm id={item.id} state={item.state} note={item.note} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
