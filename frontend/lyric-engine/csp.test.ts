import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("lets the app's webview compile the lyric engine", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../tauri.conf.json", import.meta.url), "utf8"),
  );
  const scripts = String(config.app.security.csp)
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src"));
  // Without it the engine fails to load and the whole window stays black.
  expect(scripts).toContain("'wasm-unsafe-eval'");
});
