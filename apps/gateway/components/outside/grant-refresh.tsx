"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * A link's grant cookie is scoped to the link's own path, so the render a sign-in's server action redirects to (its
 * request was to /auth/sign-in) never carries it, and would ask for the code again. One refresh on this path sends it.
 */
export function GrantRefresh() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
