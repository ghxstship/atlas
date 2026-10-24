/**
 * The NFC radio behind the Scan tab (A92, react-native-nfc-manager). Every build reads and writes tags
 * through the phone's radio, except a Maestro test build made with EXPO_PUBLIC_XOS_FAKE_NFC=1: a
 * simulator has no NFC radio, so the fake opens an on-screen test tag (src/screens/FakeNfcSheet.tsx)
 * where the flow types what the tag holds and holds it to the phone. app.config.ts refuses the flag in
 * an EAS build, and the screens are the same either way: only the reader below changes, chosen once
 * when the bundle loads, as the voice recorder does (src/runtime/voiceRecorder.ts).
 */
import type * as NfcManagerModule from "react-native-nfc-manager";
import { decodeMessage, type NfcTagData } from "../domain/nfc";
import { ndefText } from "../domain/scan";

/** ready: tap to read; off: the radio is turned off (Android); unsupported: no radio (iPad). */
export type NfcAvailability = "ready" | "off" | "unsupported";

export interface NfcReader {
  /** True in a Maestro test build: the test tag stands in for the radio. */
  readonly fake: boolean;
  availability(): Promise<NfcAvailability>;
  /** Reads the next tag held to the phone; null when the person cancels. */
  read(alert: string): Promise<NfcTagData | null>;
  /** Writes an NDEF message to the next tag held to the phone; false when the person cancels. */
  write(message: readonly number[], alert: string): Promise<boolean>;
}

/** Whether this bundle was built as a Maestro test build with the fake NFC reader. */
export function fakeNfcRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["EXPO_PUBLIC_XOS_FAKE_NFC"] === "1";
}

// The test tag ------------------------------------------------------------------------------------------

/** What the test tag sheet shows: a read or a write waiting for a tag, or nothing. */
export type FakeNfcPending =
  | { readonly kind: "read"; readonly alert: string }
  | { readonly kind: "write"; readonly alert: string; readonly text: string | null }
  | null;

/** Prefix that makes the test tag a bare chip with that serial number instead of a text record. */
export const FAKE_SERIAL_PREFIX = "serial:";

/**
 * A reader with no radio. A read or write waits until the test tag sheet presents a tag or cancels;
 * the sheet subscribes to `pending`. The last message written stays readable for the flow.
 */
export class FakeNfcReader implements NfcReader {
  readonly fake = true;
  #pending: FakeNfcPending = null;
  #settle: ((value: NfcTagData | boolean | null) => void) | null = null;
  #lastWritten: string | null = null;
  readonly #listeners = new Set<() => void>();

  availability(): Promise<NfcAvailability> {
    return Promise.resolve("ready");
  }

  read(alert: string): Promise<NfcTagData | null> {
    return this.#wait({ kind: "read", alert }) as Promise<NfcTagData | null>;
  }

  async write(message: readonly number[], alert: string): Promise<boolean> {
    const record = decodeMessage(message)[0];
    const text = record ? ndefText(record.payload) : null;
    const done = (await this.#wait({ kind: "write", alert, text })) === true;
    if (done) {
      this.#lastWritten = text;
      this.#emit();
    }
    return done;
  }

  /** Holds the test tag to the phone: for a read, a tag carrying `content`; for a write, a blank tag. */
  present(content: string): void {
    const pending = this.#pending;
    if (!pending) return;
    if (pending.kind === "write") {
      this.#finish(true);
      return;
    }
    const value = content.trim();
    if (value.startsWith(FAKE_SERIAL_PREFIX)) {
      this.#finish({ id: value.slice(FAKE_SERIAL_PREFIX.length).trim(), ndefMessage: null });
      return;
    }
    const message = value === "" ? null : decodeMessage(textMessage(value));
    this.#finish({ id: null, ndefMessage: message });
  }

  /** Dismisses the sheet, as a person cancels the system NFC sheet. */
  cancel(): void {
    if (!this.#pending) return;
    this.#finish(this.#pending.kind === "write" ? false : null);
  }

  get pending(): FakeNfcPending {
    return this.#pending;
  }

  get lastWritten(): string | null {
    return this.#lastWritten;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): FakeNfcPending => this.#pending;

  #wait(pending: NonNullable<FakeNfcPending>): Promise<NfcTagData | boolean | null> {
    // A second request replaces the first, as a new system NFC session ends the old one.
    this.cancel();
    this.#pending = pending;
    this.#emit();
    return new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  #finish(value: NfcTagData | boolean | null): void {
    const settle = this.#settle;
    this.#pending = null;
    this.#settle = null;
    this.#emit();
    settle?.(value);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A text record message, encoded without the length limit Compass applies to its own writes. */
function textMessage(text: string): number[] {
  const body = [...new TextEncoder().encode(text)];
  const payload = [2, 0x65, 0x6e, ...body];
  return payload.length < 256
    ? [0xd1, 1, payload.length, 0x54, ...payload]
    : [
        0xc1,
        1,
        (payload.length >>> 24) & 0xff,
        (payload.length >>> 16) & 0xff,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
        0x54,
        ...payload,
      ];
}

// The radio ---------------------------------------------------------------------------------------------

type NfcModule = typeof NfcManagerModule;

function isCancel(lib: NfcModule, error: unknown): boolean {
  return (
    error instanceof lib.NfcError.UserCancel ||
    error instanceof lib.NfcError.Timeout ||
    error instanceof lib.NfcError.SessionInvalidated
  );
}

/**
 * The phone's radio. The module is loaded on first use, so a test build (and the unit tests) never
 * loads a native module it does not have.
 */
export function deviceNfcReader(
  load: () => Promise<NfcModule> = () => import("react-native-nfc-manager"),
): NfcReader {
  let started: Promise<void> | null = null;
  const start = (lib: NfcModule): Promise<void> =>
    (started ??= lib.default.start().catch((error: unknown) => {
      started = null;
      throw error;
    }));
  const session = async <T>(alert: string, work: (lib: NfcModule) => Promise<T>, cancelled: T) => {
    const lib = await load();
    await start(lib);
    try {
      await lib.default.requestTechnology(lib.NfcTech.Ndef, { alertMessage: alert });
      return await work(lib);
    } catch (error) {
      if (isCancel(lib, error)) return cancelled;
      throw error;
    } finally {
      await lib.default.cancelTechnologyRequest().catch(() => undefined);
    }
  };
  return {
    fake: false,
    async availability() {
      try {
        const lib = await load();
        if (!(await lib.default.isSupported())) return "unsupported";
        await start(lib);
        return (await lib.default.isEnabled()) ? "ready" : "off";
      } catch {
        return "unsupported";
      }
    },
    read: (alert) =>
      session<NfcTagData | null>(
        alert,
        async (lib) => {
          const tag = await lib.default.getTag();
          return tag ? { id: tag.id ?? null, ndefMessage: tag.ndefMessage ?? null } : null;
        },
        null,
      ),
    write: (message, alert) =>
      session(
        alert,
        async (lib) => {
          await lib.default.ndefHandler.writeNdefMessage([...message]);
          return true;
        },
        false,
      ),
  };
}

const fake = fakeNfcRequested({
  EXPO_PUBLIC_XOS_FAKE_NFC: process.env["EXPO_PUBLIC_XOS_FAKE_NFC"],
});

/** The test tag of a Maestro build, or null in every other build. */
export const fakeNfc: FakeNfcReader | null = fake ? new FakeNfcReader() : null;

/** The NFC reader this bundle uses. Read as process.env.EXPO_PUBLIC_..., which Expo inlines at build. */
export const nfc: NfcReader = fakeNfc ?? deviceNfcReader();
