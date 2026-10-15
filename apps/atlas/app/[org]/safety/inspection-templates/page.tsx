import { TemplatesPage } from "@/components/safety/templates/templates-page";

/** Safety > Inspection templates (A09). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/safety/inspection-templates">) {
  return <TemplatesPage params={await params} search={await searchParams} />;
}
