"use client";

import { CollectionError } from "@/components/operations/states";

export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CollectionError {...props} />;
}
