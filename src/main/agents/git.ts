import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitStatus, type WorkingState } from "../../shared/handoff.js";

const run = promisify(execFile);

/**
 * Reads the working state a handoff carries.
 *
 * Every call passes an argument array and never a shell string, so a branch or path
 * containing shell metacharacters is data rather than syntax. A directory that is not a
 * repository degrades to empty values rather than failing: a handoff without a diff is
 * still worth sending.
 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run("git", [...args], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024
    });
    // Trailing whitespace only. `git status --porcelain` puts the worktree status in the
    // second column, so an unstaged modification begins with a significant leading space
    // (" M path"); trimming both ends shifts every path one character left.
    return stdout.replace(/\s+$/, "");
  } catch {
    return "";
  }
}

export async function readWorkingState(cwd: string): Promise<WorkingState> {
  const [branch, porcelain, diffStat] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["diff", "--stat", "HEAD"])
  ]);

  return {
    branch: branch.trim() === "" ? "(not a git repository)" : branch.trim(),
    worktree: cwd,
    files: parseGitStatus(porcelain),
    // Only the summary line, which is the part a receiving agent can act on.
    diffStat: diffStat.split("\n").at(-1)?.trim() ?? ""
  };
}
