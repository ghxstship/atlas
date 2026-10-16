/**
 * The person's courses for the TrainingScreen, joined from A29's training reads: published courses
 * assigned to the person, the lessons they finished and their latest result.
 */
import type {
  TrainingAssignment,
  TrainingCompletion,
  TrainingCourse,
} from "@xos/data/workforce-training";
import type { MyCourse } from "@xos/workforce-native";

export function myCourses(
  courses: readonly TrainingCourse[],
  assignments: readonly TrainingAssignment[],
  completedLessonIds: readonly string[],
  completions: readonly TrainingCompletion[],
  myMembershipIds: readonly string[],
): MyCourse[] {
  const mine = new Set(myMembershipIds);
  const assigned = new Map(
    assignments.filter((a) => mine.has(a.membershipId)).map((a) => [a.courseId, a.dueOn]),
  );
  return courses
    .filter((c) => c.state === "Published" && assigned.has(c.id))
    .map((course) => {
      const latest = completions
        .filter((c) => c.courseId === course.id && mine.has(c.membershipId))
        .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
      const lessonIds = new Set(course.lessons.map((l) => l.id));
      return {
        course,
        dueOn: assigned.get(course.id) ?? null,
        completedLessonIds: completedLessonIds.filter((id) => lessonIds.has(id)),
        result: latest ? (latest.passed ? ("passed" as const) : ("failed" as const)) : null,
      };
    })
    .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
}
