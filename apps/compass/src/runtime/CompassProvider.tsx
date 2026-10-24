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
import Constants from "expo-constants";
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
import {
  activateOrg,
  cachedContexts,
  IdentityError,
  isServerUnreachable,
  projectOrgs,
  replayOrgOf,
  resolveIdentity,
  type OrgContext,
  type ResolvedIdentity,
} from "../data/identity";
import { SupabaseUploader } from "../data/uploader";
import {
  brandFromRow,
  buildTenantOf,
  tenantOrgId,
  type BuildTenant,
  type OrgBrand,
} from "../domain/brand";
import { inOrg, personTimeZone } from "../domain/orgs";
import {
  enqueueApplying,
  resolveOverQueue,
  watchQueuedSettings,
  type QueuedOutbox,
} from "../domain/queuedSettings";
import {
  NO_VALUES,
  compassValuesFromRows,
  languageOf,
  type ResolvedValues,
} from "../domain/settings";
import { forgetGoogleAccount } from "./google";
import { clearGlance } from "./glance";
import { applyLanguage } from "./i18n";
import { persistQueuedMedia, resumableMediaUploader } from "./uploads";
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
/** The active org, remembered per device (Section 4.5.7 org switching). */
const ORG_KEY = "xos.compass.org";
/** The last project chosen in each org, as JSON { orgId: projectId }, so switching back returns to it. */
const ORG_PROJECTS_KEY = "xos.compass.org-projects";
/** Brands of the person's orgs, kept on the device so the brand applies offline (device-local table). */
export const BRANDS_TABLE = "_org_brands";
/** The person's org contexts as last resolved, so Compass opens offline after a restart (device-local). */
export const IDENTITY_TABLE = "_identity";
/** The outbox before the local store opens: nothing is queued. */
const NO_QUEUE: QueuedOutbox = { all: () => Promise.resolve([]) };

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
  /**
   * Makes another of the person's orgs active (Section 4.5.7 org switching): its identity, projects, brand
   * and settings drive every screen; the combined Today still lists every org.
   */
  readonly setOrgId: (orgId: string) => void;
  /** Brands of the person's orgs by org id (app.my_org_brands), kept for offline use. */
  readonly brands: ReadonlyMap<string, OrgBrand>;
  /** The person's own time zone, the calendar of items with no project (A71). */
  readonly personZone: string;
  /** An Enterprise branded build's own tenant (app.config.ts extra.tenant); null for the platform build. */
  readonly buildTenant: BuildTenant | null;
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

/**
 * Rows of a local table, live: re-reads whenever the table changes. Rows of the active org only (Section
 * 4.5.7): the device holds every org's rows, and a row of another org never shows on a screen that works in
 * one org. The combined Today passes `allOrgs` to read across them.
 */
export function useRows<T extends Row = Row>(
  table: string,
  filter?: (row: T) => boolean,
  options: { readonly allOrgs?: boolean } = {},
): { rows: T[]; loading: boolean } {
  const { store, resolved } = useCompass();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const activeOrg = options.allOrgs || !resolved ? null : resolved.orgId;
  const orgsOfProjects = useMemo(() => projectOrgs(resolved?.contexts ?? []), [resolved?.contexts]);
  useEffect(() => {
    if (!store) return undefined;
    let live = true;
    const read = () =>
      void store.list(table).then((all) => {
        if (!live) return;
        const typed = (all as T[]).filter((row) => inOrg(row, activeOrg, orgsOfProjects));
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
  }, [store, table, activeOrg, orgsOfProjects]);
  return { rows, loading };
}

/** Stored brand rows by org id. */
function brandMap(rows: readonly Row[]): ReadonlyMap<string, OrgBrand> {
  return new Map(
    rows.flatMap((row) => {
      const brand = brandFromRow({
        org_id: row["orgId"],
        org_slug: row["orgSlug"],
        name: row["name"],
        accent_hex: row["accentHex"],
        logo_light_path: row["logoLightPath"],
        logo_dark_path: row["logoDarkPath"],
      });
      return brand ? [[brand.orgId, brand] as const] : [];
    }),
  );
}

/** Forgets the brand of an org the person no longer works in. */
async function pruneBrands(store: LocalStore, contexts: readonly OrgContext[]): Promise<void> {
  const orgs = new Set(contexts.map((c) => c.orgId));
  await store.transaction((tx) => {
    for (const row of tx.list(BRANDS_TABLE)) if (!orgs.has(row.id)) tx.remove(BRANDS_TABLE, row.id);
  });
}

export function CompassProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const config = useMemo(readConfig, []);
  const client = useMemo(() => createSupabase(config), [config]);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [session, setSession] = useState<Session | null>(null);
  const [contexts, setContexts] = useState<readonly OrgContext[] | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [brands, setBrands] = useState<ReadonlyMap<string, OrgBrand>>(new Map());
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [store, setStore] = useState<LocalStore | null>(null);
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [syncSession, setSyncSession] = useState<SyncSession | null>(null);
  const [network, setNetwork] = useState<NetworkState>(OFFLINE);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [settings, setSettings] = useState<CompassSettings>(DEFAULT_SETTINGS);
  const [resolvedSettings, setResolvedSettings] = useState<ResolvedValues>(NO_VALUES);
  /** Bumped when one of the person's queued setting changes leaves the outbox, to resolve again. */
  const [settledSettings, setSettledSettings] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<DownloadReport | null>(null);
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [storageNotice, setStorageNotice] = useState(false);
  /** True while Compass runs on the identity cached at the last successful sign-in (no server). */
  const [offlineIdentity, setOfflineIdentity] = useState(false);
  const orgRef = useRef<string | null>(null);
  const storeRef = useRef<LocalStore | null>(null);
  const orgProjectsRef = useRef<Record<string, string>>({});
  /** Whether the person chose an org on this device; a branded build opens on its own org until they do. */
  const chosenOrgRef = useRef(false);
  const buildTenant = useMemo(() => buildTenantOf(Constants.expoConfig?.extra), []);

  // The active org's view of the person; every screen reads this one org.
  const resolved = useMemo(
    () => (contexts ? activateOrg(contexts, activeOrgId) : null),
    [contexts, activeOrgId],
  );
  // The org a write queued now replays in (app.apply_sync_mutation); null for an external context.
  orgRef.current = replayOrgOf(resolved);

  // Settings, the remembered org and project per device (Section 4.5.7: Compass remembers the last context).
  useEffect(() => {
    void SecureStore.getItemAsync(SETTINGS_KEY).then((raw) => {
      if (raw)
        setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<CompassSettings>) });
    });
    void SecureStore.getItemAsync(PROJECT_KEY).then((id) => {
      if (id) setProjectIdState(id);
    });
    void SecureStore.getItemAsync(ORG_KEY).then((id) => {
      chosenOrgRef.current = id !== null;
      if (id) setActiveOrgId((current) => current ?? id);
    });
    void SecureStore.getItemAsync(ORG_PROJECTS_KEY).then((raw) => {
      if (raw) orgProjectsRef.current = JSON.parse(raw) as Record<string, string>;
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

  const setProjectId = useCallback(
    (id: string) => {
      setProjectIdState(id);
      void SecureStore.setItemAsync(PROJECT_KEY, id);
      const org = projectOrgs(contexts ?? []).get(id);
      if (org) {
        orgProjectsRef.current = { ...orgProjectsRef.current, [org]: id };
        void SecureStore.setItemAsync(ORG_PROJECTS_KEY, JSON.stringify(orgProjectsRef.current));
      }
    },
    [contexts],
  );

  /**
   * Holds the device for the second factor a gate asks (A77). True when it holds; the auth listener reopens
   * Compass once the session changes.
   */
  const holdFor = useCallback(
    (gate: SecondFactorGate): boolean => {
      if (gate.kind === "ok") return false;
      if (gate.kind === "verify") setPhase({ kind: "second-factor", factors: gate.factors });
      else if (gate.kind === "enroll-elsewhere") setPhase({ kind: "factor-required" });
      else void client.auth.signOut({ scope: "local" });
      return true;
    },
    [client],
  );

  const setOrgId = useCallback(
    (orgId: string) => {
      const context = contexts?.find((c) => c.orgId === orgId);
      if (!context) return;
      setActiveOrgId(orgId);
      chosenOrgRef.current = true;
      void SecureStore.setItemAsync(ORG_KEY, orgId);
      // Back to the project last used in that org, else its first.
      const remembered = orgProjectsRef.current[orgId];
      const next = context.projects.some((p) => p.id === remembered)
        ? (remembered ?? null)
        : (context.projects[0]?.id ?? null);
      setProjectIdState(next);
      if (next) void SecureStore.setItemAsync(PROJECT_KEY, next);
      // Each org's security settings apply when it becomes active (A77): its second factor or session rule.
      if (context.kind === "member")
        void secondFactorGate(client, orgId)
          .then(holdFor)
          .catch(() => undefined);
    },
    [client, contexts, holdFor],
  );

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
        // Photos, voice notes and documents upload resumably (TUS) and survive restarts (A65-011).
        uploadFile: resumableMediaUploader(client, {
          supabaseUrl: config.supabaseUrl,
          anonKey: config.supabaseAnonKey,
          store: opened,
        }),
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
        clearGlance();
        // The resolved values are the person's own (me.haptics, their language) and their org's rules: the next
        // person to sign in on this device starts from the defaults, never from them.
        setResolvedSettings(NO_VALUES);
        void SecureStore.deleteItemAsync(RESOLVED_KEY);
        setPhase({ kind: "signed-out" });
      } else if (engine) void engine.authRestored();
    });
    return () => data.subscription.unsubscribe();
  }, [client, engine]);

  // Identity and scope, after the second factor the session owes (A77): one the person holds, then the one
  // their active org's security settings ask of their role; in every org the person works in (Section 4.5.7).
  useEffect(() => {
    if (!session || !store) return;
    let live = true;
    /** True when the gate holds the device; the auth listener reopens it once the session changes. */
    const held = (gate: SecondFactorGate): boolean => (live ? holdFor(gate) : true);
    let storedOrg: string | null = null;
    /** Opens Compass on a resolved person: every org's scope on the device, the active org on screen. */
    const open = async (next: ResolvedIdentity, narrow: boolean) => {
      const scopes = next.contexts.map((c) => c.scope);
      const sync = new SyncSession(store, scopes);
      // A narrower scope than last time (an engagement completed, a membership in one org ended) purges
      // the rows the device may no longer hold, org by org. Never from a cached identity.
      if (narrow) {
        await sync.narrow(scopes);
        await pruneBrands(store, next.contexts);
      }
      if (!live) return;
      setSyncSession(sync);
      setContexts(next.contexts);
      setActiveOrgId(next.orgId);
      setProjectIdState((current) => {
        if (current && next.projects.some((p) => p.id === current)) return current;
        const remembered = next.orgId ? orgProjectsRef.current[next.orgId] : undefined;
        return next.projects.some((p) => p.id === remembered)
          ? (remembered ?? null)
          : (next.projects[0]?.id ?? null);
      });
      setPhase({ kind: "ready" });
    };
    void secondFactorGate(client, null)
      .then(async (gate) => {
        if (held(gate)) return null;
        storedOrg = await SecureStore.getItemAsync(ORG_KEY).catch(() => null);
        if (storedOrg) chosenOrgRef.current = true;
        return resolveIdentity(client, session.user.id, storedOrg);
      })
      .then(async (next) => {
        if (!live || next === null) return;
        const org = next.identity.membershipId ? next.orgId : null;
        if (held(await secondFactorGate(client, org))) return;
        // Kept in the encrypted store, so Compass opens offline after a restart (wiped at sign-out).
        await store.transaction((tx) => {
          tx.put(IDENTITY_TABLE, { id: session.user.id, contexts: next.contexts });
        });
        setOfflineIdentity(false);
        await open(next, true);
      })
      .catch(async (error: unknown) => {
        if (!live) return;
        const message = error instanceof Error ? error.message : String(error);
        // No server (offline, or the server is away): open on the identity resolved last time, and resolve
        // again once the server answers. A refusal from the server still shows the error.
        const cached = isServerUnreachable(message)
          ? cachedContexts(await store.get(IDENTITY_TABLE, session.user.id))
          : null;
        if (live && cached) {
          setOfflineIdentity(true);
          await open(activateOrg(cached, storedOrg), false);
          return;
        }
        const step = error instanceof IdentityError ? error.step : "access";
        setPhase({ kind: "identity-failed", step, message });
      });
    return () => {
      live = false;
    };
  }, [client, session, store, identityAttempt, holdFor]);

  // Opened on a cached identity: resolve again every half minute until the server answers.
  useEffect(() => {
    if (!offlineIdentity || !network.isConnected) return undefined;
    const timer = setTimeout(() => setIdentityAttempt((n) => n + 1), 30_000);
    return () => clearTimeout(timer);
  }, [offlineIdentity, network.isConnected, identityAttempt]);

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

  // Brands of the person's orgs (Section 12 Mobile): from the device first, so the brand shows offline,
  // then from app.my_org_brands whenever online. A failed lookup keeps what the device has; no brand
  // means the platform brand.
  useEffect(() => {
    if (!store) return;
    void store.list(BRANDS_TABLE).then((rows) => setBrands(brandMap(rows)));
  }, [store]);
  // An Enterprise branded build opens on its own org until the person picks another (Section 12 Mobile).
  useEffect(() => {
    if (chosenOrgRef.current || !contexts) return;
    const orgId = tenantOrgId(
      brands,
      buildTenant,
      contexts.map((c) => c.orgId),
    );
    if (orgId && orgId !== activeOrgId) setActiveOrgId(orgId);
  }, [brands, buildTenant, contexts, activeOrgId]);
  useEffect(() => {
    if (phase.kind !== "ready" || !network.isConnected || !store) return;
    let live = true;
    void client.rpc("my_org_brands").then(async ({ data, error }) => {
      if (!live || error || !Array.isArray(data)) return;
      const rows = (data as Record<string, unknown>[]).flatMap((r) => {
        const brand = brandFromRow(r);
        return brand ? [{ ...brand, id: brand.orgId }] : [];
      });
      await store.transaction((tx) => {
        for (const old of tx.list(BRANDS_TABLE)) tx.remove(BRANDS_TABLE, old.id);
        for (const row of rows) tx.put(BRANDS_TABLE, row);
      });
      if (live) setBrands(brandMap(rows));
    });
    return () => {
      live = false;
    };
  }, [client, phase.kind, network.isConnected, store]);

  // The person's settings and the org's rules for the current project, refreshed when online and kept for
  // offline use (A65-001). The person's own changes still in the outbox stay laid over every answer, and once
  // one leaves the outbox (sent, refused or discarded) the settings resolve again.
  const orgId = resolved?.identity.membershipId ? resolved.orgId : null;
  useEffect(() => {
    if (!engine || !store) return undefined;
    return watchQueuedSettings(store, engine.outbox, () => setSettledSettings((n) => n + 1));
  }, [engine, store]);

  useEffect(() => {
    if (phase.kind !== "ready" || !network.isConnected) return;
    let live = true;
    void resolveOverQueue(engine?.outbox ?? NO_QUEUE, async () => {
      const { data, error } = await client.rpc("resolve_settings", {
        p_org_id: orgId ?? NO_ORG,
        ...(projectId && orgId ? { p_project_id: projectId } : {}),
      });
      if (error || !Array.isArray(data)) return null;
      return compassValuesFromRows(data as Parameters<typeof compassValuesFromRows>[0]);
    })
      .then((values) => {
        if (!live || values === null) return;
        setResolvedSettings(values);
        void SecureStore.setItemAsync(RESOLVED_KEY, JSON.stringify(Object.fromEntries(values)));
      })
      // A resolve that fails keeps the last values; the next network, project or settled change tries again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, engine, phase.kind, network.isConnected, orgId, projectId, settledSettings]);

  // Compass speaks the language the person or their org chose (locale.language), else the device's (A65-001).
  useEffect(() => {
    void applyLanguage(languageOf(resolvedSettings));
  }, [resolvedSettings]);

  /**
   * Queues a write in the org that is active now: `device_org_id` names the member org whose replay
   * ledger runs it, or null for an external context, so switching orgs before the queue drains never
   * moves a write into another org (SupabaseUploader replayOrg).
   */
  const enqueue = useCallback(
    async (input: MutationInput) => {
      if (!engine) throw new Error("the local store is still opening");
      // Files the write uploads move out of the caches first, so a restart never loses them. A personal
      // setting changed here applies now, in the same render as the screen's own change and before the outbox
      // write (me.haptics, A65-001), and is kept for offline use.
      const durable = persistQueuedMedia(input);
      const mutation = await enqueueApplying(
        engine.outbox,
        { ...durable, payload: { ...durable.payload, device_org_id: orgRef.current } },
        (update) =>
          setResolvedSettings((current) => {
            const next = update(current);
            if (next !== current) {
              void SecureStore.setItemAsync(RESOLVED_KEY, JSON.stringify(Object.fromEntries(next)));
            }
            return next;
          }),
      );
      void engine.drain();
      return mutation.id;
    },
    [engine],
  );

  const signOut = useCallback(async () => {
    if (syncSession) await syncSession.remoteSignOut();
    else if (store) await store.wipe();
    await client.auth.signOut();
    setContexts(null);
    setBrands(new Map());
    setSyncSession(null);
    clearGlance();
    await forgetGoogleAccount();
  }, [client, store, syncSession]);

  const personZone = personTimeZone(
    resolvedSettings.get("locale.time_zone"),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  const value: CompassContextValue = {
    config,
    client,
    phase,
    resolved,
    setOrgId,
    brands,
    personZone,
    buildTenant,
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
