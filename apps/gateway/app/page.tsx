import { redirect } from "next/navigation";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Entry. A signed-in person goes Home; everyone else signs in. An email link that fell back to the
 * site root still completes through /auth/callback.
 */
export default async function EntryPage({ searchParams }: PageProps<"/">) {
  const code = (await searchParams)["code"];
  if (typeof code === "string") redirect(`/auth/callback?code=${encodeURIComponent(code)}`);
  const ctx = await getGatewayContext();
  redirect(ctx ? "/home" : "/auth/sign-in");
}
