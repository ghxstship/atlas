/**
 * The launch check for the forced update screen (Section 5.1, journey 40). Reads the floor the server
 * advertises for this platform, keeps the last answer on the device so the check holds offline, and
 * re-checks on demand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { mustUpdate, parseCachedFloor, type MinimumVersion } from "../domain/version";

const CACHE_KEY = "xos.compass.minimum-version";

export interface UpdateGate {
  /** True while this build is below the advertised floor. */
  readonly blocked: boolean;
  readonly current: string;
  readonly floor: MinimumVersion | null;
  readonly recheck: () => Promise<void>;
}

export function useUpdateGate(client: SupabaseClient | null): UpdateGate {
  const current = Constants.expoConfig?.version ?? "";
  const [floor, setFloor] = useState<MinimumVersion | null>(null);
  const recheck = useCallback(async () => {
    const cached = parseCachedFloor(await SecureStore.getItemAsync(CACHE_KEY));
    if (cached) setFloor(cached);
    if (!client || (Platform.OS !== "ios" && Platform.OS !== "android")) return;
    const { data, error } = await client
      .schema("api_public")
      .rpc("client_minimum_version", { p_client: "compass", p_platform: Platform.OS });
    // Unreachable server: the cached floor (or none) stands; the next launch or re-check asks again.
    if (error) return;
    const row = (data as { minimum_version: string; update_url: string | null }[] | null)?.[0];
    const next: MinimumVersion | null = row
      ? { minimumVersion: row.minimum_version, updateUrl: row.update_url }
      : null;
    setFloor(next);
    if (next) await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(next));
    else await SecureStore.deleteItemAsync(CACHE_KEY);
  }, [client]);
  useEffect(() => {
    void recheck();
  }, [recheck]);
  return { blocked: mustUpdate(current, floor), current, floor, recheck };
}
