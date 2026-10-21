/**
 * The Compass runtime: session, identity, project context, local store, outbox, sync engine and settings,
 * shared with every screen through context.
 */
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  OFFLINE,
  SyncEngine,
  SyncSession,
  type LocalStore,
  type MutationInput,
  type NetworkState,
  type Row,
  type SyncStatus,
} from "@xos/sync";
import type { ThemePreference } from "@xos/ui-native/theme";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { downloadAll, type DownloadReport } from "../data/downloader";
import { secondFactorGate, type ChallengeFactor, type SecondFactorGate } from "./assurance";
import { IdentityError, resolveIdentity, type ResolvedIdentity } from "../data/identity";
import { SupabaseUploader } from "../data/uploader";
import {
  COMPASS_SETTING_KEYS,
  NO_VALUES,
  valuesFromRows,
  type ResolvedValues,
} from "../domain/settings";
import { forgetGoogleAccount } from "./google";
import { fieldMediaUploader } from "./media";
import {
  createSupabase,
  deviceClock,
  deviceId,
  dismissStorageNotice as forgetStorageNotice,
  openStore,
  readConfig,
  storageNoticePending,
  watchNetwork,
  type CompassConfig,
} from "./platform";

export interface CompassSettings {
  readonly theme: ThemePreference;
  readonly haptics: boolean;
  readonly batterySaver: boolean;
  readonly lowData: boolean;
  /** Present while this device runs as a kiosk. Held in secure storage only. */
  readonly kioskDeviceKey: string | null;
  readonly biometric: boolean;
}

const DEFAULT_SETTINGS: CompassSettings = {
  theme: "system",
  haptics: true,
  batterySaver: false,
  lowData: false,
  kioskDeviceKey: null,
  biometric: false,
};
const SETTINGS_KEY = "xos.compass.settings";
/** The last resolved settings Compass applies, kept so the rules hold offline. */
const RESOLVED_KEY = "xos.compass.resolved";
/** resolve_settings needs an org; the nil uuid returns only the person's own values and the defaults. */
const NO_ORG = "00000000-0000-0000-0000-000000000000";
const PROJECT_KEY = "xos.compass.project";

export type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "second-factor"; readonly factors: readonly ChallengeFactor[] }
  | { readonly kind: "factor-required" }
  | { readonly kind: "identity-failed"; readonly step: string; readonly message: string }
  | { readonly kind: "ready" };

export interface CompassContextValue {
  readonly config: CompassConfig;
  readonly client: SupabaseClient;
  readonly phase: Phase;
  readonly resolved: ResolvedIdentity | null;
  readonly projectId: string | null;
  readonly setProjectId: (id: string) => void;
  readonly store: LocalStore | null;
  readonly engine: SyncEngine | null;
  readonly network: NetworkState;
  readonly status: SyncStatus | null;
  readonly settings: CompassSettings;
  readonly updateSettings: (patch: Partial<CompassSettings>) => void;
  /**
   * The registered settings for the person in their org and current project (Section 4.5.6): their own
   * accessibility settings and the org's clock, kiosk and claiming rules. Empty until the first download.
   */
  readonly orgSettings: ResolvedValues;
  /** Queues a write (optimistic locally) and drains when online. Returns the mutation id. */
  readonly enqueue: (input: MutationInput) => Promise<string>;
  readonly refresh: () => Promise<DownloadReport | null>;
  readonly refreshTables: (tables: readonly string[]) => Promise<void>;
  readonly lastRefresh: DownloadReport | null;
  readonly retryIdentity: () => void;
  readonly signOut: () => Promise<void>;
  /**
   * Why the local store or the sync engine could not start, or null. The root layout shows it with a
   * retry instead of a blank screen (A66).
   */
  readonly startupError: string | null;
  readonly retryStartup: () => void;
  /** The offline storage was replaced and unsent offline work could not be recovered; say so once. */
  readonly storageNotice: boolean;
  readonly dismissStorageNotice: () => void;
}

const CompassContext = createContext<CompassContextValue | null>(null);

export function useCompass(): CompassContextValue {
  const value = useContext(CompassContext);
  if (!value) throw new Error("useCompass needs CompassProvider");
  return value;
}

/** Rows of a local table, live: re-reads whenever the table changes. */
export function useRows<T extends Row = Row>(
  table: string,
  filter?: (row: T) => boolean,
): { rows: T[]; loading: boolean } {
  const { store } = useCompass();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    if (!store) return undefined;
    let live = true;
    const read = () =>
      void store.list(table).then((all) => {
        if (!live) return;
        const typed = all as T[];
        setRows(filterRef.current ? typed.filter(filterRef.current) : typed);
        setLoading(false);
      });
    read();
    const stop = store.subscribe((changed) => {
      if (changed === table) read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [store, table]);
  return { rows, loading };
}

export function CompassProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const config = useMemo(readConfig, []);
  const client = useMemo(() => createSupabase(config), [config]);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [session, setSession] = useState<Session | null>(null);
  const [resolved, setResolved] = useState<ResolvedIdentity | null>(null);
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [store, setStore] = useState<LocalStore | null>(null);
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [syncSession, setSyncSession] = useState<SyncSession | null>(null);
  const [network, setNetwork] = useState<NetworkState>(OFFLINE);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [settings, setSettings] = useState<CompassSettings>(DEFAULT_SETTINGS);
  const [resolvedSettings, setResolvedSettings] = useState<ResolvedValues>(NO_VALUES);
  const [lastRefresh, setLastRefresh] = useState<DownloadReport | null>(null);
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [storageNotice, setStorageNotice] = useState(false);
  const orgRef = useRef<string | null>(null);
  const storeRef = useRef<LocalStore | null>(null);

  // Settings and the remembered project per device (Section 4.5.7: Compass remembers the last context).
  useEffect(() => {
    void SecureStore.getItemAsync(SETTINGS_KEY).then((raw) => {
      if (raw)
        setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<CompassSettings>) });
    });
    void SecureStore.getItemAsync(PROJECT_KEY).then((id) => {
      if (id) setProjectIdState(id);
    });
    void SecureStore.getItemAsync(RESOLVED_KEY).then((raw) => {
      if (raw)
        setResolvedSettings(new Map(Object.entries(JSON.parse(raw) as Record<string, unknown>)));
    });
  }, []);

  const updateSettings = useCallback((patch: Partial<CompassSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      void SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    void SecureStore.setItemAsync(PROJECT_KEY, id);
  }, []);

  // Local store and sync engine. A store that will not open, even after recovery, shows as a startup
  // error with a retry (startupError), never as a blank screen.
  useEffect(() => {
    let stopped = false;
    setStartupError(null);
    void (async () => {
      const { store: opened, recovery } = await openStore();
      const id = await deviceId();
      if (stopped) return;
      if (recovery) {
        console.warn(
          `[compass] offline storage replaced: ${recovery.reason}; ${String(recovery.recovered)} unsent writes carried over${recovery.unreadable ? ", old file unreadable" : ""}`,
        );
      }
      setStorageNotice(await storageNoticePending());
      const uploader = new SupabaseUploader({
        client,
        functionsUrl: config.supabaseUrl,
        accessToken: async () =>
          (await client.auth.getSession()).data.session?.access_token ?? null,
        orgId: () => orgRef.current,
        deviceId: id,
        clock: deviceClock,
        uploadFile: fieldMediaUploader(client),
      });
      storeRef.current = opened;
      setStore(opened);
      setEngine(new SyncEngine({ store: opened, uploader }));
    })().catch((error: unknown) => {
      if (!stopped) setStartupError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      stopped = true;
    };
  }, [client, config, startupAttempt]);

  const retryStartup = useCallback(() => setStartupAttempt((n) => n + 1), []);
  const dismissStorageNotice = useCallback(() => {
    setStorageNotice(false);
    void forgetStorageNotice();
  }, []);

  useEffect(() => {
    if (!engine) return undefined;
    const stopStatus = engine.subscribe(setStatus);
    const stopNetwork = watchNetwork((next) => {
      setNetwork(next);
      void engine.setNetwork(next);
    });
    return () => {
      stopStatus();
      stopNetwork();
      engine.dispose();
    };
  }, [engine]);

  // Auth session.
  useEffect(() => {
    void client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setPhase({ kind: "signed-out" });
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        // Signed out here or remotely from Atlas (the refresh token was revoked): wipe the local store (Section 13).
        void storeRef.current?.wipe();
        setPhase({ kind: "signed-out" });
      } else if (engine) void engine.authRestored();
    });
    return () => data.subscription.unsubscribe();
  }, [client, engine]);

  // Identity and scope, after the second factor the session owes (A77): one the person holds, then the one
  // their org's security settings ask of their role.
  useEffect(() => {
    if (!session || !store) return;
    let live = true;
    /** True when the gate holds the device; the auth listener reopens it once the session changes. */
    const held = (gate: SecondFactorGate): boolean => {
      if (!live || gate.kind === "ok") return !live;
      if (gate.kind === "verify") setPhase({ kind: "second-factor", factors: gate.factors });
      else if (gate.kind === "enroll-elsewhere") setPhase({ kind: "factor-required" });
      else void client.auth.signOut({ scope: "local" });
      return true;
    };
    void secondFactorGate(client, null)
      .then(async (gate) => (held(gate) ? null : resolveIdentity(client, session.user.id)))
      .then(async (next) => {
        if (!live || next === null) return;
        const org = next.identity.membershipId ? next.orgId : null;
        if (held(await secondFactorGate(client, org))) return;
        orgRef.current = org;
        const sync = new SyncSession(store, next.scope);
        // A narrower scope than last time (an engagement completed) purges rows the device may no longer hold.
        await sync.narrow(next.scope);
        setSyncSession(sync);
        setResolved(next);
        setProjectIdState((current) =>
          current && next.projects.some((p) => p.id === current)
            ? current
            : (next.projects[0]?.id ?? null),
        );
        setPhase({ kind: "ready" });
      })
      .catch((error: unknown) => {
        if (!live) return;
        const step = error instanceof IdentityError ? error.step : "access";
        setPhase({
          kind: "identity-failed",
          step,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [client, session, store, identityAttempt]);

  const refresh = useCallback(async () => {
    if (!syncSession) return null;
    const report = await downloadAll({ client, session: syncSession, projectId: null });
    setLastRefresh(report);
    return report;
  }, [client, syncSession]);

  /** Pulls a few tables for the current project, for a live screen (the run of show). */
  const refreshTables = useCallback(
    async (tables: readonly string[]) => {
      if (!syncSession) return;
      await downloadAll({ client, session: syncSession, projectId, only: tables });
    },
    [client, syncSession, projectId],
  );

  useEffect(() => {
    if (phase.kind === "ready" && network.isConnected) void refresh();
  }, [phase.kind, network.isConnected, refresh]);

  // The person's settings and the org's rules for the current project, refreshed when online and kept for
  // offline use (A65-001).
  const orgId = resolved?.identity.membershipId ? resolved.orgId : null;
  useEffect(() => {
    if (phase.kind !== "ready" || !network.isConnected) return;
    let live = true;
    void client
      .rpc("resolve_settings", {
        p_org_id: orgId ?? NO_ORG,
        ...(projectId && orgId ? { p_project_id: projectId } : {}),
      })
      .then(({ data, error }) => {
        if (!live || error || !Array.isArray(data)) return;
        const values = valuesFromRows(
          (data as Parameters<typeof valuesFromRows>[0]).filter((r) =>
            COMPASS_SETTING_KEYS.includes(r.setting_key),
          ),
        );
        setResolvedSettings(values);
        void SecureStore.setItemAsync(RESOLVED_KEY, JSON.stringify(Object.fromEntries(values)));
      });
    return () => {
      live = false;
    };
  }, [client, phase.kind, network.isConnected, orgId, projectId]);

  const enqueue = useCallback(
    async (input: MutationInput) => {
      if (!engine) throw new Error("the local store is still opening");
      const mutation = await engine.outbox.enqueue(input);
      void engine.drain();
      return mutation.id;
    },
    [engine],
  );

  const signOut = useCallback(async () => {
    if (syncSession) await syncSession.remoteSignOut();
    else if (store) await store.wipe();
    await client.auth.signOut();
    setResolved(null);
    setSyncSession(null);
    await forgetGoogleAccount();
  }, [client, store, syncSession]);

  const value: CompassContextValue = {
    config,
    client,
    phase,
    resolved,
    projectId,
    setProjectId,
    store,
    engine,
    network,
    status,
    settings,
    updateSettings,
    orgSettings: resolvedSettings,
    enqueue,
    refresh,
    refreshTables,
    lastRefresh,
    retryIdentity: () => setIdentityAttempt((n) => n + 1),
    signOut,
    startupError,
    retryStartup,
    storageNotice,
    dismissStorageNotice,
  };
  return <CompassContext.Provider value={value}>{children}</CompassContext.Provider>;
}
