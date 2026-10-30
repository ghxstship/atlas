import { unstable_rethrow } from "next/navigation";
import { observability } from "@/lib/observability";

/**
 * One region's data as a page loader read it (ADR 0118): the data, or that its read failed. A loader
 * that reads several regions at once returns one of these per region, so a failed read shows Retry in
 * that region (RegionContent, components/shell/region-content.tsx) and the rest of the page renders.
 */
export type RegionData<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

function failed(region: string, error: unknown): RegionData<never> {
  // A redirect or not found from inside a read still belongs to Next.
  unstable_rethrow(error);
  observability.errors.report(error, { tags: { source: "region", region } });
  return { ok: false };
}

/** The region's data from a value that throws when its read failed, such as `must(result, what)`. */
export function regionOf<T>(region: string, value: () => T): RegionData<T> {
  try {
    return { ok: true, data: value() };
  } catch (error) {
    return failed(region, error);
  }
}

/** The region's data from a read that rejects when it fails. */
export async function regionRead<T>(
  region: string,
  read: () => Promise<T>,
): Promise<RegionData<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    return failed(region, error);
  }
}
