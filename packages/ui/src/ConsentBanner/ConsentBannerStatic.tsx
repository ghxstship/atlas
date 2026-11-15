import type { ReactElement, ReactNode } from "react";
import { buttonClass } from "../Button/button-class.ts";
import { Icon } from "../Icon/Icon.tsx";
import { cx } from "../lib/cx.ts";
import { linkClass } from "../Link/link-class.ts";
import type { ConsentCategory, ConsentLink } from "./ConsentBanner.tsx";

/**
 * Draws one of the consent links in a server component. Unlike `ConsentLinkRenderer` it never
 * crosses to the client, so a server component can pass its router's link component directly.
 */
export type ConsentStaticLinkRenderer = (link: ConsentLink, className: string) => ReactNode;

interface ConsentBannerStaticCopy {
  title: string;
  body?: string;
  policy?: ConsentLink;
  /** A second link after the policy, to the page where the choice can be changed. */
  settings?: ConsentLink;
  acceptLabel: string;
  rejectLabel: string;
  chooseLabel?: string;
  necessary?: string;
  categories?: ConsentCategory[];
  saveLabel?: string;
  /**
   * Where the forms post: a URL, or a function such as a Next.js server action. The fields are
   * `choice` (`all`, `none` or `save`) and each ticked category by name with the value `on`.
   */
  action: string | ((form: FormData) => void | Promise<void>);
  /** Draws the policy and settings links with the app's router link; a plain anchor when omitted. */
  renderLink?: ConsentStaticLinkRenderer;
  /** The id of the heading the region is labelled by, when the page needs its own. */
  headingId?: string;
}

/**
 * `gpc`: the request carries `Sec-GPC: 1` (`sendsGlobalPrivacyControl`), so the banner shows the
 * confirmation in place of the choices. The caller records the refusal; this component only says
 * so. `gpcLabel` is the confirmation, and the type requires it whenever `gpc` can be true: there is
 * no catalog to fall back on in a server component.
 */
type ConsentBannerStaticSignal =
  | { gpc: true; gpcLabel: string }
  | { gpc?: false; gpcLabel?: string }
  | { gpc: boolean; gpcLabel: string };

export type ConsentBannerStaticProps = ConsentBannerStaticCopy & ConsentBannerStaticSignal;

const sectionClass = cx(
  "border-b border-border-subtle bg-bg-surface p-16 font-sans text-text-primary print:hidden",
);
const innerClass = cx("mx-auto flex max-w-layout-reading flex-col gap-12");
const textClass = cx("m-0 text-text-13 text-text-secondary");
/** Accept and Reject are this one class: the same variant and the same size. */
const choiceClass = buttonClass("secondary", "lg");

function link(target: ConsentLink, renderLink: ConsentStaticLinkRenderer | undefined): ReactNode {
  return renderLink ? (
    renderLink(target, linkClass)
  ) : (
    <a href={target.href} className={linkClass}>
      {target.label}
    </a>
  );
}

/**
 * The cookie banner with no script (Section 14.3): the markup and the equal choices of
 * ConsentBanner as plain forms, with no hooks, context or event handlers, so a server component
 * that renders it sends no JavaScript for it (ADR 0027). Atlas shows it on every route. It reads
 * nothing from the browser: it does not see `navigator.globalPrivacyControl`, keeps no record and
 * does not hide itself, so the server decides whether to render it and passes `gpc` from the
 * request header. Use ConsentBanner where the banner keeps the decision through an adapter.
 */
export function ConsentBannerStatic({
  title,
  body,
  policy,
  settings,
  acceptLabel,
  rejectLabel,
  chooseLabel,
  necessary,
  categories,
  saveLabel,
  action,
  gpc,
  gpcLabel,
  renderLink,
  headingId = "consent-banner-title",
}: ConsentBannerStaticProps): ReactElement {
  if (gpc) {
    return (
      <section className={sectionClass} aria-label={title}>
        <div className={innerClass}>
          <p className="m-0 flex items-center gap-8 text-text-13" role="status">
            <span className="flex text-success">
              <Icon name="ShieldCheck" size={16} />
            </span>
            <span>{gpcLabel}</span>
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className={sectionClass} aria-labelledby={headingId}>
      <div className={innerClass}>
        <h2 id={headingId} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {body || policy || settings ? (
          <p className={textClass}>
            {body}
            {policy ? <> {link(policy, renderLink)}</> : null}
            {settings ? (
              <>
                {policy ? " · " : " "}
                {link(settings, renderLink)}
              </>
            ) : null}
          </p>
        ) : null}
        <form action={action} className="flex flex-wrap items-center gap-8">
          <button type="submit" name="choice" value="all" className={choiceClass}>
            {acceptLabel}
          </button>
          <button type="submit" name="choice" value="none" className={choiceClass}>
            {rejectLabel}
          </button>
        </form>
        {categories && chooseLabel && saveLabel ? (
          <details>
            <summary className="w-fit cursor-pointer text-text-13 font-medium text-accent-text">
              {chooseLabel}
            </summary>
            {/* data-keep-input: the save always succeeds and the page renders again from the stored choice. */}
            <form
              action={action}
              data-keep-input="not-refusable"
              className="mt-8 flex flex-col items-start gap-8 text-text-13"
            >
              <input type="hidden" name="choice" value="save" />
              {necessary ? <p className={textClass}>{necessary}</p> : null}
              {categories.map((category) => (
                <label key={category.name} className="flex items-start gap-8">
                  <input type="checkbox" name={category.name} className="mt-2" />
                  <span>{category.label}</span>
                </label>
              ))}
              <div>
                <button type="submit" className={buttonClass("secondary", "md")}>
                  {saveLabel}
                </button>
              </div>
            </form>
          </details>
        ) : null}
      </div>
    </section>
  );
}
