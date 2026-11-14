import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_DECISION_COOKIE,
  CONSENT_DECISION_MAX_AGE,
  ConsentBanner,
  ConsentSettings,
  XOSProvider,
  browserGlobalPrivacyControl,
  buttonClass,
  consentAllows,
  cookieConsentAdapter,
  decideConsent,
  documentCookieStore,
  parseConsentDecision,
  sendsGlobalPrivacyControl,
  serializeConsentDecision,
  type ConsentAdapter,
  type ConsentBannerProps,
  type ConsentCookieOptions,
  type ConsentCookieStore,
  type ConsentDecision,
  type ConsentState,
} from "../src/index.ts";
import * as subpath from "../src/ConsentBanner/index.ts";
import { expectAccessible } from "./a11y.ts";

/**
 * The shared cookie banner (issue 107): the adapter contract, both Global Privacy Control paths and
 * the equal weight of Accept and Reject.
 */

const POLICY_VERSION = "cookie-policy 1.0.0";
const NAMES = ["preferences", "performance"];
const CATEGORIES = [
  { name: "preferences", label: "Preferences: remember your language and theme." },
  { name: "performance", label: "Performance: page timing and error reports." },
];
const COPY = {
  title: "Cookies",
  body: "We use cookies to keep you signed in.",
  policy: { label: "Cookie Policy", href: "/legal/cookie-policy" },
  acceptLabel: "Accept all",
  rejectLabel: "Reject all",
  chooseLabel: "Choose cookies",
  necessary: "Strictly necessary: always on.",
  categories: CATEGORIES,
  saveLabel: "Save choices",
};
const SETTINGS = {
  title: "Cookie settings",
  status: "You have not chosen yet.",
  categoriesLabel: "Categories",
  necessary: COPY.necessary,
  categories: CATEGORIES,
  saveLabel: COPY.saveLabel,
  acceptLabel: COPY.acceptLabel,
  rejectLabel: COPY.rejectLabel,
};
const GPC_TEXT = "Opt-Out Request Honored";

function memoryStore(): ConsentCookieStore & {
  readonly options: Map<string, ConsentCookieOptions>;
} {
  const values = new Map<string, string>();
  const options = new Map<string, ConsentCookieOptions>();
  return {
    options,
    get: (name) => values.get(name),
    set: (name, value, cookie) => {
      values.set(name, value);
      options.set(name, cookie);
    },
  };
}

/** An adapter with no storage at all, as a site would write one over its own backend. */
function memoryAdapter(initial: ConsentState | null = null): ConsentAdapter & {
  readonly written: ConsentDecision[];
} {
  let state = initial;
  const written: ConsentDecision[] = [];
  return {
    written,
    read: () => Promise.resolve(state),
    write: (decision) => {
      state = decision;
      written.push(decision);
      return Promise.resolve();
    },
  };
}

function withBrowserSignal(value: unknown): void {
  Object.defineProperty(navigator, "globalPrivacyControl", { value, configurable: true });
}

afterEach(() => {
  delete (navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl;
});

/** The reference props, verbatim from design/xos-design-system/components/index.d.ts. */
interface ReferenceConsentBannerProps {
  title: string;
  body?: string;
  policy?: { label: string; href: string };
  acceptLabel?: string;
  rejectLabel?: string;
  chooseLabel?: string;
  necessary?: string;
  categories?: { name: string; label: string }[];
  saveLabel?: string;
  gpc?: boolean;
  onChoice?: (choice: "all" | "none" | "save") => void;
}
type Same<Prod, Reference> = [Reference] extends [Prod]
  ? [Prod] extends [Reference]
    ? true
    : false
  : false;
/** `tsc --noEmit` checks it: the production props accept every reference usage and keep its shape. */
export type ConsentContract =
  Same<ConsentBannerProps, ReferenceConsentBannerProps> extends true ? true : never;
const contractHolds: ConsentContract = true;

describe("consent exports", () => {
  it("come from the package root and from @xos/ui/consent alike", () => {
    expect(contractHolds).toBe(true);
    expect(subpath.ConsentBanner).toBe(ConsentBanner);
    expect(subpath.ConsentSettings).toBe(ConsentSettings);
    expect(subpath.cookieConsentAdapter).toBe(cookieConsentAdapter);
  });
});

describe.each([
  ["cookieConsentAdapter", () => cookieConsentAdapter({ store: memoryStore(), secure: true })],
  ["an adapter with no cookie and no database", () => memoryAdapter()],
])("the ConsentAdapter contract: %s", (_name, make) => {
  const decide = (choice: "all" | "none" | "save", gpc = false, selected: string[] = []) =>
    decideConsent({
      choice,
      categories: NAMES,
      selected,
      gpc,
      policyVersion: POLICY_VERSION,
      now: new Date("2026-11-14T09:30:00.000Z"),
    });

  it("reads null before any decision", async () => {
    expect(await make().read()).toBeNull();
  });

  it("reads back the categories and the signal flag of the decision it wrote", async () => {
    const adapter = make();
    await adapter.write(decide("save", false, ["preferences"]));
    expect(await adapter.read()).toMatchObject({
      categories: { preferences: true, performance: false },
      gpc: false,
    });
  });

  it("replaces an earlier decision", async () => {
    const adapter = make();
    await adapter.write(decide("all"));
    await adapter.write(decide("none"));
    expect((await adapter.read())?.categories).toEqual({ preferences: false, performance: false });
  });

  it("keeps the Global Privacy Control flag", async () => {
    const adapter = make();
    await adapter.write(decide("all", true));
    expect(await adapter.read()).toMatchObject({
      categories: { preferences: false, performance: false },
      gpc: true,
    });
  });
});

describe("decideConsent", () => {
  const base = { categories: NAMES, policyVersion: POLICY_VERSION, gpc: false } as const;

  it("accepts all, refuses all, or saves the ticked categories", () => {
    expect(decideConsent({ ...base, choice: "all" }).categories).toEqual({
      preferences: true,
      performance: true,
    });
    expect(decideConsent({ ...base, choice: "none" }).categories).toEqual({
      preferences: false,
      performance: false,
    });
    expect(
      decideConsent({ ...base, choice: "save", selected: ["performance", "marketing"] }).categories,
    ).toEqual({ preferences: false, performance: true });
  });

  it("stamps the time and the policy version", () => {
    const now = new Date("2026-11-14T09:30:00.000Z");
    expect(decideConsent({ ...base, choice: "all", now })).toMatchObject({
      decidedAt: "2026-11-14T09:30:00.000Z",
      policyVersion: POLICY_VERSION,
      gpc: false,
    });
    expect(Date.parse(decideConsent({ ...base, choice: "all" }).decidedAt)).not.toBeNaN();
  });

  it("refuses every category under Global Privacy Control, whatever was pressed", () => {
    for (const choice of ["all", "save"] as const) {
      const decision = decideConsent({ ...base, choice, selected: NAMES, gpc: true });
      expect(decision.categories).toEqual({ preferences: false, performance: false });
      expect(decision.gpc).toBe(true);
    }
  });

  it("allows a category only with consent, no recorded signal and no signal now", () => {
    const yes = decideConsent({ ...base, choice: "all" });
    expect(consentAllows(yes, "preferences", false)).toBe(true);
    expect(consentAllows(yes, "preferences", true)).toBe(false);
    expect(consentAllows(yes, "marketing", false)).toBe(false);
    expect(consentAllows({ ...yes, gpc: true }, "preferences", false)).toBe(false);
    expect(consentAllows(null, "preferences", false)).toBe(false);
  });
});

describe("the first-party cookie", () => {
  const decision = decideConsent({
    choice: "save",
    categories: NAMES,
    selected: ["preferences"],
    gpc: false,
    policyVersion: POLICY_VERSION,
    now: new Date("2026-11-14T09:30:00.000Z"),
  });

  it("holds the decision, its timestamp, the policy version and the signal flag", () => {
    const value = serializeConsentDecision(decision);
    expect(value).toMatch(/^[A-Za-z0-9%._~!*'()-]+$/);
    expect(parseConsentDecision(value)).toEqual(decision);
  });

  it("reads nothing from a missing, foreign or damaged value", () => {
    const encode = (raw: unknown) => encodeURIComponent(JSON.stringify(raw));
    const good = { v: 1, at: decision.decidedAt, policy: POLICY_VERSION, gpc: false };
    for (const value of [
      undefined,
      null,
      "",
      "1.0123456789abcdef0123456789abcdef.10.0",
      "%E0%A4%A",
      encode(null),
      encode({ ...good, categories: {}, v: 2 }),
      encode({ ...good, categories: {}, at: "yesterday" }),
      encode({ ...good, categories: {}, policy: "" }),
      encode({ ...good, categories: {}, gpc: "no" }),
      encode({ ...good, categories: [] }),
      encode({ ...good, categories: { preferences: "yes" } }),
      encode({ ...good, categories: { "Not A Name": true } }),
    ]) {
      expect(parseConsentDecision(value), String(value)).toBeNull();
    }
  });

  it("is written site-wide, SameSite Lax, for 12 months, under the default name", async () => {
    const store = memoryStore();
    await cookieConsentAdapter({ store, secure: true }).write(decision);
    expect(store.options.get(CONSENT_DECISION_COOKIE)).toEqual({
      path: "/",
      sameSite: "lax",
      secure: true,
      maxAge: CONSENT_DECISION_MAX_AGE,
    });
    expect(CONSENT_DECISION_MAX_AGE).toBe(31_536_000);
  });

  it("takes another name and lifetime", async () => {
    const store = memoryStore();
    const adapter = cookieConsentAdapter({ store, name: "site-consent", maxAge: 60 });
    await adapter.write(decision);
    expect(store.options.get("site-consent")).toMatchObject({ maxAge: 60, secure: false });
    expect(await adapter.read()).toEqual(decision);
  });

  it("uses document.cookie when no store is given", async () => {
    const adapter = cookieConsentAdapter({ name: "consent-under-test" });
    expect(await adapter.read()).toBeNull();
    await adapter.write(decision);
    expect(document.cookie).toContain("consent-under-test=");
    expect(await adapter.read()).toEqual(decision);
    document.cookie = "consent-under-test=; Path=/; Max-Age=0";
  });

  it("writes the cookie attributes through documentCookieStore", () => {
    const doc = { cookie: "other=1; site-consent=abc" };
    const store = documentCookieStore(doc);
    expect(store.get("site-consent")).toBe("abc");
    expect(store.get("consent")).toBeUndefined();
    store.set("site-consent", "xyz", { path: "/", sameSite: "lax", secure: true, maxAge: 60 });
    expect(doc.cookie).toBe("site-consent=xyz; Path=/; Max-Age=60; SameSite=Lax; Secure");
    store.set("site-consent", "xyz", { path: "/", sameSite: "lax", secure: false, maxAge: 60 });
    expect(doc.cookie).not.toContain("Secure");
  });
});

describe("Global Privacy Control", () => {
  it("is read from the Sec-GPC request header", () => {
    expect(sendsGlobalPrivacyControl(new Headers({ "Sec-GPC": "1" }))).toBe(true);
    expect(sendsGlobalPrivacyControl(new Headers({ "Sec-GPC": " 1 " }))).toBe(true);
    expect(sendsGlobalPrivacyControl(new Headers({ "Sec-GPC": "0" }))).toBe(false);
    expect(sendsGlobalPrivacyControl(new Headers())).toBe(false);
  });

  it("is read from navigator.globalPrivacyControl", () => {
    expect(browserGlobalPrivacyControl()).toBe(false);
    expect(browserGlobalPrivacyControl({ globalPrivacyControl: true })).toBe(true);
    expect(browserGlobalPrivacyControl({ globalPrivacyControl: "1" })).toBe(true);
    expect(browserGlobalPrivacyControl({ globalPrivacyControl: false })).toBe(false);
    expect(browserGlobalPrivacyControl(null)).toBe(false);
    withBrowserSignal(true);
    expect(browserGlobalPrivacyControl()).toBe(true);
  });

  it("from the request: the banner confirms the refusal in words and offers no choice", async () => {
    const { container } = render(<ConsentBanner {...COPY} gpc gpcLabel={GPC_TEXT} />);
    const banner = screen.getByRole("region", { name: "Cookies" });
    expect(within(banner).getByRole("status").textContent).toContain(GPC_TEXT);
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(within(banner).queryByRole("checkbox")).toBeNull();
    await expectAccessible(container);
  });

  it("takes the confirmation from the ui catalog when no label is passed", () => {
    render(
      <XOSProvider messages={{ "mk.consent.gpc": GPC_TEXT }}>
        <ConsentBanner title="Cookies" gpc />
      </XOSProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
  });

  it("from the request: the adapter records a refusal flagged as a signal, once", async () => {
    const adapter = memoryAdapter();
    const onChoice = vi.fn();
    const record = { adapter, policyVersion: POLICY_VERSION };
    const view = render(
      <ConsentBanner {...COPY} gpc gpcLabel={GPC_TEXT} record={record} onChoice={onChoice} />,
    );
    await waitFor(() => expect(adapter.written).toHaveLength(1));
    expect(adapter.written[0]).toMatchObject({
      categories: { preferences: false, performance: false },
      gpc: true,
      policyVersion: POLICY_VERSION,
    });
    expect(Date.parse(adapter.written[0]?.decidedAt ?? "")).not.toBeNaN();
    expect(onChoice).toHaveBeenCalledExactlyOnceWith("none");
    view.rerender(<ConsentBanner {...COPY} gpc gpcLabel={GPC_TEXT} record={record} />);
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    expect(adapter.written).toHaveLength(1);
  });

  it("does not write again when the stored decision already came from the signal", async () => {
    const adapter = memoryAdapter({ categories: { preferences: false }, gpc: true });
    const read = vi.spyOn(adapter, "read");
    render(
      <ConsentBanner
        {...COPY}
        gpc
        gpcLabel={GPC_TEXT}
        record={{ adapter, policyVersion: POLICY_VERSION }}
      />,
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    await read.mock.results[0]?.value;
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    expect(adapter.written).toEqual([]);
  });

  it("from the browser alone: the banner confirms it and the adapter records the refusal", async () => {
    withBrowserSignal(true);
    const adapter = memoryAdapter();
    render(
      <ConsentBanner
        {...COPY}
        gpcLabel={GPC_TEXT}
        record={{ adapter, policyVersion: POLICY_VERSION }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    await waitFor(() => expect(adapter.written).toHaveLength(1));
    expect(adapter.written[0]).toMatchObject({
      categories: { preferences: false, performance: false },
      gpc: true,
    });
  });

  it("from the browser alone: a function action receives the refusal with the gpc field", async () => {
    withBrowserSignal(true);
    const action = vi.fn<(form: FormData) => void>();
    const onChoice = vi.fn();
    render(<ConsentBanner {...COPY} gpcLabel={GPC_TEXT} action={action} onChoice={onChoice} />);
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const form = action.mock.calls[0]?.[0];
    expect(form?.get("choice")).toBe("none");
    expect(form?.get("gpc")).toBe("1");
    expect(onChoice).toHaveBeenCalledExactlyOnceWith("none");
  });

  it("from the request with an action: nothing is posted, since the server saw the header", async () => {
    const action = vi.fn<(form: FormData) => void>();
    render(<ConsentBanner {...COPY} gpc gpcLabel={GPC_TEXT} action={action} />);
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
  });

  it("on the settings view: says so and locks the optional categories and Accept", async () => {
    const notice = "Your browser sends Global Privacy Control.";
    const { container } = render(<ConsentSettings {...SETTINGS} gpc gpcNotice={notice} />);
    expect(screen.getByText(notice)).toBeInstanceOf(HTMLElement);
    expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/^Performance:/)).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Accept all" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reject all" })).toHaveProperty("disabled", false);
    await expectAccessible(container);
  });

  it("on the settings view, from the browser alone: the same, with the catalog message", () => {
    withBrowserSignal(true);
    render(
      <XOSProvider messages={{ "mk.consent.gpc": GPC_TEXT }}>
        <ConsentSettings {...SETTINGS} />
      </XOSProvider>,
    );
    expect(screen.getByText(GPC_TEXT)).toBeInstanceOf(HTMLElement);
    expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("disabled", true);
  });
});

describe("equal weight", () => {
  function pair(): [HTMLElement, HTMLElement] {
    return [
      screen.getByRole("button", { name: "Accept all" }),
      screen.getByRole("button", { name: "Reject all" }),
    ];
  }

  it("Accept and Reject are the same Button: one variant, one size, side by side", async () => {
    const { container } = render(<ConsentBanner {...COPY} />);
    const [accept, reject] = pair();
    expect(accept.className).toBe(reject.className);
    expect(accept.className).toBe(buttonClass("secondary", "lg"));
    expect(accept.className).not.toBe(buttonClass("primary", "lg"));
    expect(accept.tagName).toBe(reject.tagName);
    expect(accept.getAttribute("type")).toBe(reject.getAttribute("type"));
    expect(accept.parentElement).toBe(reject.parentElement);
    expect(accept.nextElementSibling).toBe(reject);
    expect(accept.getAttributeNames().sort()).toEqual(reject.getAttributeNames().sort());
    await expectAccessible(container);
  });

  it("neither is pre-selected: nothing has focus and no category is ticked", () => {
    render(<ConsentBanner {...COPY} />);
    const [accept, reject] = pair();
    expect(document.activeElement).toBe(document.body);
    expect(accept?.hasAttribute("autofocus")).toBe(false);
    expect(reject?.hasAttribute("autofocus")).toBe(false);
    const boxes = screen.getAllByRole("checkbox", { hidden: true });
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toHaveProperty("checked", false);
    expect(screen.getByText("Choose cookies").closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("holds as plain forms too: both post the same field", () => {
    render(<ConsentBanner {...COPY} action="/consent" />);
    const [accept, reject] = pair();
    expect(accept.className).toBe(reject.className);
    expect(accept?.getAttribute("type")).toBe("submit");
    expect(reject?.getAttribute("type")).toBe("submit");
    expect(accept?.getAttribute("name")).toBe("choice");
    expect(reject?.getAttribute("name")).toBe("choice");
    expect(accept?.getAttribute("value")).toBe("all");
    expect(reject?.getAttribute("value")).toBe("none");
    expect(accept.closest("form")).toBe(reject.closest("form"));
    expect(accept.closest("form")?.getAttribute("action")).toBe("/consent");
  });

  it("holds on the settings view, where Save is the one primary", () => {
    render(<ConsentSettings {...SETTINGS} />);
    const [accept, reject] = pair();
    expect(accept.className).toBe(reject.className);
    expect(accept.className).toBe(buttonClass("secondary", "md"));
    expect(accept.nextElementSibling).toBe(reject);
    expect(screen.getByRole("button", { name: "Save choices" }).className).toBe(
      buttonClass("primary", "md"),
    );
  });
});

describe("ConsentBanner", () => {
  it("names the region by its title and links the policy and the settings page", () => {
    render(
      <ConsentBanner {...COPY} settings={{ label: "Cookie settings", href: "/legal/settings" }} />,
    );
    const banner = screen.getByRole("region", { name: "Cookies" });
    expect(within(banner).getByRole("heading", { level: 2, name: "Cookies" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(within(banner).getByRole("link", { name: "Cookie Policy" })?.getAttribute("href")).toBe(
      "/legal/cookie-policy",
    );
    expect(
      within(banner).getByRole("link", { name: "Cookie settings" })?.getAttribute("href"),
    ).toBe("/legal/settings");
  });

  it("tells onChoice which button was pressed", async () => {
    const onChoice = vi.fn();
    render(<ConsentBanner {...COPY} onChoice={onChoice} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject all" }));
    await userEvent.click(screen.getByText("Choose cookies"));
    await userEvent.click(screen.getByRole("button", { name: "Save choices" }));
    expect(onChoice.mock.calls).toEqual([["all"], ["none"], ["save"]]);
  });

  it("leaves out Choose when there are no categories", () => {
    render(<ConsentBanner title="Cookies" acceptLabel="Accept all" rejectLabel="Reject all" />);
    expect(screen.queryByRole("checkbox", { hidden: true })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("posts the categories as plain form fields, with the choice hidden in the form", () => {
    const { container } = render(<ConsentBanner {...COPY} action="/consent" />);
    const save = screen.getByRole("button", { name: "Save choices", hidden: true });
    const form = save.closest("form");
    expect(form?.getAttribute("action")).toBe("/consent");
    expect(form?.getAttribute("data-keep-input")).toBe("not-refusable");
    expect(form?.querySelector('input[type="hidden"][name="choice"]')).toHaveProperty(
      "value",
      "save",
    );
    expect(
      [...container.querySelectorAll('input[type="checkbox"]')].map((box) =>
        box.getAttribute("name"),
      ),
    ).toEqual(NAMES);
  });

  it("with an adapter: stays hidden until it is read, and for a visitor who has decided", async () => {
    const decided = memoryAdapter({ categories: { preferences: true }, gpc: false });
    const read = vi.spyOn(decided, "read");
    const { container } = render(
      <ConsentBanner {...COPY} record={{ adapter: decided, policyVersion: POLICY_VERSION }} />,
    );
    expect(container.innerHTML).toBe("");
    await read.mock.results[0]?.value;
    expect(container.innerHTML).toBe("");
  });

  it("with an adapter: asks a new visitor, records Reject and closes", async () => {
    const adapter = memoryAdapter();
    render(<ConsentBanner {...COPY} record={{ adapter, policyVersion: POLICY_VERSION }} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject all" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Cookies" })).toBeNull());
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0]).toMatchObject({
      categories: { preferences: false, performance: false },
      gpc: false,
      policyVersion: POLICY_VERSION,
    });
    expect(adapter.written[0]?.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("with an adapter: records Accept, and Save with only the ticked categories", async () => {
    const accepting = memoryAdapter();
    const first = render(
      <ConsentBanner {...COPY} record={{ adapter: accepting, policyVersion: POLICY_VERSION }} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(accepting.written).toHaveLength(1));
    expect(accepting.written[0]?.categories).toEqual({ preferences: true, performance: true });
    first.unmount();

    const saving = memoryAdapter();
    render(<ConsentBanner {...COPY} record={{ adapter: saving, policyVersion: POLICY_VERSION }} />);
    await userEvent.click(await screen.findByText("Choose cookies"));
    await userEvent.click(screen.getByLabelText(/^Performance:/));
    await userEvent.click(screen.getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(saving.written).toHaveLength(1));
    expect(saving.written[0]?.categories).toEqual({ preferences: false, performance: true });
  });

  it("keeps the choices up when the adapter cannot be read or written", async () => {
    const failing: ConsentAdapter = {
      read: () => Promise.reject(new Error("unreachable")),
      write: () => Promise.reject(new Error("unreachable")),
    };
    render(
      <ConsentBanner {...COPY} record={{ adapter: failing, policyVersion: POLICY_VERSION }} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Reject all" }));
    expect(screen.getByRole("region", { name: "Cookies" })).toBeInstanceOf(HTMLElement);
  });
});

describe("ConsentSettings", () => {
  const table = {
    caption: "Cookies this site sets",
    nameLabel: "Name",
    categoryLabel: "Category",
    purposeLabel: "What it does",
    rows: [{ name: "xos-theme", category: "Preferences", purpose: "Remembers the theme." }],
  };

  it("shows the choice in force, the categories, the cookies by name and the policy", async () => {
    const { container } = render(
      <ConsentSettings
        {...SETTINGS}
        lead="Choose which cookies this site may set."
        status="Your choice: Preferences on, Performance off."
        categories={CATEGORIES.map((c) => ({ ...c, checked: c.name === "preferences" }))}
        cookies={table}
        policy={COPY.policy}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Cookie settings" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Your choice: Preferences on, Performance off.",
    );
    expect(screen.getByLabelText(/^Strictly necessary/)).toHaveProperty("checked", true);
    expect(screen.getByLabelText(/^Strictly necessary/)).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", true);
    expect(screen.getByLabelText(/^Performance:/)).toHaveProperty("checked", false);
    expect(screen.getByRole("rowheader", { name: "xos-theme" })).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole("cell", { name: "Remembers the theme." })).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole("link", { name: "Cookie Policy" })).toBeInstanceOf(HTMLElement);
    await expectAccessible(container);
  });

  it("posts plain forms: Save with the categories, and Accept or Reject", () => {
    render(<ConsentSettings {...SETTINGS} action="/consent" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Cookie settings" })).toBeInstanceOf(
      HTMLElement,
    );
    const save = screen.getByRole("button", { name: "Save choices" });
    expect(save?.getAttribute("type")).toBe("submit");
    expect(save.closest("form")?.getAttribute("action")).toBe("/consent");
    expect(save.closest("form")?.getAttribute("data-keep-input")).toBe("not-refusable");
    expect(save.closest("form")?.querySelector('input[name="choice"]')).toHaveProperty(
      "value",
      "save",
    );
    expect(screen.getByRole("button", { name: "Accept all" })?.getAttribute("value")).toBe("all");
    expect(screen.getByRole("button", { name: "Reject all" })?.getAttribute("value")).toBe("none");
  });

  it("with an adapter: shows the stored choice and writes a change", async () => {
    const adapter = memoryAdapter({
      categories: { preferences: true, performance: false },
      gpc: false,
    });
    const onChoice = vi.fn();
    const status = (state: ConsentState | null): string =>
      state === null
        ? "You have not chosen yet."
        : `Preferences ${state.categories["preferences"]}`;
    render(
      <ConsentSettings
        {...SETTINGS}
        status={status}
        record={{ adapter, policyVersion: POLICY_VERSION }}
        onChoice={onChoice}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("You have not chosen yet.");
    await waitFor(() =>
      expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", true),
    );
    expect(screen.getByRole("status").textContent).toContain("Preferences true");

    await userEvent.click(screen.getByLabelText(/^Preferences:/));
    await userEvent.click(screen.getByLabelText(/^Performance:/));
    await userEvent.click(screen.getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(adapter.written).toHaveLength(1));
    expect(adapter.written[0]).toMatchObject({
      categories: { preferences: false, performance: true },
      gpc: false,
      policyVersion: POLICY_VERSION,
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Preferences false"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Reject all" }));
    await waitFor(() => expect(adapter.written).toHaveLength(2));
    expect(adapter.written[1]?.categories).toEqual({ preferences: false, performance: false });
    expect(onChoice.mock.calls).toEqual([["save"], ["none"]]);
  });
});
