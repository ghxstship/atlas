/**
 * Location on the battery budget (Section 13). Sampling follows samplingPlan: off away from shifts, coarse
 * and infrequent on shift, precise only while the person is about to punch.
 */
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import type { LocationFix, SamplingPlan } from "../domain/geo";

export type LocationPermission = "unknown" | "granted" | "denied";

const ACCURACY: Readonly<Record<Exclude<SamplingPlan["accuracy"], "off">, Location.Accuracy>> = {
  high: Location.Accuracy.BestForNavigation,
  balanced: Location.Accuracy.Balanced,
  low: Location.Accuracy.Low,
};

function toFix(position: Location.LocationObject): LocationFix {
  return {
    longitude: position.coords.longitude,
    latitude: position.coords.latitude,
    accuracyM: position.coords.accuracy ?? Number.POSITIVE_INFINITY,
    at: position.timestamp,
  };
}

export function useLocation(plan: SamplingPlan): {
  fix: LocationFix | null;
  permission: LocationPermission;
} {
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [permission, setPermission] = useState<LocationPermission>("unknown");
  useEffect(() => {
    if (plan.accuracy === "off") return undefined;
    let subscription: Location.LocationSubscription | null = null;
    let live = true;
    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (!live) return;
      setPermission(status === Location.PermissionStatus.GRANTED ? "granted" : "denied");
      if (status !== Location.PermissionStatus.GRANTED) return;
      subscription = await Location.watchPositionAsync(
        {
          accuracy: ACCURACY[plan.accuracy === "off" ? "low" : plan.accuracy],
          timeInterval: plan.intervalMs,
          distanceInterval: plan.distanceM,
        },
        (position) => setFix(toFix(position)),
      );
      if (!live) subscription.remove();
    })();
    return () => {
      live = false;
      subscription?.remove();
    };
  }, [plan.accuracy, plan.intervalMs, plan.distanceM]);
  return { fix, permission };
}
