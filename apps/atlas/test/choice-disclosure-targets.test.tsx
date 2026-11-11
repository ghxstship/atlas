import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceDisclosure } from "@/components/settings/choice-disclosure";

/**
 * The webhook form's Events list (342 boxes) failed axe target-size (serious, WCAG 2.5.8) on every 16 by 16 px
 * checkbox (crawl 4.9). Inside a ChoiceDisclosure each box is the fine-pointer target, 24 px, from the
 * density.target-fine token the controls use.
 */
describe("ChoiceDisclosure", () => {
  it("sizes the checkboxes it holds to the 24 px target", () => {
    const html = renderToStaticMarkup(
      h(
        ChoiceDisclosure,
        { title: "Events", summary: "0 chosen" },
        h("label", null, h("input", { type: "checkbox", className: "xos-check-input" }), "x"),
      ),
    );
    expect(html).toContain("[&amp;_.xos-check-input]:[--ui-check:var(--density-target-fine)]");
  });
});
