import type { Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { InlineAlert } from "@/components/ui";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate, type Translate } from "@/lib/shell/translate";

/**
 * Server building blocks of the A86 settings surfaces (RRR-131): a titled section, a quiet sentence for an empty
 * list, a row list, status chips, and date formatting in the viewer's locale and the org's time zone. They match
 * the sections the other contributed panels draw (a52, a80).
 */

export const P = "settingsSurfaces";

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {description ? <p className="m-0 text-text-13 text-text-secondary">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** A sentence for a list with nothing in it yet, inside a section that has more to offer. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}

export interface Row {
  readonly id: string;
  readonly title: ReactNode;
  readonly meta?: readonly (ReactNode | null | false)[];
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

export function Rows({ label, rows }: { label: string; rows: readonly Row[] }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
    >
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-8 py-12">
          <div className="flex flex-wrap items-start justify-between gap-12">
            <div className="flex min-w-0 flex-col gap-4">
              <span className="flex flex-wrap items-center gap-8 text-label-13 font-medium">
                {r.title}
              </span>
              {r.meta && r.meta.some(Boolean) ? (
                <span className="flex flex-wrap gap-x-12 gap-y-4 text-text-12 text-text-secondary">
                  {r.meta.filter(Boolean).map((m, i) => (
                    <span key={i}>{m}</span>
                  ))}
                </span>
              ) : null}
            </div>
            {r.actions ? <div className="flex flex-wrap items-start gap-8">{r.actions}</div> : null}
          </div>
          {r.children}
        </li>
      ))}
    </ul>
  );
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "success" | "warning" | "danger" | "neutral";
}) {
  const color =
    tone === "success"
      ? "text-success-text"
      : tone === "warning"
        ? "text-warning-text"
        : tone === "danger"
          ? "text-danger-text"
          : "text-text-secondary";
  return (
    <span
      className={`inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium ${color}`}
    >
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-text-12">{children}</code>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href as Route} className="text-text-13 text-accent-text underline">
      {children}
    </Link>
  );
}

export function LoadFailed({ t }: { t: Translate }) {
  return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
}

/** A form placed under a quiet heading, for the "add one" part of a section. */
export function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-12 rounded-card border border-border-subtle p-16">
      <h3 className="m-0 text-heading-14 font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export interface Formatters {
  readonly t: Translate;
  readonly locale: string;
  /** A date and time in the org's time zone, for example "Oct 21, 2026, 9:05 AM". */
  readonly when: (iso: string) => string;
  /** A date in the org's time zone. */
  readonly day: (iso: string) => string;
  readonly number: (value: number) => string;
  readonly money: (minor: number, currency: string) => string;
}

export async function formatters(ctx: OrgContext): Promise<Formatters> {
  const [t, locale, zone] = await Promise.all([getTranslate(), getLocale(), getOrgTimeZone(ctx)]);
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: zone });
  const number = new Intl.NumberFormat(locale);
  return {
    t,
    locale,
    when: (iso) => when.format(new Date(iso)),
    day: (iso) => day.format(new Date(iso)),
    number: (value) => number.format(value),
    money: (minor, currency) => {
      const f = new Intl.NumberFormat(locale, { style: "currency", currency });
      const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
      return f.format(minor / 10 ** digits);
    },
  };
}

/** Whether a key or token's expiry has passed, read when the page renders. */
export function hasExpired(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

/** The visible start of a secret, marked as cut short. */
export function shownPrefix(prefix: string): string {
  return `${prefix}…`;
}

/** A schema-qualified column, for example app.tax_forms.tin_encrypted. */
export function qualified(table: string, column: string): string {
  return `${table}.${column}`;
}

/** The expiry choices offered for keys and tokens, as durations from now. */
export function expiryOptions(t: Translate): { value: string; label: string }[] {
  return ["30", "90", "180", "365"].map((d) => ({
    value: d,
    label: t(`${P}.expiry.days`, { count: Number(d) }),
  }));
}
