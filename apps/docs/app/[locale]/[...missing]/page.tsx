import { notFound } from "next/navigation";

/** Any path the site does not serve renders the localized 404 page. */
export default function Missing(): never {
  notFound();
}
