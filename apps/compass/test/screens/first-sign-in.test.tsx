import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalNeeds } from "../../src/domain/legalGate";

/**
 * The screens every Compass sign-in passes before anything else (ADR 0156), answered as a person answers them: the real
 * LegalGate and AiDisclosure with the real domain rules and the real @xos/data calls, over a fake database. Only the native
 * primitives and the provider around them are stand-ins, so this proves what each answer sends and shows. It does not
 * prove native rendering, navigation or Apple's sheet: first-sign-in-acceptance.yaml and first-sign-in-under-18.yaml run
 * on a simulator for that, which is a release condition.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  retryIdentity: vi.fn(),
  signOut: vi.fn(),
  wipe: vi.fn(),
  localSignOut: vi.fn(),
  chooseAi: vi.fn(),
  revoke: vi.fn(),
  openURL: vi.fn(),
  queued: 0,
  aiChoice: "unknown" as string,
}));

vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("expo-linking", () => ({ openURL: h.openURL }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("../../src/ui", () => ({
  Screen: ({ children, testID, title }: { children: ReactNode; testID: string; title: string }) => (
    <main data-testid={testID}>
      <h1>{title}</h1>
      {children}
    </main>
  ),
  Card: ({ children, testID, title }: { children: ReactNode; testID?: string; title?: string }) => (
    <section data-testid={testID}>
      {title}
      {children}
    </section>
  ),
  Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  InlineAlert: ({ testID, message }: { testID: string; message: string }) => (
    <div role="alert" data-testid={testID}>
      {message}
    </div>
  ),
  Button: (props: { testID: string; label: string; disabled?: boolean; onPress: () => void }) => (
    <button data-testid={props.testID} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  Switch: (props: { testID: string; label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <label>
      {props.label}
      <input
        data-testid={props.testID}
        type="checkbox"
        checked={props.value}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </label>
  ),
  useTheme: () => ({ space: { "8": 8, "12": 12 } }),
}));
vi.mock("../../src/runtime/CompassProvider", () => ({
  useCompass: () => ({
    client: {
      rpc: h.rpc,
      auth: { signOut: h.localSignOut, getUser: vi.fn(async () => ({ data: { user: null } })) },
    },
    config: { atlasUrl: "https://atlas.test", supabaseUrl: "https://db.test" },
    signOut: h.signOut,
    store: { wipe: h.wipe },
    retryIdentity: h.retryIdentity,
    aiChoice: h.aiChoice,
    chooseAi: h.chooseAi,
  }),
}));
vi.mock("../../src/runtime/legalGate", () => ({ queuedChanges: async () => h.queued }));
vi.mock("../../src/runtime/google", () => ({ forgetGoogleAccount: async () => undefined }));
vi.mock("../../src/runtime/apple", () => ({
  accountSignsInWithApple: async () => true,
  appleAvailable: async () => true,
  appleRevoker: () => h.revoke,
  loadAppleNative: async () => ({
    signInAsync: async () => ({ authorizationCode: "code" }),
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  }),
}));
vi.mock("../../src/domain/appleSignIn", () => ({
  revokeAppleBeforeDeletion: async (input: { revoke: (code: string) => Promise<void> }) => {
    await input.revoke("code");
  },
}));

const { LegalGate } = await import("../../src/screens/LegalGate");
const { AiDisclosure } = await import("../../src/screens/AiDisclosure");

const ok = (data: unknown) => Promise.resolve({ data, error: null });
const failed = () => Promise.resolve({ data: null, error: { code: "08006", message: "offline" } });

/** Answers each RPC by name; `refusal` is what closing the account answers. */
function database(answers: Record<string, () => Promise<unknown>> = {}) {
  h.rpc.mockImplementation((name: string) => {
    const answer = answers[name];
    if (answer) return answer();
    switch (name) {
      case "confirm_minimum_age":
        return ok("2026-11-06T10:00:00Z");
      case "record_legal_acceptances":
        return ok(2);
      case "my_legal_standing":
        return ok({ closing_blocked: false });
      case "refuse_minimum_age":
        return ok({ outcome: "Account Removed" });
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
}
const called = (name: string) => h.rpc.mock.calls.filter((c) => c[0] === name);

const firstSignIn: LegalNeeds = {
  age: true,
  documents: [
    { slug: "mobile-eula", version: "1.0.0-draft" },
    { slug: "worker-terms", version: "1.0.0-draft" },
  ],
  changes: [],
};

const press = async (testID: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testID));
  });
};

beforeEach(() => {
  h.queued = 0;
  h.aiChoice = "unknown";
  h.chooseAi.mockResolvedValue(true);
  h.localSignOut.mockResolvedValue({ error: null });
  h.revoke.mockResolvedValue(undefined);
  database();
});

describe("first sign-in: the age", () => {
  it("offers both answers with equal weight and states no rule first", async () => {
    render(<LegalGate needs={firstSignIn} />);
    expect(screen.getByTestId("legal-gate-age")).toBeTruthy();
    expect(screen.getByTestId("legal-gate-age-over").textContent).toBe("compass.legalGate.age.over");
    expect(screen.getByTestId("legal-gate-age-under").textContent).toBe("compass.legalGate.age.under");
    expect(screen.queryByText(/compass.legalGate.under.title/)).toBeNull();
  });

  it("records 18 or older, then asks for the documents, and opens only when the server has both", async () => {
    render(<LegalGate needs={firstSignIn} />);
    await press("legal-gate-age-over");
    expect(called("confirm_minimum_age")[0]?.[1]).toEqual({ p_surface: "Compass" });
    expect(screen.getByTestId("legal-gate-documents")).toBeTruthy();
    expect(h.retryIdentity).not.toHaveBeenCalled();
    expect((screen.getByTestId("legal-gate-accept") as HTMLButtonElement).disabled).toBe(true);
    await press("legal-gate-agree");
    await press("legal-gate-accept");
    expect(called("record_legal_acceptances")[0]?.[1]).toEqual({
      p_org_id: null,
      p_document_slugs: ["mobile-eula", "worker-terms"],
      p_document_versions: ["1.0.0-draft", "1.0.0-draft"],
    });
    expect(h.retryIdentity).toHaveBeenCalledTimes(1);
  });

  it("says it needs a connection when the answer could not be recorded, and stays", async () => {
    database({ confirm_minimum_age: failed });
    render(<LegalGate needs={firstSignIn} />);
    await press("legal-gate-age-over");
    expect(screen.getByTestId("legal-gate-failed")).toBeTruthy();
    expect(screen.getByTestId("legal-gate-age")).toBeTruthy();
    expect(h.retryIdentity).not.toHaveBeenCalled();
  });

  it("declining the documents leaves only reviewing again or signing out", async () => {
    render(<LegalGate needs={{ ...firstSignIn, age: false }} />);
    await press("legal-gate-decline");
    expect(screen.getByTestId("legal-gate-declined")).toBeTruthy();
    await press("legal-gate-sign-out");
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(called("record_legal_acceptances")).toEqual([]);
  });

  it("warns before a sign-out deletes hours still on the device", async () => {
    h.queued = 3;
    render(<LegalGate needs={{ ...firstSignIn, age: false }} />);
    await press("legal-gate-decline");
    expect(screen.getByTestId("legal-gate-declined-queued").textContent).toContain('"count":3');
  });
});

describe("first sign-in: an answer of under 18", () => {
  const answerUnder = async () => {
    render(<LegalGate needs={firstSignIn} />);
    await press("legal-gate-age-under");
    expect(screen.getByTestId("legal-gate-under")).toBeTruthy();
    expect(called("refuse_minimum_age")).toEqual([]);
  };

  it("closes nothing until the person confirms, and lets them go back", async () => {
    await answerUnder();
    await press("legal-gate-under-back");
    expect(screen.getByTestId("legal-gate-age")).toBeTruthy();
    expect(called("refuse_minimum_age")).toEqual([]);
  });

  it("closes the sign-in once confirmed, and forgets it on this device only", async () => {
    await answerUnder();
    await press("legal-gate-under-confirm");
    expect(called("refuse_minimum_age")[0]?.[1]).toEqual({ p_surface: "Compass" });
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("legal-gate-refused")).toBeTruthy();
    await press("legal-gate-leave");
    expect(h.wipe).toHaveBeenCalledTimes(1);
    expect(h.localSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("warns before closing deletes hours still on the device", async () => {
    h.queued = 2;
    await answerUnder();
    expect(screen.getByTestId("legal-gate-under-queued").textContent).toContain('"count":2');
  });

  it("says why an account cannot close, sends the person to us, and ends every session", async () => {
    database({
      my_legal_standing: () => ok({ closing_blocked: true }),
      refuse_minimum_age: () =>
        ok({ outcome: "Account Held", reason: "account_delete_on_shift", org_name: "Northwind" }),
    });
    await answerUnder();
    await press("legal-gate-under-confirm");
    expect(screen.getByTestId("legal-gate-held")).toBeTruthy();
    expect(screen.getByText(/compass.legalGate.held.onShift/).textContent).toContain("Northwind");
    await press("legal-gate-contact");
    expect(h.openURL).toHaveBeenCalledWith("https://atlas.test/legal/contact");
    await press("legal-gate-leave");
    expect(h.localSignOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("revokes no Apple grant for an account that would not close", async () => {
    database({
      my_legal_standing: () => ok({ closing_blocked: true }),
      refuse_minimum_age: () =>
        ok({ outcome: "Account Held", reason: "account_delete_sole_owner", org_name: "Northwind" }),
    });
    await answerUnder();
    await press("legal-gate-under-confirm");
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it("revokes nothing and closes nothing when the server cannot be reached", async () => {
    database({ my_legal_standing: failed });
    await answerUnder();
    await press("legal-gate-under-confirm");
    expect(h.revoke).not.toHaveBeenCalled();
    expect(called("refuse_minimum_age")).toEqual([]);
    expect(screen.getByTestId("legal-gate-failed")).toBeTruthy();
    expect(screen.getByTestId("legal-gate-under")).toBeTruthy();
  });
});

describe("a change to a document", () => {
  const change = {
    documentSlug: "mobile-eula",
    documentVersion: "1.1.0",
    summary: "What changes",
    noticedAt: "2026-10-01T00:00:00Z",
    effectiveOn: "2026-12-01",
    required: false,
  };

  it("records the announced version when reviewed during its notice period", async () => {
    render(<LegalGate needs={{ age: false, documents: [], changes: [change] }} onLater={vi.fn()} />);
    expect(screen.getByTestId("legal-gate-change-mobile-eula")).toBeTruthy();
    await press("legal-gate-agree");
    await press("legal-gate-accept");
    expect(called("record_legal_acceptances")[0]?.[1]).toEqual({
      p_org_id: null,
      p_document_slugs: ["mobile-eula"],
      p_document_versions: ["1.1.0"],
    });
  });

  it("can be put off during its notice period", async () => {
    const later = vi.fn();
    render(<LegalGate needs={{ age: false, documents: [], changes: [change] }} onLater={later} />);
    await press("legal-gate-decline");
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("the first-use AI disclosure", () => {
  it("records what the person chose, and says so when it could not", async () => {
    render(<AiDisclosure />);
    await press("ai-disclosure-decline");
    expect(h.chooseAi).toHaveBeenCalledWith("Declined");
    h.chooseAi.mockResolvedValueOnce(false);
    await press("ai-disclosure-allow");
    expect(h.chooseAi).toHaveBeenCalledWith("Allowed");
    expect(screen.getByTestId("ai-disclosure-failed")).toBeTruthy();
  });

  it("offers only turning back on to someone who declined", () => {
    h.aiChoice = "Declined";
    render(<AiDisclosure />);
    expect(screen.queryByTestId("ai-disclosure-decline")).toBeNull();
    expect(screen.getByTestId("ai-disclosure-allow")).toBeTruthy();
  });
});
