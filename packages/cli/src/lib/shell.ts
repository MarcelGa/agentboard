import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { accessSync, constants } from "node:fs";
import { resolveTmux } from "@agentboard/ao-core";

const execFileAsync = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

export async function execSilent(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout;
  } catch {
    return null;
  }
}

export async function tmux(...args: string[]): Promise<string | null> {
  return execSilent(resolveTmux(), args);
}

/** Well-known git install paths to probe when git is not on PATH */
const GIT_FALLBACK_PATHS: string[] =
  platform() === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files (x86)\\Git\\bin\\git.exe",
        join(homedir(), "AppData\\Local\\Programs\\Git\\bin\\git.exe"),
      ]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

/** Cached resolved path to the git executable */
let resolvedGitPath: string | undefined;

/**
 * Resolve the path to the git executable.
 * First tries `which`/`where` to respect the current PATH, then probes
 * well-known install locations so that environments where PATH does not
 * include the git directory (e.g. GUI launchers on Windows) still work.
 */
async function resolveGit(): Promise<string> {
  if (resolvedGitPath !== undefined) return resolvedGitPath;

  const lookupCmd = platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookupCmd, ["git"]);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found) {
      resolvedGitPath = found;
      return resolvedGitPath;
    }
  } catch {
    // fall through
  }

  for (const candidate of GIT_FALLBACK_PATHS) {
    try {
      accessSync(candidate, constants.X_OK);
      resolvedGitPath = candidate;
      return resolvedGitPath;
    } catch {
      // not found
    }
  }

  resolvedGitPath = "git";
  return resolvedGitPath;
}

export async function git(args: string[], cwd?: string): Promise<string | null> {
  try {
    const gitBin = await resolveGit();
    const { stdout } = await exec(gitBin, args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

export async function gh(args: string[]): Promise<string | null> {
  return execSilent("gh", args);
}

export async function getTmuxSessions(): Promise<string[]> {
  const output = await tmux("list-sessions", "-F", "#{session_name}");
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

export async function getTmuxActivity(session: string): Promise<number | null> {
  const output = await tmux("display-message", "-t", session, "-p", "#{session_activity}");
  if (!output) return null;
  const ts = parseInt(output, 10);
  return isNaN(ts) ? null : ts * 1000;
}
