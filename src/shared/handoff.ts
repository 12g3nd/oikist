/**
 * The block that moves a task from one provider to the other.
 *
 * Deliberately small and deliberately authored: the task, the working state, the files
 * that moved, and a note about what was tried. A raw transcript is never included — it
 * is enormous, mostly noise, and would spend the receiving agent's context on turn one.
 *
 * The failure this format exists to prevent is a handoff that loses "what I already
 * tried and why it did not work", which just makes the second agent repeat the first
 * agent's dead ends. That is why the note is required rather than optional.
 */

export type HandoffProvider = "claude" | "codex";

export interface ChangedFile {
  readonly status: string;
  readonly path: string;
}

export interface WorkingState {
  readonly branch: string;
  readonly worktree: string;
  readonly files: readonly ChangedFile[];
  readonly diffStat: string;
}

export interface HandoffInput extends WorkingState {
  readonly from: HandoffProvider;
  readonly to: HandoffProvider;
  readonly task: string;
  readonly note: string;
}

/**
 * A receiving agent needs to know which files moved, not to read a thousand paths. Past
 * this many the list is truncated with an explicit remainder, so the count stays honest
 * while the block stays small.
 */
export const MAX_LISTED_FILES = 50;

/**
 * Parses `git status --porcelain` into status/path pairs.
 *
 * The two-character status field is trimmed to its meaningful letters, so a staged
 * modification (`M `), an unstaged one (` M`) and an untracked file (`??`) all read the
 * same way. For a rename only the destination is carried: that is the file the
 * receiving agent will actually open.
 */
export function parseGitStatus(porcelain: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const status = line.slice(0, 2).trim();
    const rest = line.slice(3).trim();
    if (status === "" || rest === "") {
      continue;
    }
    const arrow = rest.indexOf(" -> ");
    files.push({ status, path: arrow === -1 ? rest : rest.slice(arrow + 4) });
  }
  return files;
}

function section(heading: string, body: string): string[] {
  return body.trim() === "" ? [] : ["", `## ${heading}`, "", body.trim()];
}

export function composeHandoff(input: HandoffInput): string {
  const lines: string[] = [
    `# Handoff — ${input.from} → ${input.to}`,
    "",
    `Branch:   ${input.branch}`,
    `Worktree: ${input.worktree}`
  ];

  lines.push(...section("Task", input.task));
  lines.push(...section("Where I got to", input.note));

  if (input.files.length > 0) {
    const shown = input.files.slice(0, MAX_LISTED_FILES);
    const remainder = input.files.length - shown.length;
    const listed = shown.map((file) => `${file.status.padEnd(2, " ")} ${file.path}`);
    if (remainder > 0) {
      listed.push(`… +${remainder} more`);
    }
    lines.push(...section(`Changed files (${input.files.length})`, listed.join("\n")));
  }

  lines.push(...section("Diff summary", input.diffStat));

  // Normalised to LF so the block pastes identically into either provider's prompt.
  return `${lines.join("\n").replace(/\r/g, "")}\n`;
}

/**
 * Whether a handoff is worth sending.
 *
 * A missing note is the one failure worth blocking on, for the reason in the header
 * comment. Everything else degrades: a handoff without a diff is still useful.
 */
export function handoffProblem(input: Pick<HandoffInput, "note">): string | null {
  return input.note.trim() === ""
    ? "A handoff needs a note. Without what was already tried, the receiving agent repeats the dead ends."
    : null;
}
