/**
 * GitHub Actions pinned by SHA (Section 9 supply chain).
 *
 * Every `uses:` in `.github/workflows` must name a third-party action by a full 40-character commit SHA
 * followed by a `# vX.Y.Z` comment, and that SHA must be the commit the upstream tag points at:
 *
 *   uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
 *
 * Local actions (`./...`) are exempt. A `docker://` reference must carry an `@sha256:` digest.
 * `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag> refs/tags/<tag>^{}` gives the tag's object
 * and, for an annotated tag, the commit it peels to; the pin must equal the commit.
 */

export interface ActionUse {
  readonly file: string;
  readonly line: number;
  readonly action: string;
  /** `owner/repo`, the repository the tag lives in. */
  readonly repository: string;
  readonly ref: string;
  readonly version: string | null;
}

export interface PinProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(?:#\s*(\S+))?/;
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^v?\d+(?:\.\d+){0,2}$/;

/** Finds every `uses:` reference in one workflow file. */
export function findUses(file: string, text: string): ActionUse[] {
  const uses: ActionUse[] = [];
  text.split("\n").forEach((line, index) => {
    const match = USES.exec(line);
    if (match === null) return;
    const reference = match[2] ?? "";
    const at = reference.lastIndexOf("@");
    const action = at === -1 ? reference : reference.slice(0, at);
    uses.push({
      file,
      line: index + 1,
      action,
      repository: /^(?:\.\/|docker:\/\/)/.test(action)
        ? action
        : action.split("/").slice(0, 2).join("/"),
      ref: at === -1 ? "" : reference.slice(at + 1),
      version: match[3] ?? null,
    });
  });
  return uses;
}

/** The checks that need no network: a full SHA and a version comment. */
export function checkPinFormat(use: ActionUse): PinProblem | null {
  const at = { file: use.file, line: use.line };
  if (use.action.startsWith("./")) return null;
  if (use.action.startsWith("docker://")) {
    return /@sha256:[0-9a-f]{64}$/.test(`${use.action}@${use.ref}`)
      ? null
      : { ...at, message: `${use.action} is a container action without an @sha256: digest` };
  }
  if (!SHA.test(use.ref)) {
    return { ...at, message: `${use.action}@${use.ref} is not pinned to a full commit SHA` };
  }
  if (use.version === null || !VERSION.test(use.version)) {
    return { ...at, message: `${use.action}@${use.ref} has no "# vX.Y.Z" version comment` };
  }
  return null;
}

/**
 * Compares a pin with `git ls-remote` output for its tag. `lsRemote` is the raw output: lines of
 * `<sha>\trefs/tags/<tag>` and, for annotated tags, `<sha>\trefs/tags/<tag>^{}`.
 */
export function checkPinAgainstTag(use: ActionUse, lsRemote: string): PinProblem | null {
  const at = { file: use.file, line: use.line };
  const refs = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha !== undefined && ref !== undefined) refs.set(ref, sha);
  }
  const tag = `refs/tags/${use.version ?? ""}`;
  const commit = refs.get(`${tag}^{}`) ?? refs.get(tag);
  if (commit === undefined) {
    return { ...at, message: `${use.repository} has no tag ${use.version ?? ""}` };
  }
  if (commit !== use.ref) {
    return {
      ...at,
      message: `${use.action}@${use.ref} is not ${use.version ?? ""}, which is ${commit}`,
    };
  }
  return null;
}

/** The distinct (repository, tag, sha) triples to verify, so each tag is fetched once. */
export function distinctPins(uses: readonly ActionUse[]): ActionUse[] {
  const seen = new Map<string, ActionUse>();
  for (const use of uses) {
    if (use.action.startsWith("./") || use.action.startsWith("docker://")) continue;
    const key = `${use.repository}@${use.ref}#${use.version ?? ""}`;
    if (!seen.has(key)) seen.set(key, use);
  }
  return [...seen.values()];
}
