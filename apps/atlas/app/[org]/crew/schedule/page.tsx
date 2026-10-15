import { ShiftsCollection } from "@/components/crew/shifts-collection";
import { flatParams } from "@/lib/crew/context";

/** Crew > Schedule (Section 4.5.5): the week's crew by person in the resource schedule. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/schedule">) {
  return (
    <ShiftsCollection
      node="crew.schedule"
      params={await params}
      search={flatParams(await searchParams)}
    />
  );
}
