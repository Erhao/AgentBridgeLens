import { releaseRules } from "./scripts/release/extension-rules.mjs";

export default {
  branches: ["main"],
  tagFormat: "extension-v${version}",
  repositoryUrl: "https://github.com/Erhao/AgentBridgeLens.git",
  plugins: [
    ["@semantic-release/commit-analyzer", {releaseRules}],
    "@semantic-release/release-notes-generator",
    "./scripts/release/extension.mjs",
    ["@semantic-release/github", {
      githubUrl: "https://github.com",
      githubApiUrl: "https://api.github.com",
      assets: [
        { path: "release/agentbridgelens-extension-*.zip", label: "Chrome extension" },
        { path: "release/agentbridgelens-updater.zip", label: "Fixed-directory updater (Windows / macOS / Linux)" },
        { path: "release/*.sha256", label: "SHA256 checksum" },
      ],
      successComment: false,
      failComment: false,
      releasedLabels: false,
    }],
  ],
};
