import { redirect } from "next/navigation";

/** Entry: operators start at tenant search; the proxy already sent anyone signed out to sign in. */
export default function EntryPage() {
  redirect("/tenants");
}
