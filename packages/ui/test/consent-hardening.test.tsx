import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_CATEGORY_NAME,
  CONSENT_DECISION_COOKIE,
  ConsentBanner,
  ConsentSettings,
  cookieConsentAdapter,
  decideConsent,
  documentCookieStore,
  parseConsentDecision,
  serializeConsentDecision,
  type ConsentAdapter,
  type ConsentCookieStore,
  type ConsentDecision,
  type ConsentLink,
  type ConsentState,
} from "../src/index.ts";

/**
 * The shared cookie banner under conditions a second site meets (issue 107, review of the first
 * port): category names of its own, a server that writes the cookie a browser reads, storage that
 * throws, a slow backend, keyboard use, a Global Privacy Control signal only the browser reports,
 * right-to-left layout and an app router's own links.
 */

const POLICY_VERSION = "cookie-policy 1.0.0";
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

function memoryStore(): ConsentCookieStore {
  const values = new Map<string, string>();
  return { get: (name) => values.get(name), set: (name, value) => void values.set(name, value) };
}

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

function withBrowserSignal(): void {
  Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
}

afterEach(() => {
  delete (navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl;
  vi.unstubAllGlobals();
});

const decide = (categories: readonly string[], selected: readonly string[] = categories) =>
  decideConsent({
    choice: "save",
    categories,
    selected,
    gpc: false,
    policyVersion: POLICY_VERSION,
    now: new Date("2026-11-14T09:30:00.000Z"),
  });

describe("category names", () => {
  const NAMES = ["analytics_storage", "ad_storage", "Marketing", "preferences", "page-timing"];

  it.each(NAMES)("%s is written and read back", async (name) => {
    expect(CONSENT_CATEGORY_NAME.test(name)).toBe(true);
    const decision = decide([name]);
    expect(parseConsentDecision(serializeConsentDecision(decision))).toEqual(decision);
    const adapter = cookieConsentAdapter({ store: memoryStore() });
    await adapter.write(decision);
    expect(await adapter.read()).toEqual(decision);
  });

  it("a banner with such a name stays closed after the choice, on the next page too", async () => {
    const store = memoryStore();
    const props = {
      ...COPY,
      categories: [{ name: "analytics_storage", label: "Analytics: page timing." }],
    };
    const first = render(
      <ConsentBanner
        {...props}
        record={{ adapter: cookieConsentAdapter({ store }), policyVersion: POLICY_VERSION }}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Cookies" })).toBeNull());
    first.unmount();

    const adapter = cookieConsentAdapter({ store });
    const read = vi.spyOn(adapter, "read");
    const { container } = render(
      <ConsentBanner {...props} record={{ adapter, policyVersion: POLICY_VERSION }} />,
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(await read.mock.results[0]?.value).toMatchObject({
      categories: { analytics_storage: true },
    });
    expect(container.innerHTML).toBe("");
  });

  it.each(["", "not a name", "9lives", "__proto__", "semi;colon", "a".repeat(65)])(
    "%j is refused on write as it is on read",
    async (name) => {
      expect(CONSENT_CATEGORY_NAME.test(name)).toBe(false);
      const store = memoryStore();
      const adapter = cookieConsentAdapter({ store });
      const decision = { ...decide([]), categories: JSON.parse(`{${JSON.stringify(name)}:true}`) };
      await expect(adapter.write(decision as ConsentDecision)).rejects.toThrow(/category name/i);
      expect(store.get(CONSENT_DECISION_COOKIE)).toBeUndefined();
      expect(() => serializeConsentDecision(decision as ConsentDecision)).toThrow(/category name/i);
    },
  );
});

describe("the cookie value between a server and a browser", () => {
  const decision = {
    ...decide(["preferences", "analytics_storage"]),
    policyVersion: "policy 100%",
  };

  /** A response cookie jar as a server framework keeps one: it percent-encodes what it is given. */
  function serverJar(): ConsentCookieStore & { header(name: string): string } {
    const wire = new Map<string, string>();
    return {
      get: (name) => {
        const value = wire.get(name);
        return value === undefined ? undefined : decodeURIComponent(value);
      },
      set: (name, value) => void wire.set(name, encodeURIComponent(value)),
      header: (name) => `${name}=${wire.get(name) ?? ""}`,
    };
  }

  it("is plain JSON: encoding belongs to the store", () => {
    const value = serializeConsentDecision(decision);
    expect(JSON.parse(value)).toMatchObject({ v: 1, policy: "policy 100%", gpc: false });
    expect(parseConsentDecision(value)).toEqual(decision);
    expect(parseConsentDecision(encodeURIComponent(value))).toBeNull();
  });

  it("written by a server store, is read by the browser", async () => {
    const jar = serverJar();
    await cookieConsentAdapter({ store: jar }).write(decision);
    const pair = jar.header(CONSENT_DECISION_COOKIE);
    expect(pair).toContain("=%7B%22v%22");
    expect(pair).not.toContain("%257B");
    const browser = cookieConsentAdapter({ store: documentCookieStore({ cookie: pair }) });
    expect(await browser.read()).toEqual(decision);
  });

  it("written by the browser, is read by a server store", async () => {
    const doc = { cookie: "" };
    await cookieConsentAdapter({ store: documentCookieStore(doc) }).write(decision);
    const pair = doc.cookie.split("; ")[0] ?? "";
    expect(pair).toMatch(/^xos-consent-decision=[A-Za-z0-9%._~!*'()-]+$/);
    const wire = pair.slice(pair.indexOf("=") + 1);
    const server: ConsentCookieStore = {
      get: () => decodeURIComponent(wire),
      set: () => undefined,
    };
    expect(await cookieConsentAdapter({ store: server }).read()).toEqual(decision);
  });

  it("reads nothing from a pair the browser cannot decode", () => {
    const store = documentCookieStore({ cookie: "site-consent=%E0%A4%A" });
    expect(store.get("site-consent")).toBeUndefined();
  });
});

describe("storage that is not there", () => {
  const blocked = (): { cookie: string } =>
    Object.defineProperty({} as { cookie: string }, "cookie", {
      get: () => {
        throw new DOMException("The document is sandboxed.", "SecurityError");
      },
      set: () => {
        throw new DOMException("The document is sandboxed.", "SecurityError");
      },
    });

  it("read and write reject when document.cookie throws; neither throws", async () => {
    const adapter = cookieConsentAdapter({ store: documentCookieStore(blocked()) });
    const read = adapter.read();
    const write = adapter.write(decide(["preferences"]));
    await expect(read).rejects.toThrow("sandboxed");
    await expect(write).rejects.toThrow("sandboxed");
  });

  it("on a server with no store, read resolves null and write rejects", async () => {
    vi.stubGlobal("document", undefined);
    const adapter = cookieConsentAdapter();
    const read = adapter.read();
    const write = adapter.write(decide(["preferences"]));
    await expect(read).resolves.toBeNull();
    await expect(write).rejects.toThrow(/no cookie store/i);
  });

  it("the banner asks, and keeps asking, when the adapter throws instead of rejecting", async () => {
    const throwing: ConsentAdapter = {
      read: () => {
        throw new Error("read threw");
      },
      write: () => {
        throw new Error("write threw");
      },
    };
    const onChoice = vi.fn();
    render(
      <ConsentBanner
        {...COPY}
        record={{ adapter: throwing, policyVersion: POLICY_VERSION }}
        onChoice={onChoice}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Reject all" }));
    expect(onChoice).toHaveBeenCalledExactlyOnceWith("none");
    expect(screen.getByRole("region", { name: "Cookies" })).toBeInstanceOf(HTMLElement);
  });

  it("the banner asks when the cookie adapter cannot reach document.cookie", async () => {
    const adapter = cookieConsentAdapter({ store: documentCookieStore(blocked()) });
    render(<ConsentBanner {...COPY} record={{ adapter, policyVersion: POLICY_VERSION }} />);
    expect(await screen.findByRole("button", { name: "Accept all" })).toBeInstanceOf(HTMLElement);
  });
});

describe("a slow adapter", () => {
  it("a read that answers after a choice does not replace the choice", async () => {
    let release: (state: ConsentState | null) => void = () => undefined;
    const written: ConsentDecision[] = [];
    const slow: ConsentAdapter = {
      read: () => new Promise((resolve) => (release = resolve)),
      write: (decision) => {
        written.push(decision);
        return Promise.resolve();
      },
    };
    const status = (state: ConsentState | null): string =>
      state === null ? "not chosen" : `preferences ${state.categories["preferences"]}`;
    render(
      <ConsentSettings
        {...SETTINGS}
        status={status}
        record={{ adapter: slow, policyVersion: POLICY_VERSION }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("preferences true"));
    await act(async () => {
      release(null);
      await Promise.resolve();
    });
    expect(written).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("preferences true");
    expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", true);
  });
});

describe("keyboard focus on the settings view", () => {
  it("stays on Save after a save through an adapter, and the boxes show the stored choice", async () => {
    const adapter = memoryAdapter();
    render(<ConsentSettings {...SETTINGS} record={{ adapter, policyVersion: POLICY_VERSION }} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/^Preferences:/));
    const save = screen.getByRole("button", { name: "Save choices" });
    save.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(adapter.written).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", true),
    );
    expect(document.activeElement).toBe(save);
    expect(save.isConnected).toBe(true);
    await user.keyboard(" ");
    await waitFor(() => expect(adapter.written).toHaveLength(2));
    expect(document.activeElement).toBe(save);
    expect(adapter.written[1]?.categories).toEqual({ preferences: true, performance: false });
  });

  it("shows a choice made with Reject all in the boxes", async () => {
    const adapter = memoryAdapter({
      categories: { preferences: true, performance: true },
      gpc: false,
    });
    render(<ConsentSettings {...SETTINGS} record={{ adapter, policyVersion: POLICY_VERSION }} />);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", true),
    );
    const reject = screen.getByRole("button", { name: "Reject all" });
    reject.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByLabelText(/^Preferences:/)).toHaveProperty("checked", false),
    );
    expect(document.activeElement).toBe(reject);
  });
});

describe("Global Privacy Control reported by the browser alone, with an action", () => {
  const gpcFields = (): string[] =>
    [...document.querySelectorAll("form")].map(
      (form) =>
        form.querySelector<HTMLInputElement>('input[type="hidden"][name="gpc"]')?.value ?? "",
    );

  it("every form on the settings view posts gpc=1, so a later choice keeps the flag", async () => {
    withBrowserSignal();
    const action = vi.fn<(form: FormData) => void>();
    render(<ConsentSettings {...SETTINGS} action={action} gpcNotice={GPC_TEXT} />);
    expect(gpcFields()).toEqual(["1", "1"]);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Reject all" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    const posted = action.mock.calls[1]?.[0];
    expect(posted?.get("choice")).toBe("none");
    expect(posted?.get("gpc")).toBe("1");
  });

  it("the forms carry no gpc field when the request had the signal, or when there is none", () => {
    const withHeader = render(<ConsentSettings {...SETTINGS} action="/consent" gpc />);
    expect(gpcFields()).toEqual(["", ""]);
    withHeader.unmount();
    render(<ConsentSettings {...SETTINGS} action="/consent" />);
    expect(gpcFields()).toEqual(["", ""]);
  });

  it("with a URL action: the banner confirms it and tells onChoice once; nothing is sent", async () => {
    withBrowserSignal();
    const fetched = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetched);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const onChoice = vi.fn();
    const view = render(
      <ConsentBanner {...COPY} action="/api/consent" gpcLabel={GPC_TEXT} onChoice={onChoice} />,
    );
    expect(screen.getByRole("status").textContent).toContain(GPC_TEXT);
    expect(document.querySelector("form")).toBeNull();
    await waitFor(() => expect(onChoice).toHaveBeenCalledExactlyOnceWith("none"));
    view.rerender(
      <ConsentBanner {...COPY} action="/api/consent" gpcLabel={GPC_TEXT} onChoice={onChoice} />,
    );
    expect(onChoice).toHaveBeenCalledTimes(1);
    expect(fetched).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    delete (navigator as { sendBeacon?: unknown }).sendBeacon;
  });

  it("with a URL action: the settings forms post the gpc field to that URL", () => {
    withBrowserSignal();
    render(<ConsentSettings {...SETTINGS} action="/api/consent" gpcNotice={GPC_TEXT} />);
    expect(gpcFields()).toEqual(["1", "1"]);
    for (const form of document.querySelectorAll("form"))
      expect(form.getAttribute("action")).toBe("/api/consent");
  });
});

describe("right to left", () => {
  it("the cookie table and its caption align to the reading start", () => {
    render(
      <ConsentSettings
        {...SETTINGS}
        cookies={{
          caption: "Cookies this site sets",
          nameLabel: "Name",
          categoryLabel: "Category",
          purposeLabel: "What it does",
          rows: [{ name: "xos-theme", category: "Preferences", purpose: "Remembers the theme." }],
        }}
      />,
    );
    const table = screen.getByRole("table");
    for (const element of [table, table.querySelector("caption")]) {
      expect(element?.className).toContain("text-start");
      expect(element?.className).not.toContain("text-left");
    }
  });
});

describe("links", () => {
  const renderLink = (link: ConsentLink, className: string): ReactNode => (
    <a href={link.href} className={className} data-router="app">
      {link.label}
    </a>
  );

  it("are plain anchors by default", () => {
    render(<ConsentBanner {...COPY} settings={{ label: "Cookie settings", href: "/settings" }} />);
    for (const name of ["Cookie Policy", "Cookie settings"])
      expect(screen.getByRole("link", { name }).hasAttribute("data-router")).toBe(false);
  });

  it("are drawn by renderLink when the app has a router link, with the library's link style", () => {
    const view = render(
      <ConsentBanner
        {...COPY}
        settings={{ label: "Cookie settings", href: "/settings" }}
        renderLink={renderLink}
      />,
    );
    const plain =
      "xos-hit inline-flex items-center gap-2 font-medium text-accent-text no-underline";
    for (const [name, href] of [
      ["Cookie Policy", "/legal/cookie-policy"],
      ["Cookie settings", "/settings"],
    ] as const) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("data-router")).toBe("app");
      expect(link.getAttribute("href")).toBe(href);
      expect(link.className).toContain(plain);
    }
    view.unmount();
    render(<ConsentSettings {...SETTINGS} policy={COPY.policy} renderLink={renderLink} />);
    expect(screen.getByRole("link", { name: "Cookie Policy" }).getAttribute("data-router")).toBe(
      "app",
    );
  });
});
