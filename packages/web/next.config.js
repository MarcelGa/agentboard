/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  transpilePackages: [
    "@agentboard/ao-core",
    "@agentboard/ao-plugin-agent-claude-code",
    "@agentboard/ao-plugin-agent-opencode",
    "@agentboard/ao-plugin-runtime-tmux",
    "@agentboard/ao-plugin-scm-azuredevops",
    "@agentboard/ao-plugin-scm-github",
    "@agentboard/ao-plugin-tracker-github",
    "@agentboard/ao-plugin-tracker-github-api",
    "@agentboard/ao-plugin-tracker-jira",
    "@agentboard/ao-plugin-tracker-linear",
    "@agentboard/ao-plugin-workspace-worktree",
  ],
};

export default nextConfig;
