import { ShiftsCollection } from "@/components/crew/shifts-collection";
import { flatParams } from "@/lib/crew/context";

/** The project Crew tab (Section 4.5.4): the project's shifts in the Crew views. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/crew">) {
  return (
    <ShiftsCollection
      node="project.crew"
      params={await params}
      search={flatParams(await searchParams)}
    />
  );
}
