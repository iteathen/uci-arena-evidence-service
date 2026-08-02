import assert from "node:assert/strict";
import test from "node:test";

import { validateWindowsRuntimeOwnership } from "../tools/release/component_release.mjs";

test("Windows release closure accepts application-local VC runtimes", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "services/evidence-service/native/uci_arena_background_guard.exe" },
    { path: "services/evidence-service/native/msvcp140.dll" },
    { path: "services/evidence-service/native/vcruntime140.dll" },
  ], "windows-x86_64"));
});

test("Windows release closure rejects OS-owned runtime files", () => {
  for (const relative of [
    "services/evidence-service/native/api-ms-win-core-file-l1-1-0.dll",
    "services/evidence-service/native/ext-ms-win-ntuser-window-l1-1-0.dll",
    "services/evidence-service/native/ucrtbase.dll",
    "services/evidence-service/native/System32/kernel32.dll",
  ]) {
    assert.throws(
      () => validateWindowsRuntimeOwnership([{ path: relative }], "windows-x86_64"),
      /OS-owned Windows runtime files/u,
    );
  }
});

test("non-Windows release closure does not apply Windows ownership policy", () => {
  assert.doesNotThrow(() => validateWindowsRuntimeOwnership([
    { path: "fixture/ucrtbase.dll" },
  ], "linux-x86_64"));
});
