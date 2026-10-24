import type { ReactElement } from "react";
import { ExternalPageScreen } from "../src/screens/ExternalPageScreen";

/** The deliverables More screen for external role types (Section 4.5.7, A92); see src/domain/external.ts. */
export default function DeliverablesScreen(): ReactElement {
  return <ExternalPageScreen page="deliverables" />;
}
