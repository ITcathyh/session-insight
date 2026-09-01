import reactConfig from "@session-explorer/eslint-config/react";

export default [
  ...reactConfig,
  { ignores: ["dist/", "**/playwright.config.ts"], rules: { "react-hooks/exhaustive-deps": "off" } },
];
