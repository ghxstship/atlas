import type { ProjectState } from "@xos/data/projects";
import * as enums from "@xos/data/enums";

/**
 * Project states in enum order (app.project_state), for client components: importing
 * PROJECT_STATES from @xos/data/projects ships the whole generated enum table to the browser
 * (A24-009), where @xos/data/enums brings only this list. It lives apart from format.ts, which every
 * page's shell loads, so the enum lists the app's lazy views share stay out of first-load JavaScript.
 * test/projects-format.test.ts holds it equal to PROJECT_STATES.
 */
export const PROJECT_STATE_ORDER: readonly ProjectState[] = enums.projectState;
