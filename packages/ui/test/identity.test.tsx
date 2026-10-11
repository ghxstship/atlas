import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  BrandSlot,
  CredentialBadge,
  PresenceIndicator,
  QRCode,
  WhiteLabelPreview,
  qrPath,
  tokenVariable,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

describe("PresenceIndicator", () => {
  it("names who is here and how many", async () => {
    const { container } = render(
      <div>
        <PresenceIndicator names={["Ana Ruiz", "Ben Cole", "Cy Park", "Di Wu"]} />
        <PresenceIndicator names={["Ana Ruiz"]} verb="editing" />
      </div>,
    );
    expect(
      screen.getByRole("img", { name: "Ana Ruiz, Ben Cole, Cy Park, and Di Wu, viewing now" }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ana Ruiz, editing now" })).toBeTruthy();
    expect(screen.getByText("4 viewing")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("QRCode and CredentialBadge", () => {
  it("draws a scannable code with a quiet zone", async () => {
    const { size, path } = qrPath("XOS:CRD-0042");
    expect(size).toBeGreaterThan(21 + 7);
    expect(path.startsWith("M")).toBe(true);
    const { container } = render(
      <QRCode value="XOS:CRD-0042" label="Credential code CRD-0042" size={120} />,
    );
    const svg = screen.getByRole("img", { name: "Credential code CRD-0042" });
    expect(svg.getAttribute("width")).toBe("120");
    expect(container.querySelector("rect")?.getAttribute("class")).toContain("fill-paper");
    await expectAccessible(container);
  });

  it("shows the category label, holder, zones and validity", async () => {
    const onWallet = vi.fn();
    const { container } = render(
      <CredentialBadge
        org="Northwind Live"
        name="Dana Ortiz"
        role="Stage Manager"
        category="All Access"
        categoryColor={3}
        credentialKey="CRD-0042"
        payload="XOS:CRD-0042"
        zones={["Stage", "Backstage"]}
        validFrom="Nov 3"
        validTo="Nov 5"
        onWallet={onWallet}
      />,
    );
    expect(screen.getByRole("article", { name: "Credential for Dana Ortiz" })).toBeTruthy();
    expect(screen.getByText("All Access")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Credential code CRD-0042" })).toBeTruthy();
    expect(screen.getByText("Valid Nov 3 to Nov 5")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Add to Wallet/ }));
    expect(onWallet).toHaveBeenCalled();
    await expectAccessible(container);
  });
});

describe("white label", () => {
  it("draws brand slots in proportion with their delivery size", async () => {
    const { container } = render(
      <div>
        <BrandSlot label="Logo, Light" width={160} height={40} formats="SVG or PNG" />
        <BrandSlot label="Splash Screen" width={1290} height={2796} formats="PNG" />
      </div>,
    );
    expect(screen.getAllByText("1,290 x 2,796")).toHaveLength(2);
    expect(container.querySelector('[aria-hidden="true"]')?.getAttribute("style")).toContain(
      "calc(var(--space-4) * 40)",
    );
    await expectAccessible(container);
  });

  it("renders the sample under each brand with token overrides only", async () => {
    const { container } = render(
      <WhiteLabelPreview
        sample={<Button variant="primary">Create Record</Button>}
        brands={[
          {
            name: "Northwind Live",
            domain: "atlas.northwind.example",
            theme: "dark",
            tokens: { "accent-default": "#2F6FEB", "radius-card": "12px" },
          },
          {
            name: "Harbor Light Events",
            domain: "ops.harborlight.example",
            theme: "light",
            tokens: { "accent-default": "#0F766E" },
          },
        ]}
      />,
    );
    const northwind = screen.getByRole("region", { name: "Northwind Live" });
    expect(northwind.getAttribute("data-theme")).toBe("dark");
    expect(northwind.style.getPropertyValue("--color-accent-default")).toBe("#2F6FEB");
    expect(northwind.style.getPropertyValue("--radius-card")).toBe("12px");
    expect(screen.getAllByRole("button", { name: "Create Record" })).toHaveLength(2);
    expect(tokenVariable("unknown-token")).toBe("--unknown-token");
    await expectAccessible(container);
  });
});
