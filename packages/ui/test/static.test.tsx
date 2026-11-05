import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buttonClass } from "../src/index.ts";
import { Skeleton, TemplateSystemLink } from "../src/static.ts";

/**
 * `@xos/ui/static` renders without any provider, as a React Server Component renders it: no hooks,
 * no context, no handlers.
 */
describe("@xos/ui/static", () => {
  it("renders the System template with its action as a link styled as the primary Button", () => {
    const html = renderToStaticMarkup(
      <TemplateSystemLink
        icon="SearchX"
        title="Page not found"
        sentence="Check the address."
        actionLabel="Go to Home"
        href="/demo/home"
      />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Page not found");
    expect(html).toContain(`<a href="/demo/home" class="${buttonClass("primary")}">Go to Home</a>`);
    expect(html).not.toContain("<button");
  });

  it("renders a skeleton block", () => {
    expect(renderToStaticMarkup(<Skeleton width={240} height={28} />)).toContain(
      "inline-size:240px",
    );
  });
});
