import { usePathname } from "next/navigation";

/** The org slug of an Atlas page: the first path segment. */
export function useOrgSlug(): string {
  return usePathname().split("/").filter(Boolean)[0] ?? "";
}
