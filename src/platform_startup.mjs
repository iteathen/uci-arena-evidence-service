import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./config.mjs";
import {
  probeProcessInstance,
  processIdentityFromJson,
  processInstanceIsCurrent,
  sameProcessInstance,
} from "./process_identity.mjs";

import { daemonOwnerFromRecord, readDaemonRecord } from "./daemon_owner_record.mjs";

const execFileAsync = promisify(execFile);
export const windowsTaskName = "UCI Arena Evidence Service";
export const linuxUnitName = "uci-arena-evidence.service";
const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const daemonLockName = "daemon.lock";

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function quoteWindowsArgument(value) {
  const text = String(value);
  if (!text.length) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function daemonArguments(config) {
  const values = [path.resolve(process.execPath), cliPath, "daemon", "--workspace", config.workspace];
  if (config.configFile) values.push("--config", config.configFile);
  return values;
}

export function windowsStartupAction(config) {
  return {
    command: path.resolve(config.nativeLauncher),
    arguments: daemonArguments(config).map(quoteWindowsArgument).join(" "),
    workingDirectory: packageRoot,
  };
}

export function buildWindowsTaskXml(config, userSid) {
  if (!/^S-\d(?:-\d+)+$/.test(userSid)) throw new Error(`invalid Windows SID ${userSid}`);
  const action = windowsStartupAction(config);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Collects low-priority timing and strength evidence for UCI Arena.</Description>
    <URI>\\${windowsTaskName}</URI>
  </RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT15S</Delay><UserId>${xmlEscape(userSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xmlEscape(action.command)}</Command>
    <Arguments>${xmlEscape(action.arguments)}</Arguments>
    <WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

function xmlUnescape(value) {
  return String(value).replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function xmlElement(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "u").exec(xml);
  return match ? xmlUnescape(match[1].trim()) : "";
}

export function windowsTaskActionFromXml(xml) {
  return {
    command: xmlElement(xml, "Command"),
    arguments: xmlElement(xml, "Arguments"),
    workingDirectory: xmlElement(xml, "WorkingDirectory"),
  };
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(String(left)).toLowerCase()
    === path.win32.normalize(String(right)).toLowerCase();
}

export function windowsTaskMatchesConfiguration(xml, config) {
  const actual = windowsTaskActionFromXml(xml);
  const expected = windowsStartupAction(config);
  return sameWindowsPath(actual.command, expected.command)
    && actual.arguments === expected.arguments
    && sameWindowsPath(actual.workingDirectory, expected.workingDirectory);
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : null;
  }
}

async function readDaemonOwner(config) {
  const packet = await readDaemonRecord(path.join(config.paths.locks, daemonLockName));
  return packet ? daemonOwnerFromRecord(packet) : null;
}

export async function readDaemonOwnerPid(config) {
  return (await readDaemonOwner(config))?.pid ?? null;
}

export async function waitForProcessExit(
  pid,
  {
    timeoutMs = 2_000,
    pollMs = 25,
    alive = processAlive,
    identity = null,
    probe = probeProcessInstance,
    now = () => performance.now(),
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(pollMs) || pollMs <= 0) return false;
  const hasIdentity = identity !== null && identity !== undefined;
  const expected = hasIdentity ? processIdentityFromJson(identity, pid) : null;
  if (hasIdentity && !expected) return false;
  const deadline = now() + Math.min(timeoutMs, 2_000);
  while (true) {
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) return false;
    if (expected) {
      const observed = probe(pid, { timeoutMs: remaining });
      if (now() > deadline) return false;
      if (observed?.state === "absent") return true;
      const actual = observed?.state === "present"
        ? processIdentityFromJson(observed.identity, pid) : null;
      if (!actual) return false;
      if (!sameProcessInstance(expected, actual)) return true;
    } else {
      const stillAlive = alive(pid);
      if (now() > deadline) return false;
      if (stillAlive === false) return true;
      if (stillAlive !== true) return false;
    }
    const delayMs = Math.min(pollMs, deadline - now());
    if (delayMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function waitForDaemonActive(config, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const owner = await readDaemonOwner(config);
    if (owner?.identity && processInstanceIsCurrent(owner.identity)) return owner.pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return null;
}

async function removeDeadDaemonLock(config, expected) {
  if (!expected?.pid) return;
  if (expected.identity && processInstanceIsCurrent(expected.identity)) return;
  const filename = path.join(config.paths.locks, daemonLockName);
  const current = await readDaemonOwner(config);
  if (!current || current.raw !== expected.raw) return;
  const retired = `${filename}.retired-${process.pid}-${randomUUID()}`;
  try {
    await rename(filename, retired);
    await rm(retired, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function systemdQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("systemd arguments cannot contain control lines");
  return `"${text.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function linuxUserUnitPath(environment = process.env) {
  const configRoot = environment.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), ".config");
  return path.join(configRoot, "systemd", "user", linuxUnitName);
}

export function buildLinuxUserUnit(config) {
  const command = daemonArguments(config).map(systemdQuote).join(" ");
  return `[Unit]
Description=UCI Arena Evidence Service
After=default.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdQuote(packageRoot)}
Restart=on-failure
RestartSec=60
Nice=15
CPUWeight=10
IOWeight=10
OOMScoreAdjust=500
UMask=0077
KillMode=control-group
TimeoutStopSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

async function currentUserSid() {
  const { stdout } = await execFileAsync(
    "whoami.exe",
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true, timeout: 5_000 },
  );
  const match = /"[^"]+","(S-\d(?:-\d+)+)"/.exec(stdout.trim());
  if (!match) throw new Error("could not determine current Windows user SID");
  return match[1];
}

async function windowsStatus(config) {
  try {
    const { stdout } = await execFileAsync(
      "schtasks.exe",
      ["/Query", "/TN", windowsTaskName, "/XML"],
      { windowsHide: true, timeout: 10_000 },
    );
    const action = windowsTaskActionFromXml(stdout);
    const daemon = await readDaemonOwner(config);
    return {
      platform: "windows",
      installed: true,
      taskName: windowsTaskName,
      active: Boolean(daemon?.identity && processInstanceIsCurrent(daemon.identity)),
      matchesCurrentConfiguration: windowsTaskMatchesConfiguration(stdout, config),
      action,
    };
  } catch (error) {
    if (error.code === 1) return { platform: "windows", installed: false, taskName: windowsTaskName };
    throw error;
  }
}

async function installWindows(config) {
  if (!config.nativeLauncherAvailable) {
    throw new Error(`windowless launcher is unavailable: ${config.nativeLauncher}`);
  }
  await uninstallWindows(config);
  const sid = await currentUserSid();
  const xml = buildWindowsTaskXml(config, sid);
  const temporary = path.join(config.paths.locks, `startup-${process.pid}.xml`);
  await writeFile(temporary, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(xml, "utf16le"),
  ]));
  try {
    await execFileAsync(
      "schtasks.exe",
      ["/Create", "/TN", windowsTaskName, "/XML", temporary, "/F"],
      { windowsHide: true, timeout: 20_000 },
    );
    await execFileAsync(
      "schtasks.exe",
      ["/Run", "/TN", windowsTaskName],
      { windowsHide: true, timeout: 10_000 },
    );
    if (!await waitForDaemonActive(config)) {
      throw new Error("Evidence startup task did not produce a live daemon within five seconds");
    }
  } finally {
    await rm(temporary, { force: true });
  }
  const evidence = {
    schema: "uci_arena_evidence_startup_v1",
    platform: "windows",
    installed_at: new Date().toISOString(),
    action: windowsStartupAction(config),
  };
  await writeFile(
    path.join(config.workspace, "startup-task.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  const status = await windowsStatus(config);
  if (!status.active || !status.matchesCurrentConfiguration) {
    throw new Error("Evidence startup task is not active with the current configuration");
  }
  return status;
}

async function uninstallWindows(config) {
  const daemon = await readDaemonOwner(config);
  try {
    await execFileAsync("schtasks.exe", ["/End", "/TN", windowsTaskName], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {}
  if (daemon?.pid && !await waitForProcessExit(daemon.pid, { identity: daemon.identity })) {
    throw new Error(`Evidence daemon ${daemon.pid} did not stop within two seconds`);
  }
  await removeDeadDaemonLock(config, daemon);
  try {
    await execFileAsync("schtasks.exe", ["/Delete", "/TN", windowsTaskName, "/F"], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  await rm(path.join(config.workspace, "startup-task.json"), { force: true });
  return { platform: "windows", installed: false, taskName: windowsTaskName };
}

async function linuxStatus(config) {
  const unitPath = linuxUserUnitPath();
  if (!existsSync(unitPath)) {
    return { platform: "linux", installed: false, unitName: linuxUnitName, unitPath };
  }
  let enabled = false;
  let active = false;
  try {
    await execFileAsync("systemctl", ["--user", "is-enabled", "--quiet", linuxUnitName], {
      timeout: 10_000,
    });
    enabled = true;
  } catch {}
  try {
    await execFileAsync("systemctl", ["--user", "is-active", "--quiet", linuxUnitName], {
      timeout: 10_000,
    });
    active = true;
  } catch {}
  let matchesCurrentConfiguration = false;
  try {
    matchesCurrentConfiguration = await readFile(unitPath, "utf8")
      === buildLinuxUserUnit(config);
  } catch {}
  return {
    platform: "linux",
    installed: true,
    enabled,
    active,
    matchesCurrentConfiguration,
    unitName: linuxUnitName,
    unitPath,
  };
}

async function installLinux(config) {
  await uninstallLinux(config);
  const unitPath = linuxUserUnitPath();
  await mkdir(path.dirname(unitPath), { recursive: true });
  await writeFile(unitPath, buildLinuxUserUnit(config), "utf8");
  await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
  await execFileAsync("systemctl", ["--user", "enable", "--now", linuxUnitName], {
    timeout: 20_000,
  });
  const evidence = {
    schema: "uci_arena_evidence_startup_v1",
    platform: "linux",
    installed_at: new Date().toISOString(),
    unit_name: linuxUnitName,
    unit_path: unitPath,
  };
  await writeFile(
    path.join(config.workspace, "startup-task.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  const status = await linuxStatus(config);
  if (!status.enabled || !status.active || !status.matchesCurrentConfiguration) {
    throw new Error("Evidence systemd user service is not active with the current configuration");
  }
  return status;
}

async function uninstallLinux(config) {
  try {
    await execFileAsync("systemctl", ["--user", "disable", "--now", linuxUnitName], {
      timeout: 20_000,
    });
  } catch {}
  await rm(linuxUserUnitPath(), { force: true });
  await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10_000 });
  await rm(path.join(config.workspace, "startup-task.json"), { force: true });
  return { platform: "linux", installed: false, unitName: linuxUnitName };
}

export async function startupStatus(config) {
  if (process.platform === "win32") return windowsStatus(config);
  if (process.platform === "linux") return linuxStatus(config);
  throw new Error(`startup registration is unsupported on ${process.platform}`);
}

export async function installStartup(config) {
  if (process.platform === "win32") return installWindows(config);
  if (process.platform === "linux") return installLinux(config);
  throw new Error(`startup registration is unsupported on ${process.platform}`);
}

export async function recoverStartup(config, {
  platform = process.platform,
  statusImpl = startupStatus,
  executeImpl = execFileAsync,
  waitForActiveImpl = waitForDaemonActive,
} = {}) {
  const registered = await statusImpl(config);
  if (!registered.installed) throw new Error("Evidence startup is not registered");
  if (registered.matchesCurrentConfiguration !== true) {
    throw new Error("Evidence startup registration does not match the current configuration");
  }
  if (registered.enabled === false) throw new Error("Evidence startup registration is disabled");
  if (platform === "win32") {
    await executeImpl("schtasks.exe", ["/Run", "/TN", windowsTaskName], {
      windowsHide: true,
      timeout: 10_000,
    });
  } else if (platform === "linux") {
    await executeImpl("systemctl", ["--user", "start", linuxUnitName], {
      timeout: 20_000,
    });
  } else {
    throw new Error(`startup recovery is unsupported on ${platform}`);
  }
  if (!await waitForActiveImpl(config)) {
    throw new Error("Evidence startup recovery did not produce a live daemon within five seconds");
  }
  return {
    ...(await statusImpl(config)),
    recoveryRequested: true,
    registrationMutated: false,
  };
}

export async function uninstallStartup(config) {
  if (process.platform === "win32") return uninstallWindows(config);
  if (process.platform === "linux") return uninstallLinux(config);
  throw new Error(`startup registration is unsupported on ${process.platform}`);
}

export async function readStartupEvidence(config) {
  try {
    return JSON.parse(await readFile(path.join(config.workspace, "startup-task.json"), "utf8"));
  } catch {
    return null;
  }
}
