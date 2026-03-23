/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@composio/ao-core",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-opencode",
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-scm-azuredevops",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-github-api",
    "@composio/ao-plugin-tracker-jira",
    "@composio/ao-plugin-tracker-linear",
    "@composio/ao-plugin-workspace-worktree",
  ],
};

export default nextConfig;
