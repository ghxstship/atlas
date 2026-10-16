import { RadioChannelsSection } from "@/components/incidents/sections";
import { loadModulePage } from "@/lib/operations/context";

/** The radio plan (Section 4.2): channels by number and zone, started from the Standard Library. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/safety/radio-channels">) {
  const page = await loadModulePage("safety.radio-channels", await params, await searchParams);
  return <RadioChannelsSection page={page} />;
}
