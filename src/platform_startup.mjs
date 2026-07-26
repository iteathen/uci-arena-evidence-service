import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "./config.mjs";

const execFileAsync = promisify(execFile);
export const windowsTaskName = "UCI Arena Evidence Service";
export const linuxUnitName = "uci-arena-evidence.service";
const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));

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
    workingDirectory: repositoryRoot,
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
WorkingDirectory=${systemdQuote(repositoryRoot)}
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
    await execFileAsync(
      "schtasks.exe",
      ["/Query", "/TN", windowsTaskName],
      { windowsHide: true, timeout: 10_000 },
    );
    return {
      platform: "windows",
      installed: true,
      taskName: windowsTaskName,
      action: windowsStartupAction(config),
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
  return windowsStatus(config);
}

async function uninstallWindows(config) {
  try {
    await execFileAsync("schtasks.exe", ["/End", "/TN", windowsTaskName], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {}
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

async function linuxStatus() {
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
  return { platform: "linux", installed: true, enabled, active, unitName: linuxUnitName, unitPath };
}

async function installLinux(config) {
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
  return linuxStatus();
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
