import type { ConsentLinkRenderer } from "@xos/ui/consent";
import type { Route } from "next";
import Link from "next/link";

/**
 * Draws a consent link with next/link. The server banner calls it directly; the Cookie settings
 * client module passes it to ConsentSettings. It has no client directive of its own.
 */
export const routerLink: ConsentLinkRenderer = (link, className) => (
  <Link href={link.href as Route} className={className}>
    {link.label}
  </Link>
);
