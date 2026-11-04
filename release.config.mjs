export default {
  branches: ["main"],
  tagFormat: "extension-v${version}",
  repositoryUrl: "https://github.com/Erhao/AgentBridgeLens.git",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "./scripts/release/extension.mjs",
    ["@semantic-release/github", {
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
