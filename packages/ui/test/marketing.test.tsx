import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import esUS from "@xos/i18n/messages/es-US/ui.json" with { type: "json" };
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Ui from "../src/index.ts";
import {
  BrandMark,
  BrandSlot,
  Button,
  XOSProvider,
  buttonClass,
  flattenMessages,
} from "../src/index.ts";
import * as Marketing from "../src/marketing.ts";
import {
  AIDisclosureBadge,
  ButtonLink,
  CodeSample,
  ComparisonTable,
  FAQ,
  FeatureGrid,
  GateLifecycleRail,
  LogoSlotWall,
  MarketingFooter,
  MarketingHero,
  MarketingNav,
  MarketingSection,
  PersonaSwitcher,
  PriceDisplay,
  PricingTable,
  ProofStatStrip,
  ScreenshotFrame,
  SurfaceTriptych,
  Testimonial,
  marketingCopy,
} from "../src/marketing.ts";
import { expectAccessible } from "./a11y.ts";

const es = flattenMessages(esUS);

/** The components a server component renders: no state, so no hooks and no context. */
const SERVER = [
  "ButtonLink",
  "MarketingSection",
  "MarketingHero",
  "ScreenshotFrame",
  "ProofStatStrip",
  "GateLifecycleRail",
  "SurfaceTriptych",
  "FeatureGrid",
  "ComparisonTable",
  "PriceDisplay",
  "FAQ",
  "Testimonial",
  "LogoSlotWall",
  "AIDisclosureBadge",
] as const;
const CLIENT = [
  "MarketingNav",
  "PersonaSwitcher",
  "PricingTable",
  "CodeSample",
  "MarketingFooter",
] as const;

const personas = [
  {
    value: "producers",
    label: "Producers",
    icon: "Clapperboard",
    title: "Know where every show stands.",
    body: "Each project moves through nine gates.",
    pointsTitle: "What you get",
    points: ["Gate readiness with evidence"],
    primary: { label: "Start Free Trial", href: "#trial" },
    secondary: { label: "Start Free", href: "#start" },
  },
  {
    value: "finance",
    label: "Finance",
    title: "Commit spend only against a purchase order.",
    body: "Requests become RFQs.",
  },
  {
    value: "field",
    label: "Field Teams",
    title: "Give the crew one place for the day.",
    body: "Shifts and day sheets sit on one record.",
    points: ["Shifts, swaps and timesheets"],
  },
];

const periods = [
  { value: "monthly", label: "Monthly", unit: "month" as const },
  { value: "annual", label: "Annual", unit: "year" as const, note: "Annual billing is ten times." },
];
const plans = [
  {
    name: "Access",
    blurb: "One person and one production.",
    prices: { monthly: 0, annual: 0 },
    cta: { label: "Start Free", href: "#start" },
    limits: [{ label: "Seats", value: "1" }],
  },
  {
    name: "Pro",
    blurb: "For teams that hire in public.",
    prices: { monthly: 399, annual: 3990 },
    cta: { label: "Start Free Trial", href: "#pro" },
    recommended: true,
    featuresTitle: "Adds",
    features: ["Automations"],
  },
  { name: "Team", blurb: "Larger organizations.", prices: { monthly: null, annual: null } },
  { name: "Enterprise", blurb: "Single sign-on and a contract.", quoteFrom: 2500, note: "Annual." },
];

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("Marketing layer boundaries", () => {
  it("exports the 19 ported components from both entries; the consent banner has its own folder", () => {
    const names = [...SERVER, ...CLIENT];
    expect(names).toHaveLength(19);
    for (const entry of [Ui, Marketing] as Record<string, unknown>[]) {
      expect(names.filter((name) => typeof entry[name] !== "function")).toEqual([]);
    }
    // The export's consent banner is reference only: the shared banner is src/ConsentBanner, on the main entry.
    expect(
      Object.keys(Marketing).filter((name) => /consentbanner|cookiebanner/i.test(name)),
    ).toEqual([]);
    expect(typeof (Ui as Record<string, unknown>)["ConsentBanner"]).toBe("function");
  });

  it("resolves shared strings from props first, then from configure", () => {
    expect(marketingCopy({ locale: undefined, messages: undefined }).t("mk.skip")).toBe(
      "Skip to content",
    );
    expect(Marketing.flattenMessages(esUS)).toEqual(es);
    const copy = marketingCopy({ locale: "es-US", messages: es });
    expect(copy.locale).toBe("es-US");
    expect(copy.t("mk.proof.source", { label: "Canon" })).toBe("Fuente: Canon");
  });
});

describe("ButtonLink and the xl size", () => {
  it("draws a link as a Button, at every size, and opens external links in a new tab", () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/start" variant="primary" size="xl" icon="Rocket" trailingIcon="ArrowRight">
        Start Free
      </ButtonLink>,
    );
    expect(html).toContain('href="/start"');
    expect(html).toContain(buttonClass("primary", "xl"));
    expect(html).not.toContain("target=");
    expect(buttonClass("secondary", "xl")).toContain("h-target-coarse");
    const external = renderToStaticMarkup(
      <ButtonLink href="https://example.com" external>
        Read Docs
      </ButtonLink>,
    );
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');
    expect(external).toContain(buttonClass("secondary", "md"));
  });

  it("gives Button the same xl size", () => {
    render(<Button size="xl">Start Free</Button>);
    expect(screen.getByRole("button", { name: "Start Free" }).className).toContain(
      "h-target-coarse",
    );
  });
});

describe("server-rendered components", () => {
  it("renders a section and both heroes with the fluid display classes", () => {
    const html = renderToStaticMarkup(
      <main>
        <MarketingHero
          eyebrow="Atlas 4.0"
          title="Run every production in one system."
          lead="Plan, budget and staff."
          actions={<ButtonLink href="#start">Start Free</ButtonLink>}
          note="Paid plans start with a trial."
          media={<ScreenshotFrame src="/shot.png" alt="Atlas gate readiness" eager />}
        />
        <MarketingSection
          id="lifecycle"
          eyebrow="One Lifecycle"
          glyph="Milestone"
          title="Nine gates."
          lead="Atlas runs each production through nine gates."
          badge={<AIDisclosureBadge />}
          tone="surface"
          align="center"
        >
          <p>Content</p>
        </MarketingSection>
        <MarketingSection title="Untitled band" headingLevel={3} />
        <MarketingHero variant="compact" title="Start your first production." />
      </main>,
    );
    expect(html).toContain('<h1 class="xos-mkt-display-64">');
    expect(html).toContain('<h2 id="lifecycle-title" class="xos-mkt-display-40">');
    expect(html).toContain('aria-labelledby="lifecycle-title"');
    expect(html).toContain("xos-mkt-section-surface xos-mkt-center");
    expect(html).toContain('<h3 class="xos-mkt-display-40">Untitled band</h3>');
    expect(html).toContain('<h2 class="xos-mkt-display-48">');
    expect(html).toContain("xos-mkt-hero-compact xos-mkt-hero-solo");
    expect(html).toContain('loading="eager"');
    expect(html).toContain("AI feature");
  });

  it("frames an image lazily, or live components as one inert picture", async () => {
    const { container } = render(
      <div>
        <ScreenshotFrame src="/a.png" alt="Budget grid" width={1280} height={800} chrome={false} />
        <ScreenshotFrame
          alt="Gate readiness for Gate 3"
          title="Northwind Live"
          caption="Shown with preview data."
          height={320}
        >
          <button type="button">Enter Gate 4</button>
        </ScreenshotFrame>
      </div>,
    );
    const image = screen.getByRole("img", { name: "Budget grid" });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(container.querySelectorAll(".xos-mkt-shot-bar")).toHaveLength(1);
    const live = screen.getByRole("img", { name: "Gate readiness for Gate 3" });
    expect(live.style.blockSize).toBe("320px");
    expect(live.querySelector("[inert]")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Shown with preview data.").tagName).toBe("FIGCAPTION");
    await expectAccessible(container);
  });

  it("formats proof figures for the locale and links each source", () => {
    const items = [
      { value: 1211, label: "Catalog items", source: { label: "Canon seed", href: "#seed" } },
      { value: "99.9%", label: "Uptime target" },
    ];
    const en = renderToStaticMarkup(<ProofStatStrip label="By the numbers" items={items} />);
    expect(en).toContain("1,211");
    expect(en).toContain('<a class="xos-mkt-proof-src" href="#seed">Source: Canon seed</a>');
    expect(en).toContain("--xos-mkt-n:2");
    expect(en).toContain("99.9%");
    const spanish = renderToStaticMarkup(
      <ProofStatStrip label="En cifras" items={items} locale="es-US" messages={es} />,
    );
    expect(spanish).toContain("Fuente: Canon seed");
  });

  it("lays the gates out by act, each number beside its name", async () => {
    const { container } = render(
      <GateLifecycleRail
        label="The nine gates"
        acts={[
          {
            name: "Build",
            range: "Gates 4 to 6",
            gates: [
              { n: 4, code: "PRC", name: "Procure", summary: "Issue awards.", evidence: "Unit." },
              { n: 5, code: "BLD", name: "Build" },
            ],
          },
          { name: "Show", gates: [{ n: 7, code: "OPR", name: "Operate" }] },
        ]}
      />,
    );
    const rail = screen.getByRole("list", { name: "The nine gates" });
    const inner = within(rail).getAllByRole("list");
    expect(inner[0]?.getAttribute("start")).toBe("4");
    expect(inner[1]?.getAttribute("start")).toBe("7");
    expect(screen.getByText("Gate 4")).toBeTruthy();
    expect(screen.getByText("Procure").tagName).toBe("STRONG");
    expect(screen.getByText("Gates 4 to 6")).toBeTruthy();
    expect(screen.getByText("Unit.")).toBeTruthy();
    await expectAccessible(container);
  });

  it("shows each surface with its status as a word", async () => {
    const { container } = render(
      <SurfaceTriptych
        items={[
          {
            name: "Atlas",
            icon: "LayoutDashboard",
            audience: "Your team",
            body: "The workspace.",
            status: { label: "Available", tone: "success" },
            points: ["Projects and schedule"],
            link: { label: "See Pricing", href: "#pricing" },
          },
          { name: "Compass", body: "The field app.", status: { label: "In Progress" } },
          { name: "Gateway", body: "The portal." },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See Pricing" }).getAttribute("href")).toBe("#pricing");
    await expectAccessible(container);
  });

  it("prints a department code beside its name and says when a link opens a new tab", async () => {
    const { container } = render(
      <FeatureGrid
        columns={4}
        headingLevel={4}
        items={[
          { title: "Environment", code: "4000" },
          {
            title: "API",
            icon: "Code",
            body: "One contract.",
            link: { label: "Read API Docs", href: "https://example.com", external: true },
          },
          { title: "Plain", link: { label: "More", href: "#more" } },
        ]}
      />,
    );
    expect(container.querySelector("ul")?.className).toBe("xos-mkt-grid xos-mkt-grid-4");
    expect(screen.getByRole("heading", { level: 4, name: "Environment" })).toBeTruthy();
    expect(screen.getByText("4000")).toBeTruthy();
    const external = screen.getByRole("link", { name: /Read API Docs/ });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(within(external).getByRole("img", { name: "Opens in a new tab" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "More" }).getAttribute("target")).toBeNull();
    expect(renderToStaticMarkup(<FeatureGrid columns={2} items={[]} />)).toContain(
      'class="xos-mkt-grid"',
    );
    await expectAccessible(container);
  });

  it("keeps the comparison a table, with a word in every cell", async () => {
    const { container } = render(
      <ComparisonTable
        caption="Atlas and two alternatives"
        verified="November 14, 2026"
        columns={[{ name: "Atlas", highlight: true }, { name: "Product A" }, { name: "Product B" }]}
        rows={[
          {
            feature: "Public pricing",
            cells: [
              { value: "yes" },
              { value: "partial", source: { label: "Pricing page", href: "#a" } },
              { value: "no", text: "Sales only" },
            ],
          },
          {
            feature: "Gated lifecycle",
            cells: [{ value: "yes" }, { value: "unpublished" }, { value: "unpublished" }],
          },
        ]}
        footnote="Unpublished means the product does not state the feature."
      />,
    );
    const table = screen.getByRole("table", { name: /Atlas and two alternatives/ });
    expect(within(table).getByText("Last verified November 14, 2026.")).toBeTruthy();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["Feature", "Atlas", "Product A", "Product B"]);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(2);
    const cells = within(table).getAllByRole("cell");
    expect(cells.map((c) => c.getAttribute("data-label")).slice(0, 3)).toEqual([
      "Atlas",
      "Product A",
      "Product B",
    ]);
    expect(cells[0]?.className).toBe("xos-mkt-cmp-own");
    expect(cells.map((c) => c.querySelector(".xos-mkt-cmp-cell")?.textContent)).toEqual([
      "Yes",
      "Partial",
      "Sales only",
      "Yes",
      "Unpublished",
      "Unpublished",
    ]);
    expect(within(table).getByRole("link", { name: "Pricing page" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Atlas and two alternatives" })).toBeTruthy();
    await expectAccessible(container);
    const spanish = renderToStaticMarkup(
      <ComparisonTable
        caption="Atlas"
        featureLabel="Capacidad"
        columns={[{ name: "Atlas" }]}
        rows={[{ feature: "Precios", cells: [{ value: "yes" }] }]}
        locale="es-US"
        messages={es}
      />,
    );
    expect(spanish).toContain("Capacidad");
    expect(spanish).toContain("Sí");
  });

  it("never prints an unpriced amount as zero", () => {
    const price = (node: React.ReactElement) =>
      renderToStaticMarkup(node)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(price(<PriceDisplay amount={149} period="month" taxMode="exclusive" />)).toBe(
      "$149 per month USD, excluding applicable taxes.",
    );
    expect(price(<PriceDisplay amount={12.5} period="year" taxMode="inclusive" />)).toBe(
      "$12.50 per year USD, including applicable taxes.",
    );
    expect(price(<PriceDisplay amount={2500} from period="month" />)).toBe("From $2,500 per month");
    expect(price(<PriceDisplay amount={null} period="month" />)).toBe("Quoted");
    expect(price(<PriceDisplay amount={0} />)).toBe("$0");
    expect(
      price(<PriceDisplay amount={1490} period="year" locale="es-US" messages={es} from />),
    ).toMatch(/^Desde .*1[,.]?490.* al año$/);
  });

  it("keeps every answer in the document while closed", async () => {
    const { container } = render(
      <FAQ
        items={[
          { q: "What does Atlas cost?", a: "Access is free.", open: true },
          { q: "Is Atlas open source?", a: <p>Yes, under AGPL-3.0.</p> },
        ]}
      />,
    );
    const details = container.querySelectorAll("details");
    expect(details[0]?.open).toBe(true);
    expect(details[1]?.open).toBe(false);
    expect(screen.getByRole("heading", { level: 3, name: "Is Atlas open source?" })).toBeTruthy();
    expect(details[1]?.textContent).toContain("Yes, under AGPL-3.0.");
    await expectAccessible(container);
  });

  it("shows a testimonial with its required disclosure", async () => {
    const { container } = render(
      <Testimonial
        quote="We stopped asking where a show stands."
        name="Maya Okafor"
        role="Head of Production"
        org="Northwind Live"
        disclosure="Northwind Live is a fictional company used in XOS previews."
      />,
    );
    expect(container.querySelector("blockquote")?.textContent).toBe(
      "We stopped asking where a show stands.",
    );
    expect(screen.getByRole("img", { name: "Maya Okafor" }).textContent).toBe("MO");
    expect(screen.getByText("Northwind Live")).toBeTruthy();
    expect(screen.getByText(/fictional company/)).toBeTruthy();
    await expectAccessible(container);
  });

  it("renders nothing for an empty logo wall, and slots or marks otherwise", async () => {
    expect(renderToStaticMarkup(<LogoSlotWall label="Customers" />)).toBe("");
    const { container } = render(
      <LogoSlotWall
        label="Customer logo slots"
        title="Reserved for customer marks"
        slots={2}
        logos={[{ name: "Northwind Live" }, { name: "Harbor Light", logoLight: "/harbor.svg" }]}
        disclosure="Slots stay empty until each customer consents in writing."
      />,
    );
    const list = screen.getByRole("list", { name: "Customer logo slots" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("Logo Slot 2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Harbor Light" })).toBeTruthy();
    expect(screen.getByText("Reserved for customer marks")).toBeTruthy();
    await expectAccessible(container);
  });

  it("draws a brand slot the same through BrandSlot and the logo wall", () => {
    const slot = renderToStaticMarkup(
      <BrandSlot label="Logo Slot 1" width={160} height={40} formats="SVG" />,
    );
    expect(slot).toContain("160 x 40");
    expect(renderToStaticMarkup(<LogoSlotWall label="Slots" slots={1} />)).toContain(slot);
  });

  it("marks an AI feature in words, with the provider and the notice", () => {
    const html = renderToStaticMarkup(
      <AIDisclosureBadge
        provider="Aurora uses Anthropic Claude models."
        href="#ai-notice"
        linkLabel="Read AI Features Notice"
      />,
    );
    expect(html).toContain("AI feature");
    expect(html).toContain("Aurora uses Anthropic Claude models.");
    expect(html).toContain('href="#ai-notice"');
    expect(renderToStaticMarkup(<AIDisclosureBadge label="Generated image" />)).not.toContain(
      "<a ",
    );
  });
});

describe("components bound to the provider", () => {
  it("follow the locale of the nearest XOSProvider when imported from @xos/ui", () => {
    render(
      <XOSProvider locale="es-US" messages={es}>
        <Ui.ProofStatStrip
          label="En cifras"
          items={[{ value: 9, label: "Compuertas", source: { label: "Canon", href: "#c" } }]}
        />
        <Ui.PriceDisplay amount={null} />
        <Ui.AIDisclosureBadge />
        <Ui.LogoSlotWall label="Marcas" slots={1} />
        <Ui.GateLifecycleRail
          label="Compuertas"
          acts={[{ name: "Plan", gates: [{ n: 1, code: "SCP", name: "Alcance" }] }]}
        />
        <Ui.FeatureGrid
          items={[{ title: "API", link: { label: "Docs", href: "#d", external: true } }]}
        />
        <Ui.ComparisonTable
          caption="Atlas"
          columns={[{ name: "Atlas" }]}
          rows={[{ feature: "Precios", cells: [{ value: "no" }] }]}
        />
      </XOSProvider>,
    );
    expect(screen.getByText("Fuente: Canon")).toBeTruthy();
    expect(screen.getByText("Cotizado")).toBeTruthy();
    expect(screen.getByText("Función de IA")).toBeTruthy();
    expect(screen.getByText("Espacio de logotipo 1")).toBeTruthy();
    expect(screen.getByText(es["phase.gate"]?.replace("{n}", "1") ?? "missing")).toBeTruthy();
    expect(screen.getByRole("img", { name: es["link.newTab"] ?? "missing" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Función" })).toBeTruthy();
  });

  it("let an explicit locale win over the provider", () => {
    render(
      <XOSProvider locale="es-US" messages={es}>
        <Ui.PriceDisplay amount={null} locale="en-US" messages={{}} />
      </XOSProvider>,
    );
    expect(screen.getByText("Quoted")).toBeTruthy();
  });
});

describe("MarketingNav", () => {
  it("puts the skip link first and opens the menu panel from a labeled toggle", async () => {
    const { container } = render(
      <MarketingNav
        brand={<BrandMark name="Atlas" />}
        links={[
          { label: "Product", href: "#product", current: true },
          { label: "Pricing", href: "#pricing" },
        ]}
        actions={<ButtonLink href="#start">Start Free</ButtonLink>}
        secondaryActions={<ButtonLink href="#sign-in">Sign In</ButtonLink>}
      />,
    );
    const skip = container.querySelector("a");
    expect(skip?.textContent).toBe("Skip to content");
    expect(skip?.getAttribute("href")).toBe("#main");
    expect(container.querySelector(".xos-mkt-nav-brand")?.getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Menu" });
    const panel = container.querySelector(".xos-mkt-nav-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.hasAttribute("hidden")).toBe(true);
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Close Menu" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(within(panel as HTMLElement).getByRole("link", { name: "Sign In" })).toBeTruthy();
    expect(
      within(panel as HTMLElement)
        .getByRole("link", { name: "Product" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await expectAccessible(container);
  });

  it("takes its own label, home and skip target", () => {
    render(
      <MarketingNav
        brand="Atlas"
        homeHref="/es"
        label="Secciones"
        skipHref="#contenido"
        links={[]}
        actions={null}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Secciones" })).toBeTruthy();
    expect(screen.getByText("Skip to content").getAttribute("href")).toBe("#contenido");
  });
});

describe("PersonaSwitcher", () => {
  it("renders every panel, shows one, and moves with the arrow keys, Home and End", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <PersonaSwitcher
        label="Choose your role"
        personas={personas}
        hash={false}
        onChange={onChange}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    const panels = container.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(3);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panels[0]?.id);
    expect(panels[1]?.hasAttribute("hidden")).toBe(true);
    expect(panels[1]?.textContent).toContain("Requests become RFQs.");
    expect(screen.getByRole("link", { name: "Start Free Trial" }).getAttribute("href")).toBe(
      "#trial",
    );
    await expectAccessible(container);

    tabs[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("finance");
    expect(document.activeElement).toBe(tabs[1]);
    expect(panels[1]?.hasAttribute("hidden")).toBe(false);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[2]);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[0]);
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[2]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
    await userEvent.keyboard("a");
    expect(document.activeElement).toBe(tabs[0]);
    await userEvent.click(tabs[2] as HTMLElement);
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(window.location.hash).toBe("");
  });

  it("mirrors the arrow keys in a right-to-left document", async () => {
    render(
      <div dir="rtl">
        <PersonaSwitcher label="Roles" personas={personas} hash={false} value="finance" />
      </div>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    tabs[1]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("keeps the choice in the URL hash and follows it", async () => {
    window.history.replaceState(null, "", "#for-field");
    render(<PersonaSwitcher label="Roles" personas={personas} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(tabs[1] as HTMLElement);
    expect(window.location.hash).toBe("#for-finance");
    act(() => {
      window.history.replaceState(null, "", "#for-producers");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    act(() => {
      window.history.replaceState(null, "", "#pricing");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("still changes tabs when the frame refuses history writes", async () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("sandboxed", "SecurityError");
    });
    render(<PersonaSwitcher label="Roles" personas={personas} hashPrefix="role-" />);
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[1] as HTMLElement);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("PricingTable", () => {
  it("prices each plan for the chosen period and announces the change", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <PricingTable
        currency="USD"
        taxMode="exclusive"
        periods={periods}
        plans={plans}
        terms="Paid plans start with a 14-day trial."
        onChange={onChange}
      />,
    );
    const items = container.querySelectorAll(".xos-mkt-plan");
    const price = (index: number) =>
      items[index]?.querySelector(".xos-mkt-price")?.textContent?.replace(/\s+/g, " ");
    expect(items).toHaveLength(4);
    expect(price(0)).toBe("$0");
    expect(price(1)).toBe("$399per monthUSD, excluding applicable taxes.");
    expect(price(2)).toBe("QuotedUSD, excluding applicable taxes.");
    expect(price(3)).toBe("From $2,500per monthUSD, excluding applicable taxes.");
    expect(items[1]?.className).toContain("xos-mkt-plan-rec");
    expect(within(items[1] as HTMLElement).getByText("Recommended")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start Free Trial" }).className).toContain(
      buttonClass("primary", "xl"),
    );
    expect(screen.getByText("Annual billing is ten times.")).toBeTruthy();
    expect(screen.getByText("Paid plans start with a 14-day trial.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    await expectAccessible(container);

    await userEvent.click(screen.getByRole("radio", { name: "Annual" }));
    expect(onChange).toHaveBeenCalledWith("annual");
    expect(price(1)).toBe("$3,990per yearUSD, excluding applicable taxes.");
    expect(price(3)).toBe("From $2,500per monthUSD, excluding applicable taxes.");
    expect(screen.getByRole("status").textContent).toBe("Prices now show Annual billing.");
  });

  it("starts on the given period and prints no tax label without a tax mode", () => {
    const { container } = render(
      <PricingTable periods={periods} period="annual" plans={plans.slice(1, 2)} />,
    );
    expect(screen.getByRole("radio", { name: "Annual" }).getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".xos-mkt-price")?.textContent).toBe("$3,990per year");
    expect(container.querySelector(".xos-mkt-pricing-terms")).toBeNull();
  });
});

describe("CodeSample", () => {
  it("copies the code and confirms it, then resets", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container, unmount } = render(
      <CodeSample label="Install the SDK" code="npm install @ghxstship/xos-sdk" />,
    );
    expect(screen.getByRole("region", { name: "Install the SDK" }).textContent).toBe(
      "npm install @ghxstship/xos-sdk",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("npm install @ghxstship/xos-sdk");
    expect(screen.getByRole("status").textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status").textContent).toBe("");
    vi.useRealTimers();
    await expectAccessible(container);
    unmount();
  });

  it("leaves the text selectable when the clipboard refuses or is missing", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rerender } = render(<CodeSample label="Install" code="pip install xos-sdk" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    rerender(<CodeSample label="Install" code="pip install xos-sdk" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("MarketingFooter", () => {
  const columns = [
    { title: "Product", links: [{ label: "Pricing", href: "#pricing" }] },
    { title: "Legal", links: [{ label: "Privacy Policy", href: "#privacy" }] },
  ];

  it("lists the columns, the open locales and the three themes, and applies a theme", async () => {
    const onLocale = vi.fn();
    const { container } = render(
      <MarketingFooter
        brand={<BrandMark name="Atlas" />}
        tagline="Atlas is part of XOS."
        label="Footer"
        columns={columns}
        legal="Prices are in USD and exclude applicable taxes."
        locales={[
          { value: "en-US", label: "English" },
          { value: "es-US", label: "Español" },
        ]}
        locale="en-US"
        onLocale={onLocale}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Footer" });
    expect(within(nav).getAllByRole("heading", { level: 2 })).toHaveLength(2);
    expect(within(nav).getByRole("link", { name: "Privacy Policy" })).toBeTruthy();
    const language = screen.getByRole("combobox", { name: "Language" });
    expect((language as HTMLSelectElement).value).toBe("en-US");
    await userEvent.selectOptions(language, "es-US");
    expect(onLocale).toHaveBeenCalled();
    expect(
      within(screen.getByRole("radiogroup", { name: "Theme" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Dark", "Light", "Sunlight"]);
    await userEvent.click(screen.getByRole("radio", { name: "Sunlight" }));
    expect(document.documentElement.dataset["theme"]).toBe("sunlight");
    await expectAccessible(container);
  });

  it("hands the theme to onTheme when given, and drops the controls when asked", async () => {
    const onTheme = vi.fn();
    const { rerender, container } = render(
      <MarketingFooter
        brand="Atlas"
        label="Footer"
        columns={columns}
        legal="Legal line."
        theme="light"
        onTheme={onTheme}
      />,
    );
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onTheme).toHaveBeenCalledWith("dark");
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    rerender(
      <MarketingFooter brand="Atlas" label="Footer" columns={columns} legal="L" themes={false} />,
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(container.querySelector(".xos-mkt-footer-theme")).toBeNull();
  });
});
