import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  symlinkSync,
  rmSync,
  mkdirSync,
  readdirSync,
  accessSync,
  constants,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir, platform } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@composio/ao-core";

/** Timeout for git commands (30 seconds) */
const GIT_TIMEOUT = 30_000;

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

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

  // 1. Try locating git via the OS lookup command
  const lookupCmd = platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookupCmd, ["git"]);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found) {
      resolvedGitPath = found;
      return resolvedGitPath;
    }
  } catch {
    // `which`/`where` not available or git not on PATH — fall through
  }

  // 2. Probe well-known install paths
  for (const candidate of GIT_FALLBACK_PATHS) {
    try {
      accessSync(candidate, constants.X_OK);
      resolvedGitPath = candidate;
      return resolvedGitPath;
    } catch {
      // Not found at this path
    }
  }

  // 3. Last resort: return bare "git" and let the OS throw a meaningful error
  resolvedGitPath = "git";
  return resolvedGitPath;
}

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const gitBin = await resolveGit();
  const { stdout } = await execFileAsync(gitBin, args, { cwd });
  return stdout.trimEnd();
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "worktree",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });

      // Fetch latest from remote
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // Fetch may fail if offline — continue anyway
      }

      const baseRef = `origin/${cfg.project.defaultBranch}`;

      // Always prune stale worktree registrations before attempting to create
      // a new one. Use --expire=now to bypass the default 3-month grace period,
      // which would otherwise leave "missing but already registered" entries
      // that cause git to refuse the add.
      try {
        await git(repoPath, "worktree", "prune", "--expire=now");
      } catch {
        // Best-effort
      }

      // Remove a leftover directory from a previous aborted attempt so git
      // can create a fresh worktree in its place.
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }

      // Create worktree with a new branch
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        // Only retry if the error is "branch already exists"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${msg}`, {
            cause: err,
          });
        }
        // Branch already exists — create worktree and check it out
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        try {
          await git(worktreePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          // Checkout failed — remove the orphaned worktree before rethrowing
          try {
            await git(repoPath, "worktree", "remove", "--force", worktreePath);
          } catch {
            // Best-effort cleanup
          }
          const checkoutMsg =
            checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`, {
            cause: checkoutErr,
          });
        }
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        // git-common-dir returns something like /path/to/repo/.git
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);

        // NOTE: We intentionally do NOT delete the branch here. The worktree
        // removal is sufficient. Auto-deleting branches risks removing
        // pre-existing local branches unrelated to this workspace (any branch
        // containing "/" would have been deleted). Stale branches can be
        // cleaned up separately via `git branch --merged` or similar.
      } catch {
        // If git commands fail, try to clean up the directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      // Parse porcelain output — only include worktrees within our project directory
      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feat/INT-1234 → feat/INT-1234
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        const gitBin = await resolveGit();
        await execFileAsync(gitBin, ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

      // Prune stale worktree entries
      try {
        await git(repoPath, "worktree", "prune");
      } catch {
        // Best effort
      }

      // Fetch latest
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // May fail if offline
      }

      // Try to create worktree on the existing branch
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        // Branch might not exist locally — try from origin
        const remoteBranch = `origin/${cfg.branch}`;
        try {
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, remoteBranch);
        } catch {
          // Last resort: create from default branch
          const baseRef = `origin/${cfg.project.defaultBranch}`;
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
        }
      }

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = expandPath(project.path);

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const stat = lstatSync(targetPath);
            if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], { cwd: info.path });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
