import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@agentboard/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
};

const sampleApiIssue = {
  number: 123,
  title: "Fix login bug",
  body: "Users can't log in with SSO",
  html_url: "https://github.com/acme/repo/issues/123",
  state: "open" as const,
  state_reason: null as string | null,
  labels: [{ name: "bug" }, { name: "priority-high" }],
  assignees: [{ login: "alice" }],
};

function mockFetch(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchError(msg = "network error") {
  fetchMock.mockRejectedValueOnce(new Error(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-github-api plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env["GH_TOKEN"] = "test-token";
    tracker = create();
  });

  afterEach(() => {
    delete process.env["GH_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("github-api");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("github-api");
    });
  });

  // ---- token handling ----------------------------------------------------

  describe("token handling", () => {
    it("uses GH_TOKEN when set", async () => {
      process.env["GH_TOKEN"] = "ghp_testtoken";
      mockFetch(200, sampleApiIssue);
      await tracker.getIssue("123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer ghp_testtoken" }),
        }),
      );
    });

    it("falls back to GITHUB_TOKEN", async () => {
      delete process.env["GH_TOKEN"];
      process.env["GITHUB_TOKEN"] = "ghp_fallback";
      mockFetch(200, sampleApiIssue);
      await tracker.getIssue("123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer ghp_fallback" }),
        }),
      );
    });

    it("throws when no token is set", async () => {
      delete process.env["GH_TOKEN"];
      delete process.env["GITHUB_TOKEN"];
      await expect(tracker.getIssue("123", project)).rejects.toThrow("GitHub token not found");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetch(200, sampleApiIssue);
      const issue = await tracker.getIssue("123", project);
      expect(issue).toEqual({
        id: "123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://github.com/acme/repo/issues/123",
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "alice",
      });
    });

    it("calls the correct endpoint", async () => {
      mockFetch(200, sampleApiIssue);
      await tracker.getIssue("123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("strips # prefix from identifier", async () => {
      mockFetch(200, sampleApiIssue);
      await tracker.getIssue("#123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123",
        expect.any(Object),
      );
    });

    it("maps closed state to closed", async () => {
      mockFetch(200, { ...sampleApiIssue, state: "closed", state_reason: "completed" });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps not_planned close reason to cancelled", async () => {
      mockFetch(200, { ...sampleApiIssue, state: "closed", state_reason: "not_planned" });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("cancelled");
    });

    it("handles null body gracefully", async () => {
      mockFetch(200, { ...sampleApiIssue, body: null });
      const issue = await tracker.getIssue("123", project);
      expect(issue.description).toBe("");
    });

    it("handles empty assignees", async () => {
      mockFetch(200, { ...sampleApiIssue, assignees: [] });
      const issue = await tracker.getIssue("123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("throws on non-OK response", async () => {
      mockFetch(404, { message: "Not Found" });
      await expect(tracker.getIssue("999", project)).rejects.toThrow("404");
    });

    it("propagates network errors", async () => {
      mockFetchError("network error");
      await expect(tracker.getIssue("123", project)).rejects.toThrow("network error");
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for closed issues", async () => {
      mockFetch(200, { state: "closed" });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });

    it("returns false for open issues", async () => {
      mockFetch(200, { state: "open" });
      expect(await tracker.isCompleted("123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("42", project)).toBe("https://github.com/acme/repo/issues/42");
    });

    it("strips # prefix from identifier", () => {
      expect(tracker.issueUrl("#42", project)).toBe("https://github.com/acme/repo/issues/42");
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts issue number from URL", () => {
      expect(tracker.issueLabel("https://github.com/acme/repo/issues/42", project)).toBe("#42");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/issue-N format", () => {
      expect(tracker.branchName("42", project)).toBe("feat/issue-42");
    });

    it("strips # prefix", () => {
      expect(tracker.branchName("#42", project)).toBe("feat/issue-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and URL", async () => {
      mockFetch(200, sampleApiIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://github.com/acme/repo/issues/123");
      expect(prompt).toContain("GitHub issue #123");
    });

    it("includes labels when present", async () => {
      mockFetch(200, sampleApiIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes description", async () => {
      mockFetch(200, sampleApiIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when no labels", async () => {
      mockFetch(200, { ...sampleApiIssue, labels: [] });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when body is null", async () => {
      mockFetch(200, { ...sampleApiIssue, body: null });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockFetch(200, [sampleApiIssue, { ...sampleApiIssue, number: 456, title: "Another" }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0]!.id).toBe("123");
      expect(issues[1]!.id).toBe("456");
    });

    it("calls the correct endpoint with state=open by default", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({}, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("state=open");
    });

    it("passes state filter for closed", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({ state: "closed" }, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("state=closed");
    });

    it("passes state filter for all", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({ state: "all" }, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("state=all");
    });

    it("passes label filter", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("labels=bug%2Curgent");
    });

    it("passes assignee filter", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({ assignee: "alice" }, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("assignee=alice");
    });

    it("respects custom limit", async () => {
      mockFetch(200, []);
      await tracker.listIssues!({ limit: 5 }, project);
      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain("per_page=5");
    });

    it("filters out pull requests", async () => {
      const pr = { ...sampleApiIssue, number: 200, pull_request: { url: "..." } };
      mockFetch(200, [sampleApiIssue, pr]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.id).toBe("123");
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("closes an issue via PATCH", async () => {
      mockFetch(200, {}); // PATCH state
      await tracker.updateIssue!("123", { state: "closed" }, project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "closed" }) }),
      );
    });

    it("reopens an issue via PATCH", async () => {
      mockFetch(200, {}); // PATCH state
      await tracker.updateIssue!("123", { state: "open" }, project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "open" }) }),
      );
    });

    it("adds labels (fetches current first, then patches)", async () => {
      mockFetch(200, { ...sampleApiIssue, labels: [{ name: "existing" }] }); // GET current
      mockFetch(200, {}); // PATCH labels
      await tracker.updateIssue!("123", { labels: ["new-label"] }, project);

      // First call: GET
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
      // Second call: PATCH with merged labels
      const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
        labels: string[];
      };
      expect(secondBody.labels).toContain("existing");
      expect(secondBody.labels).toContain("new-label");
    });

    it("removes labels without adding new ones", async () => {
      mockFetch(200, { ...sampleApiIssue, labels: [{ name: "agent:backlog" }, { name: "bug" }] });
      mockFetch(200, {});
      await tracker.updateIssue!("123", { removeLabels: ["agent:backlog"] }, project);

      const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
        labels: string[];
      };
      expect(body.labels).not.toContain("agent:backlog");
      expect(body.labels).toContain("bug");
    });

    it("updates assignee", async () => {
      mockFetch(200, {});
      await tracker.updateIssue!("123", { assignee: "bob" }, project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123",
        expect.objectContaining({ body: JSON.stringify({ assignees: ["bob"] }) }),
      );
    });

    it("posts a comment", async () => {
      mockFetch(200, {});
      await tracker.updateIssue!("123", { comment: "Working on this" }, project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues/123/comments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ body: "Working on this" }),
        }),
      );
    });

    it("handles multiple updates in one call", async () => {
      mockFetch(200, {}); // PATCH state
      mockFetch(200, { ...sampleApiIssue, labels: [] }); // GET labels
      mockFetch(200, {}); // PATCH labels
      mockFetch(200, {}); // POST comment
      await tracker.updateIssue!(
        "123",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      // 4 fetch calls: PATCH state + GET current labels + PATCH labels + POST comment
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue via POST and returns mapped Issue", async () => {
      const created = {
        ...sampleApiIssue,
        number: 999,
        title: "New issue",
        body: "Description",
        html_url: "https://github.com/acme/repo/issues/999",
      };
      mockFetch(201, created);
      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "999", title: "New issue", state: "open" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/repo/issues",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("passes labels and assignee to create endpoint", async () => {
      mockFetch(201, {
        ...sampleApiIssue,
        number: 1000,
        html_url: "https://github.com/acme/repo/issues/1000",
        labels: [{ name: "bug" }],
        assignees: [{ login: "alice" }],
      });
      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice" },
        project,
      );
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        labels: string[];
        assignees: string[];
      };
      expect(body.labels).toEqual(["bug"]);
      expect(body.assignees).toEqual(["alice"]);
    });

    it("throws on API error", async () => {
      mockFetch(422, { message: "Validation Failed" });
      await expect(
        tracker.createIssue!({ title: "Bad", description: "" }, project),
      ).rejects.toThrow("422");
    });
  });
});
