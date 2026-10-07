import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";
import queryContract from "@uci-arena/background-service-runtime/process-instance-query-contract" with { type: "json" };

const execFileAsync = promisify(execFile);
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeBin = path.join(repositoryRoot, "native", "bin");
const guard = path.join(nativeBin, "uci_arena_background_guard.exe");
const launcher = path.join(nativeBin, "uci_arena_service_launcher.exe");

test("Windows native service helpers execute their packaged probes", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native helper contract");
  if (!existsSync(guard) || !existsSync(launcher)) {
    return t.skip("native service helpers are not built");
  }

  const guardResult = await execFileAsync(guard, ["--probe"], {
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(
    JSON.parse(guardResult.stdout).schema,
    "uci_arena_background_service_native_probe_v1",
  );
  assert.ok(JSON.parse(guardResult.stdout).capabilities.includes(queryContract.capability));
  const query = new NativeResourceHelper({ nativeHelper: guard, nativeHelperAvailable: true });
  const current = query.queryProcessInstanceSync(process.pid);
  assert.equal(current.state, "present");
  assert.equal(current.identity.pid, process.pid);
  assert.equal(current.identity.executable_path.toLowerCase(), process.execPath.toLowerCase());

  const launcherResult = await execFileAsync(launcher, ["--probe"], {
    timeout: 5_000,
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(launcherResult.stdout), {
    schema: "uci_arena_service_launcher_probe_v1",
    windows_gui_subsystem: true,
    create_no_window: true,
    persistent_restart: true,
    initial_restart_delay_ms: 5_000,
    maximum_restart_delay_ms: 300_000,
  });
});
