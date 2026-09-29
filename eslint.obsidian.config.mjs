import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["main.js", "node_modules/**", "data.json", "pi-sessions/**", "*.zip"]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.{js,mjs}"],
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          ignoreWords: ["Pi", "PARA"]
        }
      ]
    }
  },
  {
    // These two modules expose the host globals as a documented fallback for
    // environments without a DOM window (the Node test runner). Every UI path
    // reaches its window through resolveActiveWindow() instead, which is why the
    // fallback is confined here rather than spread through the plugin.
    files: ["src/shared/runtime.mjs", "src/pi/yield-scheduler.mjs"],
    rules: {
      "obsidianmd/no-global-this": "off"
    }
  }
];
