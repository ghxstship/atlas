// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrationsSettings,
  type ConnectionView,
  type IntegrationAction,
  type IntegrationsCopy,
} from "../src/settings/index.ts";

afterEach(cleanup);

const copy = new Proxy({} as IntegrationsCopy, { get: (_t, key) => `copy:${String(key)}` });

async function expectAccessible(node: Element = document.body) {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
}

const connection = (overrides: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1",
  providerCode: "xero",
  providerLabel: "Xero",
  displayName: "Northwind Xero",
  state: "Pending",
  stateLabel: "Waiting to connect",
  lastSynced: null,
  lastError: null,
  needsCredential: true,
  credentialStored: false,
  scopes: [{ value: "Ledger Export", label: "Export posted journals" }],
  ...overrides,
});

const providers = [
  { code: "xero", label: "Xero", categoryLabel: "Accounting", available: true },
  { code: "gusto", label: "Gusto", categoryLabel: "Payroll", available: false },
];

function recorder(result: { ok?: boolean; error?: string } = { ok: true }) {
  const calls: Record<string, string>[] = [];
  const action: IntegrationAction = async (_state, form) => {
    calls.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
    return result;
  };
  return { action, calls };
}

function actions(
  overrides: Partial<
    Record<"create" | "credential" | "transition" | "sync", IntegrationAction>
  > = {},
) {
  const ok = recorder().action;
  return { create: ok, credential: ok, transition: ok, sync: ok, ...overrides };
}

describe("IntegrationsSettings", () => {
  it("shows the empty state, focuses the add form and lists only available providers", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[]}
        copy={copy}
        actions={actions()}
      />,
    );
    expect(screen.getByText("copy:empty")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "copy:emptyAction" }));
    expect(document.activeElement).toBe(screen.getByLabelText("copy:name"));
    const select = screen.getByLabelText("copy:provider") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["xero"]);
    expect(screen.getByText("copy:planGated Gusto.")).toBeTruthy();
    await expectAccessible();
  });

  it("submits a new connection and reports the outcome", async () => {
    const user = userEvent.setup();
    const create = recorder();
    render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[]}
        copy={copy}
        actions={actions({ create: create.action })}
      />,
    );
    await user.type(screen.getByLabelText("copy:name"), "Books");
    await user.click(screen.getByRole("button", { name: "copy:add" }));
    await waitFor(() => expect(screen.getByText("copy:added")).toBeTruthy());
    expect(create.calls[0]).toMatchObject({
      org: "northwind",
      provider: "xero",
      displayName: "Books",
    });
  });

  it("stores a credential, then offers connect, and shows a refusal as a sentence", async () => {
    const user = userEvent.setup();
    const credential = recorder();
    const transition = recorder({ error: "Store the service's credential before connecting." });
    const { rerender } = render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[connection()]}
        copy={copy}
        actions={actions({ credential: credential.action, transition: transition.action })}
      />,
    );
    expect(screen.queryByRole("button", { name: "copy:connect: Northwind Xero" })).toBeNull();
    await user.type(screen.getByLabelText("copy:secret"), "fixture-token");
    await user.click(screen.getByRole("button", { name: "copy:storeCredential" }));
    await waitFor(() => expect(screen.getByText("copy:saved")).toBeTruthy());
    expect(credential.calls[0]).toMatchObject({
      connectionId: "c1",
      secret: "fixture-token",
      kind: "OAuth Token",
    });
    rerender(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[connection({ credentialStored: true })]}
        copy={copy}
        actions={actions({ credential: credential.action, transition: transition.action })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "copy:connect: Northwind Xero" }));
    await waitFor(() =>
      expect(screen.getByText("Store the service's credential before connecting.")).toBeTruthy(),
    );
    expect(transition.calls[0]).toMatchObject({ expected: "Pending", next: "Connected" });
    await expectAccessible();
  });

  it("asks a UPS or FedEx connection for its app's client ID and secret instead of a token", async () => {
    const user = userEvent.setup();
    const credential = recorder();
    render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[
          connection({
            providerCode: "ups",
            providerLabel: "UPS",
            displayName: "Warehouse UPS",
            clientCredentialHelp: "Create an app at developer.ups.com.",
            scopes: [{ value: "Tracking Refresh", label: "Refresh tracking" }],
          }),
        ]}
        copy={copy}
        actions={actions({ credential: credential.action })}
      />,
    );
    expect(screen.queryByLabelText("copy:secret")).toBeNull();
    expect(screen.queryByLabelText("copy:kind")).toBeNull();
    const clientId = screen.getByLabelText("copy:clientId");
    expect(clientId.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Create an app at developer.ups.com.")).toBeTruthy();
    expect(screen.getByLabelText("copy:clientSecret").getAttribute("type")).toBe("password");
    await user.type(clientId, "ups-cid");
    await user.type(screen.getByLabelText("copy:clientSecret"), "ups-sec1");
    await user.click(screen.getByRole("button", { name: "copy:storeCredential" }));
    await waitFor(() => expect(screen.getByText("copy:saved")).toBeTruthy());
    expect(credential.calls[0]).toEqual({
      org: "northwind",
      connectionId: "c1",
      clientId: "ups-cid",
      clientSecret: "ups-sec1",
    });
    await expectAccessible();
  });

  it("offers pause, sync and disconnect on a connected integration", async () => {
    const user = userEvent.setup();
    const sync = recorder();
    const transition = recorder();
    render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[
          connection({
            state: "Connected",
            stateLabel: "Connected",
            credentialStored: true,
            lastSynced: "Jun 30, 2027, 12:00 PM",
          }),
        ]}
        copy={copy}
        actions={actions({ sync: sync.action, transition: transition.action })}
      />,
    );
    expect(screen.getByText("Jun 30, 2027, 12:00 PM")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "copy:syncNow: Northwind Xero" }));
    await waitFor(() => expect(screen.getByText("copy:queued")).toBeTruthy());
    expect(sync.calls[0]).toMatchObject({
      connectionId: "c1",
      provider: "xero",
      scope: "Ledger Export",
    });
    await user.click(screen.getByRole("button", { name: "copy:pause: Northwind Xero" }));
    await waitFor(() => expect(transition.calls).toHaveLength(1));
    expect(transition.calls[0]).toMatchObject({ next: "Paused" });
    await user.click(screen.getByRole("button", { name: "copy:disconnect: Northwind Xero" }));
    await waitFor(() => expect(transition.calls).toHaveLength(2));
    await expectAccessible();
  });

  it("offers resume and reconnect, hides disconnected rows and reads only without the capability", async () => {
    const { rerender } = render(
      <IntegrationsSettings
        org="northwind"
        canManage
        providers={providers}
        connections={[
          connection({
            id: "p",
            state: "Paused",
            stateLabel: "Paused",
            displayName: "Paused One",
            needsCredential: false,
          }),
          connection({
            id: "e",
            state: "Error",
            stateLabel: "Needs attention",
            displayName: "Broken One",
            lastError: "Xero refused the token.",
          }),
          connection({ id: "d", state: "Disconnected", displayName: "Old One" }),
        ]}
        copy={copy}
        actions={actions()}
      />,
    );
    expect(screen.getByRole("button", { name: "copy:resume: Paused One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "copy:reconnect: Broken One" })).toBeTruthy();
    expect(screen.getByText("Xero refused the token.")).toBeTruthy();
    expect(screen.queryByText("Old One")).toBeNull();
    rerender(
      <IntegrationsSettings
        org="northwind"
        canManage={false}
        providers={providers}
        connections={[connection({ state: "Connected" })]}
        copy={copy}
        actions={actions()}
      />,
    );
    expect(screen.getByText("copy:readOnly")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <IntegrationsSettings
        org="northwind"
        canManage={false}
        providers={providers}
        connections={[]}
        copy={copy}
        actions={actions()}
      />,
    );
    expect(screen.getByText("copy:empty")).toBeTruthy();
    await expectAccessible();
  });
});
