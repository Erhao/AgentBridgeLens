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
        { path: "release/*.zip", label: "Chrome extension" },
        { path: "release/*.sha256", label: "SHA256 checksum" },
      ],
      successComment: false,
      failComment: false,
      releasedLabels: false,
    }],
  ],
};
