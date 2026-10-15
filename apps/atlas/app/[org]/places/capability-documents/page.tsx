import { DocumentsPage } from "@/components/places/documents/documents-page";

/** Places > Capability documents (A09). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/places/capability-documents">) {
  return <DocumentsPage params={await params} search={await searchParams} />;
}
