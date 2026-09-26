import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "suica-world-native-"));
try {
  execFileSync(
    "swift",
    ["build", "--package-path", "tools/world-native-smoke"],
    { cwd: root, stdio: "inherit" },
  );
  const context = join(temporary, "context.json");
  execFileSync(
    join(root, "node_modules/.bin/tsx"),
    ["scripts/qa/create-native-world-context.mts", context],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(
    "swift",
    [
      "run",
      "--skip-build",
      "--package-path",
      "tools/world-native-smoke",
      "WorldNativeSmoke",
      context,
    ],
    { cwd: root, stdio: "inherit" },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
