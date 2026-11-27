import { useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  ConsentBanner,
  ConsentSettings,
  type ConsentAdapter,
  type ConsentState,
} from "../src/index.ts";
import { ConsentBannerStatic } from "../src/ConsentBanner/static.ts";

/**
 * The states of the shared cookie banner (issue 107): the first visit, a browser that sends Global
 * Privacy Control, and the settings view, each with sample copy as a consumer passes it. The
 * decision is kept by an adapter held in memory, so a choice in a story touches no cookie.
 */
const meta: Meta = { title: "Marketing/Consent States", parameters: { layout: "fullscreen" } };
export default meta;

const POLICY = { label: "Cookie Policy", href: "#cookie-policy" };
const CATEGORIES = [
  {
    name: "preferences",
    label:
      "Preferences: remember your language, theme, workspace and last organization for 12 months.",
  },
  { name: "performance", label: "Performance: page timing and error reports." },
];
const COPY = {
  title: "Cookies",
  body: "We use cookies to keep you signed in and to remember this choice. With your permission we also remember your language, theme and last workspace for 12 months instead of this visit. We use no advertising or tracking cookies.",
  acceptLabel: "Accept all",
  rejectLabel: "Reject all",
  necessary: "Strictly necessary: sign-in, security and this choice. Always on.",
  saveLabel: "Save choices",
};

function memoryAdapter(initial: ConsentState | null = null): ConsentAdapter {
  let state = initial;
  return {
    read: () => Promise.resolve(state),
    write: (decision) => {
      state = decision;
      return Promise.resolve();
    },
  };
}

function describeChoice(state: ConsentState | null): string {
  if (state === null) return "You have not chosen yet.";
  const word = (name: string): string => (state.categories[name] ? "on" : "off");
  return `Your choice: Preferences ${word("preferences")}, Performance ${word("performance")}.`;
}

/** One adapter and policy version for the life of a story. */
function useMemoryRecord(): { adapter: ConsentAdapter; policyVersion: string } {
  return useState(() => ({ adapter: memoryAdapter(), policyVersion: "cookie-policy 1.0.0" }))[0];
}

function Settings({ gpc = false }: { gpc?: boolean }): ReactElement {
  const record = useMemoryRecord();
  return (
    <ConsentSettings
      title="Cookie settings"
      lead="Choose which cookies this site may set in this browser."
      status={describeChoice}
      gpc={gpc}
      gpcNotice="Your browser sends Global Privacy Control. We treat it as a refusal of every cookie that is not strictly necessary, so the choices below stay off while it is on."
      categoriesLabel="Categories"
      necessary={COPY.necessary}
      categories={CATEGORIES}
      saveLabel={COPY.saveLabel}
      acceptLabel={COPY.acceptLabel}
      rejectLabel={COPY.rejectLabel}
      headingLevel={2}
      cookies={{
        caption: "Cookies this site sets",
        nameLabel: "Name",
        categoryLabel: "Category",
        purposeLabel: "What it does",
        rows: [
          {
            name: "xos-consent-decision",
            category: "Strictly necessary",
            purpose: "Remembers this choice for 12 months.",
          },
          {
            name: "xos-theme",
            category: "Preferences",
            purpose: "Remembers the light or dark theme you chose.",
          },
        ],
      }}
      policy={POLICY}
      record={record}
    />
  );
}

function Banner(): ReactElement {
  const record = useMemoryRecord();
  return (
    <ConsentBanner
      {...COPY}
      policy={POLICY}
      settings={{ label: "Cookie settings", href: "#cookie-settings" }}
      chooseLabel="Choose cookies"
      categories={CATEGORIES}
      record={record}
    />
  );
}

export const FirstVisit: StoryObj = {
  name: "First Visit",
  render: () => <Banner />,
};

export const GlobalPrivacyControl: StoryObj = {
  name: "Global Privacy Control",
  render: () => <ConsentBanner title={COPY.title} gpc gpcLabel="Opt-Out Request Honored" />,
};

export const SettingsView: StoryObj = {
  name: "Settings View",
  render: () => <Settings />,
};

export const SettingsUnderGlobalPrivacyControl: StoryObj = {
  name: "Settings Under Global Privacy Control",
  render: () => <Settings gpc />,
};

/** The script-free banner a server component renders, as Atlas shows it on every route. */
export const ScriptFree: StoryObj = {
  render: () => (
    <ConsentBannerStatic
      {...COPY}
      policy={POLICY}
      settings={{ label: "Cookie settings", href: "#cookie-settings" }}
      chooseLabel="Choose cookies"
      categories={CATEGORIES}
      action="#consent"
    />
  ),
};

/**
 * The bar on a page longer than the screen: it stays at the bottom edge while the page scrolls and,
 * at the end, sits after the footer, so the last button and the footer are never under it.
 */
export const OnALongPage: StoryObj = {
  name: "On a Long Page",
  render: () => (
    <div className="bg-bg-canvas text-text-primary">
      <ConsentBannerStatic
        {...COPY}
        policy={POLICY}
        settings={{ label: "Cookie settings", href: "#cookie-settings" }}
        chooseLabel="Choose cookies"
        categories={CATEGORIES}
        action="#consent"
      />
      <main className="mx-auto flex max-w-layout-reading flex-col gap-16 p-24">
        {Array.from({ length: 24 }, (_, index) => (
          <p key={index} className="m-0 text-text-13">
            Paragraph {index + 1} of the page.
          </p>
        ))}
        <div>
          <Button>The last button</Button>
        </div>
      </main>
      <footer className="border-t border-border-subtle p-24 text-text-13 text-text-secondary">
        The page footer
      </footer>
    </div>
  ),
};
