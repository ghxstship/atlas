/**
 * Device services: configuration, the Supabase client with secure session storage, the encrypted local
 * database, the device clock and the network feed. Everything a screen needs from the platform comes
 * through here, so the domain and data layers stay testable without a device.
 */
import { open } from "@op-engineering/op-sqlite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { uuidv7, type DeviceClock, type NetworkState } from "@xos/sync";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { openLocalStore, STORAGE_NOTICE, type OpenedStore } from "../data/localDatabase";

export interface CompassConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly gatewayUrl: string;
  readonly atlasUrl: string;
  /** The docs site origin, for the help center link; null hides the link. */
  readonly docsUrl: string | null;
}

/** Public build-time configuration (Expo inlines EXPO_PUBLIC_*); the anon key is public by design. */
export function readConfig(): CompassConfig {
  return {
    supabaseUrl: process.env["EXPO_PUBLIC_SUPABASE_URL"] ?? "http://127.0.0.1:56021",
    supabaseAnonKey: process.env["EXPO_PUBLIC_SUPABASE_ANON_KEY"] ?? "",
    gatewayUrl: process.env["EXPO_PUBLIC_GATEWAY_URL"] ?? "http://localhost:3001",
    atlasUrl: process.env["EXPO_PUBLIC_ATLAS_URL"] ?? "http://localhost:3000",
    docsUrl: process.env["EXPO_PUBLIC_DOCS_URL"] || null,
  };
}

/** Session tokens live in the Keychain or Keystore, never in plain storage (Section 13 device security). */
const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

/**
 * The client defaults to the app schema (ADR 0003); api_external and xpms reads switch with .schema().
 * Compass reads untyped rows into the local store, so the client is typed without the generated schema.
 */
export function createSupabase(config: CompassConfig): SupabaseClient {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    db: { schema: "app" },
    auth: {
      storage: secureStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client as unknown as SupabaseClient;
}

const DEVICE_ID = "xos.compass.device-id";

const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function secret(name: string, make: () => string): Promise<string> {
  const existing = await SecureStore.getItemAsync(name);
  if (existing) return existing;
  const value = make();
  await SecureStore.setItemAsync(name, value, keychain);
  return value;
}

/** A stable id for this install, recorded with each replayed mutation. */
export function deviceId(): Promise<string> {
  return secret(DEVICE_ID, () => uuidv7());
}

let opening: Promise<OpenedStore> | null = null;

/**
 * Opens the SQLCipher database with a random key held in the secure enclave store, recovering from a file
 * it cannot read (src/data/localDatabase.ts). One connection per launch: a second one (an effect rerun, or
 * React's development double invoke) would contend for the write lock and fail with "database is locked".
 */
export function openStore(): Promise<OpenedStore> {
  opening ??= openLocalStore({
    open: (name, key) => open({ name, ...(key ? { encryptionKey: key } : {}) }),
    getItem: (name) => SecureStore.getItemAsync(name),
    setItem: (name, value) => SecureStore.setItemAsync(name, value, keychain),
    newKey: () =>
      Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join(""),
    now: () => Date.now(),
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** Whether the person still has to be told that unsent offline work could not be recovered. */
export async function storageNoticePending(): Promise<boolean> {
  return (await SecureStore.getItemAsync(STORAGE_NOTICE)) === "1";
}

export async function dismissStorageNotice(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_NOTICE);
}

const BOOT = uuidv7();

/**
 * Wall time from Date, monotonic time from performance.now. The monotonic origin resets when the app
 * restarts, so the boot id is per launch: a punch queued before a restart uploads without an age and the
 * server applies its own skew window.
 */
export const deviceClock: DeviceClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  bootId: () => BOOT,
};

export function toNetworkState(state: Network.NetworkState): NetworkState {
  return {
    isConnected: state.isConnected === true,
    isInternetReachable: state.isInternetReachable ?? null,
    isAirplaneMode: false,
    isExpensive: state.type === Network.NetworkStateType.CELLULAR,
  };
}

/** Subscribes to connectivity changes, including airplane mode, which the OS reports as disconnected. */
export function watchNetwork(onChange: (state: NetworkState) => void): () => void {
  void Network.getNetworkStateAsync().then((s) => onChange(toNetworkState(s)));
  const subscription = Network.addNetworkStateListener((s) => onChange(toNetworkState(s)));
  return () => subscription.remove();
}
