export default {
  testRunner: "command",
  commandRunner: {
    command: "npm run build && node --test dist/*.test.js",
  },
  mutate: ["src/rateLimit.ts", "src/security.ts"],
  reporters: ["clear-text", "html", "json"],
  coverageAnalysis: "off",
  thresholds: { high: 80, low: 60, break: 75 },
};
