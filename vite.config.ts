import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Source archives and environments without Git still display the package version.
}

export default defineConfig({
  base: "./",
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
});
