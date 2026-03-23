/**
 * tracker-github-api plugin — GitHub Issues as an issue tracker.
 *
 * Uses the GitHub REST API directly via fetch (no gh CLI required).
 * Requires a GitHub token in GH_TOKEN or GITHUB_TOKEN environment variable.
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@agentboard/ao-core";

// ---------------------------------------------------------------------------
// GitHub REST API types
// ---------------------------------------------------------------------------

interface GhApiIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  pull_request?: unknown; // present on PR items returned by the issues endpoint
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error("GitHub token not found. Set GH_TOKEN or GITHUB_TOKEN environment variable.");
  }
  return token;
}

function baseHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "ao-plugin-tracker-github-api/0.1.0",
  };
}

async function ghFetch<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: baseHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { message?: string };
      detail = json.message ? `: ${json.message}` : "";
    } catch {
      // ignore parse errors
    }
    throw new Error(`GitHub API ${method} ${path} failed with ${res.status}${detail}`);
  }

  return res.json() as Promise<T>;
}

function mapState(state: string, stateReason?: string | null): Issue["state"] {
  if (state === "closed") {
    if (stateReason === "not_planned") return "cancelled";
    return "closed";
  }
  return "open";
}

function mapIssue(data: GhApiIssue): Issue {
  return {
    id: String(data.number),
    title: data.title,
    description: data.body ?? "",
    url: data.html_url,
    state: mapState(data.state, data.state_reason),
    labels: data.labels.map((l) => l.name),
    assignee: data.assignees[0]?.login,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitHubApiTracker(): Tracker {
  return {
    name: "github-api",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const num = identifier.replace(/^#/, "");
      const data = await ghFetch<GhApiIssue>("GET", `/repos/${project.repo}/issues/${num}`);
      return mapIssue(data);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const num = identifier.replace(/^#/, "");
      const data = await ghFetch<{ state: string }>("GET", `/repos/${project.repo}/issues/${num}`);
      return data.state === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${project.repo}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = url.match(/\/issues\/(\d+)/);
      if (match) return `#${match[1]}`;
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const params = new URLSearchParams();

      if (filters.state === "closed") {
        params.set("state", "closed");
      } else if (filters.state === "all") {
        params.set("state", "all");
      } else {
        params.set("state", "open");
      }

      if (filters.labels && filters.labels.length > 0) {
        params.set("labels", filters.labels.join(","));
      }

      if (filters.assignee) {
        params.set("assignee", filters.assignee);
      }

      params.set("per_page", String(filters.limit ?? 30));

      const items = await ghFetch<GhApiIssue[]>(
        "GET",
        `/repos/${project.repo}/issues?${params.toString()}`,
      );

      // The issues endpoint also returns pull requests — filter them out
      return items.filter((item) => !("pull_request" in item)).map(mapIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const num = identifier.replace(/^#/, "");
      const path = `/repos/${project.repo}/issues/${num}`;

      // Handle state change
      if (update.state === "closed") {
        await ghFetch("PATCH", path, { state: "closed" });
      } else if (update.state === "open") {
        await ghFetch("PATCH", path, { state: "open" });
      }

      // Handle label changes (add and/or remove)
      const hasLabelChange =
        (update.labels && update.labels.length > 0) ||
        (update.removeLabels && update.removeLabels.length > 0);

      if (hasLabelChange) {
        // Fetch current labels to compute the new set
        const current = await ghFetch<GhApiIssue>("GET", path);
        const currentLabels = new Set(current.labels.map((l) => l.name));

        if (update.removeLabels) {
          for (const l of update.removeLabels) currentLabels.delete(l);
        }
        if (update.labels) {
          for (const l of update.labels) currentLabels.add(l);
        }

        await ghFetch("PATCH", path, { labels: [...currentLabels] });
      }

      // Handle assignee change
      if (update.assignee) {
        await ghFetch("PATCH", path, { assignees: [update.assignee] });
      }

      // Handle comment
      if (update.comment) {
        await ghFetch("POST", `/repos/${project.repo}/issues/${num}/comments`, {
          body: update.comment,
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const body: Record<string, unknown> = {
        title: input.title,
        body: input.description ?? "",
      };

      if (input.labels && input.labels.length > 0) {
        body["labels"] = input.labels;
      }

      if (input.assignee) {
        body["assignees"] = [input.assignee];
      }

      const created = await ghFetch<GhApiIssue>("POST", `/repos/${project.repo}/issues`, body);
      return mapIssue(created);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github-api",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues via REST API",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitHubApiTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
