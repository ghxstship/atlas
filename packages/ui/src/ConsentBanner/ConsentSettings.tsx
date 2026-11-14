"use client";

import { useRef, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { Checkbox } from "../Forms/Checkbox.tsx";
import { InlineAlert } from "../Feedback/InlineAlert.tsx";
import type { ConsentChoice, ConsentState } from "./consent.ts";
import {
  ConsentLinkText,
  type ConsentCategory,
  type ConsentLink,
  type ConsentLinkRenderer,
} from "./ConsentBanner.tsx";
import {
  tickedCategories,
  useConsent,
  type ConsentAction,
  type ConsentRecording,
} from "./useConsent.ts";

/** An optional category on the settings page, with the choice in force. */
export interface ConsentSettingsCategory extends ConsentCategory {
  /** The category is allowed now. With `record`, the stored consent decides instead. */
  checked?: boolean;
}

/** The table of cookies the site sets, which a cookie policy asks for by name. */
export interface ConsentCookieTable {
  caption: string;
  nameLabel: string;
  categoryLabel: string;
  purposeLabel: string;
  rows: { name: string; category: string; purpose: string }[];
}

export interface ConsentSettingsProps {
  title: string;
  lead?: string;
  /**
   * The sentence that states the choice in force. A function receives the stored consent, or null
   * before a choice, when `record` keeps the decision.
   */
  status: string | ((state: ConsentState | null) => string);
  /** The request carries Global Privacy Control. */
  gpc?: boolean;
  /** What the signal means here; the `mk.consent.gpc` catalog message when omitted. */
  gpcNotice?: string;
  categoriesLabel: string;
  /** The strictly necessary category, shown ticked and locked. */
  necessary: string;
  categories: ConsentSettingsCategory[];
  saveLabel: string;
  acceptLabel: string;
  rejectLabel: string;
  cookies?: ConsentCookieTable;
  policy?: ConsentLink;
  /** The heading level of the title: 1 on a page of its own. */
  headingLevel?: 1 | 2;
  onChoice?: (choice: ConsentChoice) => void;
  /** Posts the choice as plain forms, which work before any script loads. */
  action?: ConsentAction;
  /** Lets the page keep the decision itself, through an adapter. */
  record?: ConsentRecording;
  /** Draws the policy link with the app's router link; a plain anchor when omitted. */
  renderLink?: ConsentLinkRenderer;
}

const cellClass = cx("py-4 pe-8 text-start");

/**
 * The settings view of the cookie banner (Section 14.3): the choice in force, the categories, the
 * same Accept and Reject pair at equal weight, and the cookies by name. Under Global Privacy
 * Control it says so, and the optional categories and Accept are locked while the signal is on.
 */
export function ConsentSettings({
  title,
  lead,
  status,
  gpc,
  gpcNotice,
  categoriesLabel,
  necessary,
  categories,
  saveLabel,
  acceptLabel,
  rejectLabel,
  cookies,
  policy,
  headingLevel = 1,
  onChoice,
  action,
  record,
  renderLink,
}: ConsentSettingsProps): ReactElement {
  const t = useT();
  const custom = useRef<HTMLFormElement>(null);
  const names = categories.map((c) => c.name);
  const { signal, browserOnly, stored, choose } = useConsent({
    gpc,
    categories: names,
    record,
    action,
    onChoice,
  });
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const posts = action !== undefined;
  const type = posts ? "submit" : "button";
  const allowed = (c: ConsentSettingsCategory): boolean =>
    record === undefined ? (c.checked ?? false) : stored?.categories[c.name] === true;
  // The boxes are uncontrolled so they work before any script loads; a new stored choice remounts
  // them, and only them, so the button that was pressed keeps the keyboard focus.
  const boxesKey = record === undefined ? "props" : JSON.stringify(stored ?? null);
  // Only the browser reports the signal: tell the server, which saw no Sec-GPC header.
  const gpcField = browserOnly ? <input type="hidden" name="gpc" value="1" /> : null;
  return (
    <div className="mx-auto flex max-w-layout-reading flex-col gap-16 p-24">
      <Heading className="m-0 text-heading-24 font-semibold">{title}</Heading>
      {lead ? <p className="m-0 text-text-14 text-text-secondary">{lead}</p> : null}
      {signal ? <InlineAlert tone="info">{gpcNotice ?? t("mk.consent.gpc")}</InlineAlert> : null}
      <p className="m-0 text-text-14" role="status">
        {typeof status === "function" ? status(stored ?? null) : status}
      </p>
      {/* data-keep-input: the save always succeeds and the page renders again from the stored choice. */}
      <form
        ref={custom}
        {...(posts ? { action } : {})}
        onSubmit={posts ? undefined : (event) => event.preventDefault()}
        data-keep-input="not-refusable"
        className="flex flex-col gap-12"
      >
        <input type="hidden" name="choice" value="save" />
        {gpcField}
        <fieldset key={boxesKey} className="m-0 flex flex-col items-start gap-8 border-0 p-0">
          <legend className="mb-4 text-text-13 font-medium">{categoriesLabel}</legend>
          <Checkbox label={necessary} checked disabled readOnly />
          {categories.map((c) => (
            <Checkbox
              key={c.name}
              name={c.name}
              label={c.label}
              defaultChecked={allowed(c)}
              disabled={signal}
            />
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-8">
          <Button
            type={type}
            variant="primary"
            onClick={() => choose("save", tickedCategories(custom.current, names))}
          >
            {saveLabel}
          </Button>
        </div>
      </form>
      <form
        {...(posts ? { action } : {})}
        onSubmit={posts ? undefined : (event) => event.preventDefault()}
        className="flex flex-wrap gap-8"
      >
        {gpcField}
        <Button
          type={type}
          name="choice"
          value="all"
          disabled={signal}
          onClick={() => choose("all")}
        >
          {acceptLabel}
        </Button>
        <Button type={type} name="choice" value="none" onClick={() => choose("none")}>
          {rejectLabel}
        </Button>
      </form>
      {cookies ? (
        <table className="w-full border-collapse text-start text-text-13">
          <caption className="mb-8 text-start text-text-13 font-medium">{cookies.caption}</caption>
          <thead>
            <tr className="border-b border-border-subtle">
              <th scope="col" className={cellClass}>
                {cookies.nameLabel}
              </th>
              <th scope="col" className={cellClass}>
                {cookies.categoryLabel}
              </th>
              <th scope="col" className="py-4 text-start">
                {cookies.purposeLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {cookies.rows.map((row) => (
              <tr key={row.name} className="border-b border-border-subtle">
                <th scope="row" className={cx(cellClass, "font-mono font-regular")}>
                  {row.name}
                </th>
                <td className={cellClass}>{row.category}</td>
                <td className="py-4">{row.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {policy ? (
        <p className="m-0 text-text-13 text-text-secondary">
          <ConsentLinkText link={policy} renderLink={renderLink} />
        </p>
      ) : null}
    </div>
  );
}
