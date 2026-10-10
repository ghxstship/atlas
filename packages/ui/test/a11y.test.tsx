import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectAccessible } from "./a11y.ts";

describe("axe helper", () => {
  it("fails on a serious finding, so passing component runs mean something", async () => {
    const { container } = render(
      <div>
        <button type="button" />
        <img src="x.png" />
      </div>,
    );
    await expect(expectAccessible(container)).rejects.toThrow();
  });
});
