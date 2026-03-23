/**
 * scm-azuredevops plugin — Azure DevOps PRs, CI pipelines, code reviews.
 *
 * Uses the Azure DevOps REST API v7 via Node's built-in fetch.
 *
 * Required environment variables:
 *   AZURE_DEVOPS_PAT  — Personal Access Token with Code (Read & Write) + Build (Read) scopes
 *
 * Config (in agent-orchestrator.yaml):
 *   projects:
 *     my-app:
 *       repo: "owner/repo"           # used as "ADOproject/ADOrepo"
 *       scm:
 *         plugin: azuredevops
 *         orgUrl: https://dev.azure.com/myorg   # required
 *         project: MyProject                     # ADO project name (defaults to repo owner segment)
 *         patEnvVar: AZURE_DEVOPS_PAT            # optional override, default AZURE_DEVOPS_PAT
 */

import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type SCMWebhookEvent,
  type SCMWebhookRequest,
  type SCMWebhookVerificationResult,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";

// =============================================================================
// ADO API Client
// =============================================================================

interface ADOConfig {
  orgUrl: string; // e.g. https://dev.azure.com/myorg
  project: string; // ADO project name
  repo: string; // ADO repo name
  pat: string;
}

function getADOConfig(project: ProjectConfig): ADOConfig {
  const scm = project.scm as Record<string, unknown> | undefined;

  const orgUrl =
    typeof scm?.["orgUrl"] === "string"
      ? scm["orgUrl"].replace(/\/+$/, "")
      : undefined;
  if (!orgUrl) throw new Error("Azure DevOps SCM plugin requires 'orgUrl' in scm config");

  // repo field in config: "ADOproject/ADOrepo"
  const repoParts = project.repo.split("/");
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    throw new Error(
      `Invalid repo format "${project.repo}" for Azure DevOps. Expected "ADOproject/ADOrepo"`,
    );
  }

  const adoProject =
    typeof scm?.["project"] === "string" ? scm["project"] : repoParts[0];
  const adoRepo = repoParts[1];

  const patEnvVar =
    typeof scm?.["patEnvVar"] === "string" ? scm["patEnvVar"] : "AZURE_DEVOPS_PAT";
  const pat = process.env[patEnvVar];
  if (!pat) {
    throw new Error(
      `Azure DevOps PAT not set. Configure ${patEnvVar} environment variable.`,
    );
  }

  return { orgUrl, project: adoProject, repo: adoRepo, pat };
}

function authHeader(pat: string): string {
  const token = Buffer.from(`:${pat}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Construct an ADOConfig from a PRInfo object.
 * PRInfo.owner = ADO project, PRInfo.repo = ADO repo name.
 * orgUrl must be set as AZURE_DEVOPS_ORG_URL env var (or AZURE_DEVOPS_ORG_URL_<PROJECT>).
 */
function getADOConfigFromPR(pr: PRInfo): ADOConfig {
  const orgUrl = (process.env["AZURE_DEVOPS_ORG_URL"] ?? "").replace(/\/+$/, "");
  const pat = process.env["AZURE_DEVOPS_PAT"] ?? "";
  if (!orgUrl) throw new Error("AZURE_DEVOPS_ORG_URL environment variable is required");
  if (!pat) throw new Error("AZURE_DEVOPS_PAT environment variable is required");
  return { orgUrl, project: pr.owner, repo: pr.repo, pat };
}

async function adoFetch(
  config: ADOConfig,
  path: string,
  options: { method?: string; body?: unknown; apiVersion?: string } = {},
): Promise<unknown> {
  const apiVersion = options.apiVersion ?? "7.1";
  const base = `${config.orgUrl}/${encodeURIComponent(config.project)}/_apis`;
  const separator = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${separator}api-version=${apiVersion}`;

  const headers: Record<string, string> = {
    Authorization: authHeader(config.pat),
    Accept: "application/json",
  };

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `ADO API ${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`,
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

// =============================================================================
// ADO response shapes
// =============================================================================

interface ADOPullRequest {
  pullRequestId: number;
  url: string;
  title: string;
  sourceRefName: string; // refs/heads/feat/PROJ-123
  targetRefName: string;
  isDraft: boolean;
  status: string; // "active" | "completed" | "abandoned"
  repository: { name: string; project: { name: string } };
  reviewers: ADOReviewer[];
  mergeStatus?: string; // "succeeded" | "conflicts" | "rejectedByPolicy" | "failure" | "queued" | "notSet"
}

interface ADOReviewer {
  displayName: string;
  uniqueName: string;
  vote: number; // 10=approved, 5=approvedWithSuggestions, -5=waitForAuthor, -10=rejected, 0=noVote
  isRequired?: boolean;
}

interface ADOBuildResult {
  id: number;
  buildNumber: string;
  status: string; // "inProgress" | "completed" | "notStarted" | "cancelling" | "postponed" | "none"
  result?: string; // "succeeded" | "partiallySucceeded" | "failed" | "canceled" | "none"
  startTime?: string;
  finishTime?: string;
  _links: { web?: { href: string } };
  definition: { name: string };
}

interface ADOThread {
  id: number;
  status: string; // "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending" | "unknown"
  comments: ADOComment[];
  threadContext?: { filePath?: string; rightFileStart?: { line: number } };
  isDeleted?: boolean;
}

interface ADOComment {
  id: number;
  content: string;
  author: { displayName: string; uniqueName: string };
  publishedDate: string;
  commentType: string; // "text" | "codeChange" | "system"
  isDeleted?: boolean;
  _links?: { self?: { href: string } };
}

// =============================================================================
// Helpers
// =============================================================================

function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function prInfoFromADO(pr: ADOPullRequest, config: ADOConfig): PRInfo {
  const branch = stripRefsHeads(pr.sourceRefName);
  const baseBranch = stripRefsHeads(pr.targetRefName);
  const url = `${config.orgUrl}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repo)}/pullrequest/${pr.pullRequestId}`;

  return {
    number: pr.pullRequestId,
    url,
    title: pr.title,
    owner: config.project,
    repo: config.repo,
    branch,
    baseBranch,
    isDraft: pr.isDraft ?? false,
  };
}

function mapBuildToCICheck(build: ADOBuildResult): CICheck {
  let status: CICheck["status"];
  const s = build.status?.toLowerCase() ?? "";
  const r = build.result?.toLowerCase() ?? "";

  if (s === "inprogress" || s === "cancelling") {
    status = "running";
  } else if (s === "notstarted" || s === "postponed" || s === "queued") {
    status = "pending";
  } else if (s === "completed") {
    if (r === "succeeded" || r === "partiallysucceeded") {
      status = "passed";
    } else if (r === "failed") {
      status = "failed";
    } else if (r === "canceled" || r === "cancelled") {
      status = "skipped";
    } else {
      status = "skipped";
    }
  } else {
    status = "skipped";
  }

  const check: CICheck = {
    name: build.definition.name,
    status,
    conclusion: build.result?.toUpperCase() ?? build.status?.toUpperCase(),
    startedAt: build.startTime ? new Date(build.startTime) : undefined,
    completedAt: build.finishTime ? new Date(build.finishTime) : undefined,
  };

  const webHref = build._links?.web?.href;
  if (webHref) check.url = webHref;

  return check;
}

/** Known bot display-name patterns */
const BOT_PATTERNS = [/\[bot\]$/i, /^(dependabot|renovate|snyk|codecov)/i];
function isBot(displayName: string): boolean {
  return BOT_PATTERNS.some((p) => p.test(displayName));
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// =============================================================================
// Standalone helpers (used inside & outside the SCM object)
// =============================================================================

async function resolveADOPR(reference: string, project: ProjectConfig): Promise<PRInfo> {
  const config = getADOConfig(project);
  const prId = parseInt(reference, 10);
  if (isNaN(prId)) {
    const match = reference.match(/pullrequest\/(\d+)/i);
    if (!match) throw new Error(`Cannot resolve ADO PR reference: "${reference}"`);
    return resolveADOPR(match[1], project);
  }

  const data = (await adoFetch(
    config,
    `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${prId}`,
  )) as ADOPullRequest;

  return prInfoFromADO(data, config);
}

// =============================================================================
// SCM Implementation
// =============================================================================

function createAzureDevOpsSCM(): SCM {
  return {
    name: "azuredevops",

    // -----------------------------------------------------------------------
    // Webhooks (optional — ADO sends HMAC-256 in X-Hub-Signature if configured)
    // -----------------------------------------------------------------------

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      // ADO basic auth webhooks: verify shared secret embedded in Authorization header
      const scm = project.scm as Record<string, unknown> | undefined;
      const secretEnvVar =
        typeof scm?.["webhookSecretEnvVar"] === "string"
          ? scm["webhookSecretEnvVar"]
          : undefined;

      if (request.method.toUpperCase() !== "POST") {
        return { ok: false, reason: "Webhook requests must use POST" };
      }

      if (!secretEnvVar) {
        // No secret configured — accept all
        return { ok: true, eventType: "webhook" };
      }

      const secret = process.env[secretEnvVar];
      if (!secret) {
        return { ok: false, reason: `Webhook secret env var ${secretEnvVar} is not set` };
      }

      // ADO sends credentials in Basic Authorization header when configured
      const authValue = request.headers["authorization"] ?? request.headers["Authorization"];
      if (!authValue) {
        return { ok: false, reason: "Missing Authorization header for webhook verification" };
      }

      const expected = `Basic ${Buffer.from(`:${secret}`).toString("base64")}`;
      if (authValue !== expected) {
        return { ok: false, reason: "Webhook secret verification failed" };
      }

      return { ok: true, eventType: "webhook" };
    },

    async parseWebhook(
      request: SCMWebhookRequest,
      _project: ProjectConfig,
    ): Promise<SCMWebhookEvent | null> {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(request.body) as Record<string, unknown>;
      } catch {
        return null;
      }

      const eventType = typeof payload["eventType"] === "string" ? payload["eventType"] : "";
      const resource = payload["resource"] as Record<string, unknown> | undefined;

      // PR events
      if (eventType.startsWith("git.pullrequest")) {
        const pr = resource as Record<string, unknown> | undefined;
        const sourceRef =
          typeof pr?.["sourceRefName"] === "string" ? pr["sourceRefName"] : undefined;
        const prId =
          typeof pr?.["pullRequestId"] === "number" ? pr["pullRequestId"] : undefined;
        const headSha =
          typeof pr?.["lastMergeSourceCommit"] === "object" && pr?.["lastMergeSourceCommit"] !== null
            ? (
                (pr["lastMergeSourceCommit"] as Record<string, unknown>)["commitId"] as
                  | string
                  | undefined
              )
            : undefined;

        return {
          provider: "azuredevops",
          kind: "pull_request",
          action: eventType,
          rawEventType: eventType,
          prNumber: prId,
          branch: sourceRef ? stripRefsHeads(sourceRef) : undefined,
          sha: headSha,
          timestamp: parseDate(
            typeof payload["createdDate"] === "string" ? payload["createdDate"] : undefined,
          ),
          data: payload,
        };
      }

      // Build / pipeline events
      if (eventType.startsWith("build.")) {
        const build = resource as Record<string, unknown> | undefined;
        return {
          provider: "azuredevops",
          kind: "ci",
          action: eventType,
          rawEventType: eventType,
          sha:
            typeof build?.["sourceVersion"] === "string"
              ? (build["sourceVersion"] as string)
              : undefined,
          timestamp: parseDate(
            typeof build?.["finishTime"] === "string" ? (build["finishTime"] as string) : undefined,
          ),
          data: payload,
        };
      }

      // Push events
      if (eventType === "git.push") {
        const push = resource as Record<string, unknown> | undefined;
        const refUpdates = Array.isArray(push?.["refUpdates"])
          ? (push!["refUpdates"] as Array<Record<string, unknown>>)
          : [];
        const firstRef = refUpdates[0];
        return {
          provider: "azuredevops",
          kind: "push",
          action: eventType,
          rawEventType: eventType,
          branch: firstRef
            ? stripRefsHeads(
                typeof firstRef["name"] === "string" ? firstRef["name"] : "",
              )
            : undefined,
          sha:
            firstRef && typeof firstRef["newObjectId"] === "string"
              ? (firstRef["newObjectId"] as string)
              : undefined,
          timestamp: parseDate(
            typeof payload["createdDate"] === "string" ? payload["createdDate"] : undefined,
          ),
          data: payload,
        };
      }

      return {
        provider: "azuredevops",
        kind: "unknown",
        action: eventType,
        rawEventType: eventType,
        timestamp: parseDate(
          typeof payload["createdDate"] === "string" ? payload["createdDate"] : undefined,
        ),
        data: payload,
      };
    },

    // -----------------------------------------------------------------------
    // PR Lifecycle
    // -----------------------------------------------------------------------

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;
      const config = getADOConfig(project);

      try {
        const data = (await adoFetch(
          config,
          `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests?searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(session.branch)}&searchCriteria.status=active&$top=1`,
        )) as { value: ADOPullRequest[] };

        if (!Array.isArray(data.value) || data.value.length === 0) return null;
        return prInfoFromADO(data.value[0], config);
      } catch {
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      return resolveADOPR(reference, project);
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const config = getADOConfigFromPR(pr);

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
      )) as { status: string };

      const s = data.status?.toLowerCase();
      if (s === "completed") return "merged";
      if (s === "abandoned") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const config = getADOConfigFromPR(pr);

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
      )) as ADOPullRequest & { supportsIterations?: boolean };

      const s = data.status?.toLowerCase();
      const state: PRState = s === "completed" ? "merged" : s === "abandoned" ? "closed" : "open";

      // ADO doesn't provide additions/deletions directly — would require iterating commits
      // Return 0 as a safe default; these fields are optional context
      return { state, title: data.title ?? "", additions: 0, deletions: 0 };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const config = getADOConfigFromPR(pr);

      const mergeStrategyMap: Record<MergeMethod, string> = {
        squash: "squash",
        rebase: "rebaseMerge",
        merge: "noFastForward",
      };

      // First, get the latest commit of the PR's source branch
      const prData = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
      )) as { lastMergeSourceCommit?: { commitId: string } };

      const lastMergeSourceCommitId = prData.lastMergeSourceCommit?.commitId;
      if (!lastMergeSourceCommitId) {
        throw new Error(`Cannot find last merge source commit for PR ${pr.number}`);
      }

      await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
        {
          method: "PATCH",
          body: {
            status: "completed",
            lastMergeSourceCommit: { commitId: lastMergeSourceCommitId },
            completionOptions: {
              mergeStrategy: mergeStrategyMap[method] ?? "squash",
              deleteSourceBranch: true,
            },
          },
        },
      );
    },

    async closePR(pr: PRInfo): Promise<void> {
      const config = getADOConfigFromPR(pr);

      await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
        {
          method: "PATCH",
          body: { status: "abandoned" },
        },
      );
    },

    // -----------------------------------------------------------------------
    // CI Tracking — uses ADO Builds API, filtered by source branch
    // -----------------------------------------------------------------------

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      const config = getADOConfigFromPR(pr);

      const branchRef = `refs/heads/${pr.branch}`;
      const data = (await adoFetch(
        config,
        `/build/builds?branchName=${encodeURIComponent(branchRef)}&$top=20&queryOrder=queueTimeDescending`,
      )) as { value: ADOBuildResult[] };

      if (!Array.isArray(data.value)) return [];

      // Keep only the most recent build per definition (pipeline)
      const seen = new Set<string>();
      const checks: CICheck[] = [];
      for (const build of data.value) {
        const defName = build.definition?.name ?? String(build.id);
        if (!seen.has(defName)) {
          seen.add(defName);
          checks.push(mapBuildToCICheck(build));
        }
      }

      return checks;
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        return "failing";
      }

      if (checks.length === 0) return CI_STATUS.NONE;

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return CI_STATUS.FAILING;

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return CI_STATUS.PENDING;

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return CI_STATUS.NONE;

      return CI_STATUS.PASSING;
    },

    // -----------------------------------------------------------------------
    // Review Tracking — uses ADO Pull Request Reviewers and Threads APIs
    // -----------------------------------------------------------------------

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const config = getADOConfigFromPR(pr);

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}/reviewers`,
      )) as { value: ADOReviewer[] };

      if (!Array.isArray(data.value)) return [];

      return data.value.map((r): Review => {
        let state: Review["state"];
        if (r.vote === 10 || r.vote === 5) state = "approved";
        else if (r.vote === -10) state = "changes_requested";
        else if (r.vote === -5) state = "changes_requested"; // "waiting for author"
        else state = "pending";

        return {
          author: r.uniqueName ?? r.displayName ?? "unknown",
          state,
          submittedAt: new Date(0), // ADO reviewers API doesn't return submission time
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const reviews = await this.getReviews(pr);
      if (reviews.some((r) => r.state === "changes_requested")) return "changes_requested";
      if (reviews.some((r) => r.state === "approved")) return "approved";
      if (reviews.length > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const config = getADOConfigFromPR(pr);

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}/threads`,
      )) as { value: ADOThread[] };

      if (!Array.isArray(data.value)) return [];

      const comments: ReviewComment[] = [];
      for (const thread of data.value) {
        if (thread.isDeleted) continue;
        const status = thread.status?.toLowerCase();
        // "active" = pending/unresolved; skip fixed/closed/wontfix/bydesign
        if (status !== "active" && status !== "pending" && status !== "unknown") continue;

        const firstComment = thread.comments?.find(
          (c) => !c.isDeleted && c.commentType !== "system",
        );
        if (!firstComment) continue;

        const author = firstComment.author?.displayName ?? "unknown";
        if (isBot(author)) continue;

        const commentUrl =
          `${config.orgUrl}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repo)}/pullrequest/${pr.number}?_a=files&discussionId=${thread.id}`;

        comments.push({
          id: String(thread.id),
          author,
          body: firstComment.content ?? "",
          path: thread.threadContext?.filePath || undefined,
          line: thread.threadContext?.rightFileStart?.line ?? undefined,
          isResolved: false,
          createdAt: parseDate(firstComment.publishedDate),
          url: commentUrl,
        });
      }

      return comments;
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      const config = getADOConfigFromPR(pr);

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}/threads`,
      )) as { value: ADOThread[] };

      if (!Array.isArray(data.value)) return [];

      const comments: AutomatedComment[] = [];
      for (const thread of data.value) {
        if (thread.isDeleted) continue;
        const status = thread.status?.toLowerCase();
        if (status === "fixed" || status === "closed" || status === "wontfix") continue;

        const firstComment = thread.comments?.find(
          (c) => !c.isDeleted && c.commentType !== "system",
        );
        if (!firstComment) continue;

        const author = firstComment.author?.displayName ?? "unknown";
        if (!isBot(author)) continue;

        const bodyLower = (firstComment.content ?? "").toLowerCase();
        let severity: AutomatedComment["severity"] = "info";
        if (
          bodyLower.includes("error") ||
          bodyLower.includes("critical") ||
          bodyLower.includes("bug")
        ) {
          severity = "error";
        } else if (
          bodyLower.includes("warning") ||
          bodyLower.includes("suggest") ||
          bodyLower.includes("consider")
        ) {
          severity = "warning";
        }

        const commentUrl = `${config.orgUrl}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repo)}/pullrequest/${pr.number}?_a=files&discussionId=${thread.id}`;

        comments.push({
          id: String(thread.id),
          botName: author,
          body: firstComment.content ?? "",
          path: thread.threadContext?.filePath || undefined,
          line: thread.threadContext?.rightFileStart?.line ?? undefined,
          severity,
          createdAt: parseDate(firstComment.publishedDate),
          url: commentUrl,
        });
      }

      return comments;
    },

    // -----------------------------------------------------------------------
    // Merge Readiness
    // -----------------------------------------------------------------------

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const config = getADOConfigFromPR(pr);

      const blockers: string[] = [];

      const data = (await adoFetch(
        config,
        `/git/repositories/${encodeURIComponent(config.repo)}/pullrequests/${pr.number}`,
      )) as ADOPullRequest;

      // Already completed (merged)?
      if (data.status?.toLowerCase() === "completed") {
        return { mergeable: true, ciPassing: true, approved: true, noConflicts: true, blockers: [] };
      }

      // Draft check
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      // Conflicts
      const mergeStatus = data.mergeStatus?.toLowerCase();
      const noConflicts = mergeStatus === "succeeded" || mergeStatus === undefined || mergeStatus === "notset";
      if (mergeStatus === "conflicts") {
        blockers.push("Merge conflicts");
      } else if (mergeStatus === "rejectedbypolicy") {
        blockers.push("Rejected by branch policy");
      } else if (mergeStatus === "failure") {
        blockers.push("Merge failure");
      }

      // Reviews
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "pending") {
        blockers.push("Review required");
      }

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// =============================================================================
// Plugin Module Export
// =============================================================================

export const manifest = {
  name: "azuredevops",
  slot: "scm" as const,
  description: "SCM plugin: Azure DevOps PRs, CI pipelines, code reviews",
  version: "0.1.0",
};

export function create(): SCM {
  return createAzureDevOpsSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
