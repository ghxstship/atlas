import { ShiftsCollection } from "@/components/crew/shifts-collection";
import { flatParams } from "@/lib/crew/context";

/** Crew > Shifts (Section 4.5.5): shifts in the resource schedule, list, table and calendar views. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/shifts">) {
  return (
    <ShiftsCollection
      node="crew.shifts"
      params={await params}
      search={flatParams(await searchParams)}
    />
  );
}
