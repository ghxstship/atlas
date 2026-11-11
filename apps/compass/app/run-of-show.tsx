import type { ReactElement } from "react";
import { Gate } from "../src/screens/common";
import { ShowView } from "../src/screens/ShowView";

/** The read-only running order for the Client, who follows the show (Section 4.5.7). */
export default function RunOfShowScreen(): ReactElement {
  return (
    <Gate feature="show.read">
      <ShowView readOnly />
    </Gate>
  );
}
