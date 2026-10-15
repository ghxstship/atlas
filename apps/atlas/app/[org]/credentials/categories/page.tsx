import { CategoriesSection } from "@/components/credentials/sections";
import { loadModulePage } from "@/lib/operations/context";

/** Credential categories (Section 4.2): codes and names per project, with the count of live credentials. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/credentials/categories">) {
  const page = await loadModulePage("credentials.categories", await params, await searchParams);
  return <CategoriesSection page={page} />;
}
