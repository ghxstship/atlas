import { PermitsPage } from "@/components/safety/permits/permits-page";

/** Safety > Permits (A09): the permit engine's requirements across projects. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/safety/permits">) {
  return <PermitsPage params={await params} search={await searchParams} />;
}
