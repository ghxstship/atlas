/**
 * React Native's JavaScript engine has no Web Crypto. @xos/sync mints offline ids (UUIDv7) with
 * globalThis.crypto.getRandomValues, so the entry point installs expo-crypto's implementation first,
 * before any route module runs.
 */
import { getRandomValues } from "expo-crypto";

const scope = globalThis as { crypto?: Partial<Crypto> };
if (typeof scope.crypto?.getRandomValues !== "function") {
  scope.crypto = { ...scope.crypto, getRandomValues: getRandomValues as Crypto["getRandomValues"] };
}
