"use client";

import { useId, useRef, type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { Checkbox } from "../Forms/Checkbox.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Link, linkClass } from "../Link/Link.tsx";
import type { ConsentChoice } from "./consent.ts";
import {
  tickedCategories,
  useConsent,
  type ConsentAction,
  type ConsentRecording,
} from "./useConsent.ts";

/** A link the consent copy names: the Cookie Policy or the Cookie settings page. */
export interface ConsentLink {
  label: string;
  href: string;
}

/**
 * Draws one of the consent links. An app with a router passes its own link component here, so the
 * policy and the settings page open without a full page load; `className` is the library's link
 * style. It is a function, so it comes from a client module.
 */
export type ConsentLinkRenderer = (link: ConsentLink, className: string) => ReactNode;

/** A consent link as the default anchor, or as the app's `renderLink` draws it. */
export function ConsentLinkText({
  link,
  renderLink,
}: {
  link: ConsentLink;
  renderLink: ConsentLinkRenderer | undefined;
}): ReactNode {
  return renderLink ? renderLink(link, linkClass) : <Link href={link.href}>{link.label}</Link>;
}

/** An optional cookie category behind Choose. */
export interface ConsentCategory {
  /**
   * The field name the category posts under and the key it is recorded by. It must match
   * `CONSENT_CATEGORY_NAME`: a letter, then letters, digits, underscores or hyphens, 64 characters
   * at most (`preferences`, `analytics_storage`). The cookie adapter rejects a write with any
   * other name.
   */
  name: string;
  label: string;
}

export interface ConsentBannerProps {
  title: string;
  body?: string;
  policy?: ConsentLink;
  acceptLabel?: string;
  rejectLabel?: string;
  chooseLabel?: string;
  necessary?: string;
  categories?: ConsentCategory[];
  saveLabel?: string;
  /** The browser sends Global Privacy Control: show the confirmation instead of the choices. */
  gpc?: boolean;
  onChoice?: (choice: ConsentChoice) => void;
  /** A second link after the policy, to the page where the choice can be changed. */
  settings?: ConsentLink;
  /** The Global Privacy Control confirmation; the `mk.consent.gpc` catalog message when omitted. */
  gpcLabel?: string;
  /** Posts the choice as plain forms, which work before any script loads. */
  action?: ConsentAction;
  /** Draws the policy and settings links with the app's router link; a plain anchor when omitted. */
  renderLink?: ConsentLinkRenderer;
  /**
   * Lets the banner keep the decision itself: it reads the adapter once, stays hidden when a
   * decision exists, and writes each choice with its timestamp, policy version and signal flag.
   */
  record?: ConsentRecording;
}

const sectionClass = cx(
  "border-b border-border-subtle bg-bg-surface p-16 font-sans text-text-primary print:hidden",
);
const innerClass = cx("mx-auto flex max-w-layout-reading flex-col gap-12");
const textClass = cx("m-0 text-text-13 text-text-secondary");

/**
 * The cookie banner both sites share (Section 14.3). Accept and Reject are the same Button, side by
 * side, and no category behind Choose starts ticked. A Global Privacy Control signal, from the
 * request (`gpc`) or from `navigator.globalPrivacyControl`, is a refusal: the banner shows the
 * confirmation and offers no choices. Every string is a prop or comes from the `ui` catalog.
 */
export function ConsentBanner({
  title,
  body,
  policy,
  acceptLabel,
  rejectLabel,
  chooseLabel,
  necessary,
  categories,
  saveLabel,
  gpc,
  onChoice,
  settings,
  gpcLabel,
  action,
  renderLink,
  record,
}: ConsentBannerProps): ReactElement | null {
  const t = useT();
  const id = useId();
  const custom = useRef<HTMLFormElement>(null);
  const names = (categories ?? []).map((c) => c.name);
  const { signal, stored, choose } = useConsent({
    gpc,
    categories: names,
    record,
    action,
    onChoice,
  });

  if (signal) {
    return (
      <section className={sectionClass} aria-label={title}>
        <div className={innerClass}>
          <p className="m-0 flex items-center gap-8 text-text-13" role="status">
            <span className="flex text-success">
              <Icon name="ShieldCheck" size={16} />
            </span>
            <span>{gpcLabel ?? t("mk.consent.gpc")}</span>
          </p>
        </div>
      </section>
    );
  }
  // With an adapter the banner waits for the stored consent, and a visitor who decided sees nothing.
  if (record !== undefined && stored !== null) return null;

  const posts = action !== undefined;
  const type = posts ? "submit" : "button";
  return (
    <section className={sectionClass} aria-labelledby={id}>
      <div className={innerClass}>
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {body || policy || settings ? (
          <p className={textClass}>
            {body}
            {policy ? (
              <>
                {" "}
                <ConsentLinkText link={policy} renderLink={renderLink} />
              </>
            ) : null}
            {settings ? (
              <>
                {policy ? " · " : " "}
                <ConsentLinkText link={settings} renderLink={renderLink} />
              </>
            ) : null}
          </p>
        ) : null}
        <form
          {...(posts ? { action } : {})}
          onSubmit={posts ? undefined : (event) => event.preventDefault()}
          className="flex flex-wrap items-center gap-8"
        >
          <Button type={type} name="choice" value="all" size="lg" onClick={() => choose("all")}>
            {acceptLabel}
          </Button>
          <Button type={type} name="choice" value="none" size="lg" onClick={() => choose("none")}>
            {rejectLabel}
          </Button>
        </form>
        {categories ? (
          <details>
            <summary className="w-fit cursor-pointer text-text-13 font-medium text-accent-text">
              {chooseLabel}
            </summary>
            {/* data-keep-input: the save always succeeds and the page renders again from the stored choice. */}
            <form
              ref={custom}
              {...(posts ? { action } : {})}
              onSubmit={posts ? undefined : (event) => event.preventDefault()}
              data-keep-input="not-refusable"
              className="mt-8 flex flex-col items-start gap-8 text-text-13"
            >
              <input type="hidden" name="choice" value="save" />
              {necessary ? <p className={textClass}>{necessary}</p> : null}
              {categories.map((c) => (
                <Checkbox key={c.name} name={c.name} label={c.label} />
              ))}
              <div>
                <Button
                  type={type}
                  onClick={() => choose("save", tickedCategories(custom.current, names))}
                >
                  {saveLabel}
                </Button>
              </div>
            </form>
          </details>
        ) : null}
      </div>
    </section>
  );
}
