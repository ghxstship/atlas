import type { ReactElement } from "react";
import { Gate } from "../src/screens/common";
import { ShowView } from "../src/screens/ShowView";

/** The read-only running order for audiences that follow the show (client, crew, artist). */
export default function RunOfShowScreen(): ReactElement {
  return (
    <Gate feature="show.read">
      <ShowView readOnly />
    </Gate>
  );
}
