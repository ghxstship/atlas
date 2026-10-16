import { ok } from "@xos/data/result";
import {
  completeTraining,
  listMyLessonProgress,
  listTrainingAssignments,
  listTrainingCompletions,
  listTrainingCourses,
} from "@xos/data/workforce-training";
import { TrainingScreen } from "@xos/workforce-native";
import * as Linking from "expo-linking";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { trainingLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";
import { myCourses } from "../../src/workforce/training";

/** Training (Atlas knowledge.training): assigned courses, lessons offline, quizzes graded online. */
function Training(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const loaded = useLoad(
    orgId
      ? async () => {
          const [courses, assignments, progress, completions] = await Promise.all([
            listTrainingCourses(wf.db, orgId),
            listTrainingAssignments(wf.db, orgId),
            listMyLessonProgress(wf.db, wf.myMembershipIds),
            listTrainingCompletions(wf.db, orgId),
          ]);
          for (const r of [courses, assignments, progress, completions]) if (!r.ok) return r;
          return ok(
            myCourses(
              courses.ok ? courses.data : [],
              assignments.ok ? assignments.data : [],
              progress.ok ? progress.data : [],
              completions.ok ? completions.data : [],
              wf.myMembershipIds,
            ),
          );
        }
      : null,
    [orgId, wf.syncTick],
  );
  return (
    <TrainingScreen
      {...frameProps(loaded)}
      labels={trainingLabels(t)}
      courses={loaded.data ?? []}
      onCompleteLesson={(lessonId) =>
        wf.queue("complete_training_lesson", { p_lesson_id: lessonId })
      }
      // The quiz is graded by the server, so it needs a connection.
      onCompleteCourse={async (courseId, answers) => {
        const result = await wf.online(completeTraining(wf.db, courseId, answers));
        if (result.ok) loaded.refresh();
        return result;
      }}
      onOpenVideo={(url) => void Linking.openURL(url)}
      onEmptyAction={loaded.refresh}
    />
  );
}

export default function TrainingRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Training />
    </WorkforceGate>
  );
}
