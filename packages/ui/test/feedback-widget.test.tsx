import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackWidget } from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

/** The feedback widget as Atlas and Gateway use it (A96): a file field, the context shown before sending, and a send that can fail. */
describe("FeedbackWidget in the apps", () => {
  it("shows what is sent, takes the app's screenshot field and waits for the send", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const { container } = render(
      <FeedbackWidget
        onSend={onSend}
        screenshotField={
          <label htmlFor="shot">
            Screenshot
            <input id="shot" type="file" />
          </label>
        }
        context={<span>Sent with your message: /northwind/projects</span>}
        thanks="Thanks. Reference FB-000007."
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByLabelText("Screenshot")).toBeTruthy();
    expect(screen.getByText("Sent with your message: /northwind/projects")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("What happened?"), "Bulk edit, please");
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await userEvent.click(send);
    expect(send.disabled).toBe(true);
    finish(true);
    expect((await screen.findByRole("status")).textContent).toContain("FB-000007");
    await expectAccessible(container);
  });

  it("keeps the text and says so when the send fails", async () => {
    const onSend = vi.fn(async () => false);
    render(<FeedbackWidget onSend={onSend} />);
    await userEvent.type(screen.getByLabelText("What happened?"), "Export failed");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your feedback did not send. Try again.",
    );
    expect((screen.getByLabelText("What happened?") as HTMLTextAreaElement).value).toBe(
      "Export failed",
    );
    const rejecting = vi.fn(() => Promise.reject(new Error("offline")));
    render(<FeedbackWidget onSend={rejecting} />);
  });
});
