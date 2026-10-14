/**
 * Connectivity as the sync engine sees it.
 *
 * Airplane mode, a captive portal and a dead cell all look different to the OS; the engine treats any of
 * them as "do not upload". A connected network whose internet reachability is still unknown counts as
 * reachable, because the upload itself is the real probe and a failed one is retried.
 */

export interface NetworkState {
  readonly isConnected: boolean;
  /** null while the OS has not finished probing. */
  readonly isInternetReachable: boolean | null;
  readonly isAirplaneMode: boolean;
  /** Low-data mode (Section 11.13): uploads still run, media waits for an unmetered network. */
  readonly isExpensive: boolean;
}

export const OFFLINE: NetworkState = Object.freeze({
  isConnected: false,
  isInternetReachable: false,
  isAirplaneMode: false,
  isExpensive: false,
});

export const ONLINE: NetworkState = Object.freeze({
  isConnected: true,
  isInternetReachable: true,
  isAirplaneMode: false,
  isExpensive: false,
});

export function canUpload(state: NetworkState): boolean {
  return state.isConnected && !state.isAirplaneMode && state.isInternetReachable !== false;
}

/** True when the network just came back: the moment the engine drains the queue. */
export function cameOnline(previous: NetworkState, next: NetworkState): boolean {
  return !canUpload(previous) && canUpload(next);
}
