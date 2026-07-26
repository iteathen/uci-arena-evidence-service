import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, output] = process.argv.slice(2);
if (mode === "grandchild") {
  setInterval(() => {}, 1_000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", output], {
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(output, `${JSON.stringify({ parent: process.pid, child: child.pid })}\n`, "utf8");
  setInterval(() => {}, 1_000);
}
