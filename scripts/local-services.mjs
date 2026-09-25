import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Local app infrastructure, supervised independently of a terminal or coding task.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agents = join(homedir(), "Library", "LaunchAgents");
const logs = join(root, ".build", "service-logs");
const domain = `gui/${process.getuid()}`;
const services = [
  { name: "api", entry: "index.js" },
  { name: "worker", entry: "worker.js" },
];
const action = process.argv[2] ?? "status";
const selected = process.argv[3];
if (
  ["install", "restart"].includes(action) &&
  existsSync(join(root, ".build/cloud/live.json"))
)
  throw new Error(
    "The live backend is hosted on AWS. Do not start a second signer against the retired local database; follow infra/cloud/README.md for a controlled rollback.",
  );
if (selected && !services.some((service) => service.name === selected))
  throw new Error("Choose api or worker, or omit the service to manage both.");
if (process.platform !== "darwin")
  throw new Error("This supervisor is for macOS.");
if (!["install", "restart", "stop", "status"].includes(action))
  throw new Error(
    "Usage: node scripts/local-services.mjs install|restart|stop|status",
  );
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
function launchctl(args, optional = false) {
  try {
    return execFileSync("/bin/launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (optional) return null;
    throw new Error(
      `launchctl ${args[0]} failed: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
}

async function bootstrap(plist) {
  // launchd can return EIO briefly while a booted-out job finishes graceful shutdown.
  for (let attempt = 0; ; attempt++) {
    try {
      launchctl(["bootstrap", domain, plist]);
      return;
    } catch (error) {
      if (attempt >= 69) throw error;
      await delay(500);
    }
  }
}

if (action === "install") {
  mkdirSync(agents, { recursive: true });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
}
for (const service of services.filter(
  (service) => !selected || service.name === selected,
)) {
  const label = `app.suicapay.local.${service.name}`;
  const target = `${domain}/${label}`;
  const plist = join(agents, `${label}.plist`);
  if (action === "install") {
    const entry = join(root, "apps", "api", "dist", service.entry);
    if (!existsSync(entry))
      throw new Error("Build the API first: npm run build -w @suica/api");
    if (
      existsSync(plist) &&
      !readFileSync(plist, "utf8").includes("Managed by Suica Pay")
    )
      throw new Error(
        `Refusing to overwrite an unmanaged launch agent: ${plist}`,
      );
    const log = join(logs, `${service.name}.log`);
    if (!existsSync(log)) writeFileSync(log, "", { mode: 0o600, flag: "wx" });
    const environment = {
      PATH: [
        dirname(process.execPath),
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    };
    if (process.env.AWS_PROFILE)
      environment.AWS_PROFILE = process.env.AWS_PROFILE;
    const envXML = Object.entries(environment)
      .map(
        ([key, value]) =>
          `<key>${xml(key)}</key><string>${xml(value)}</string>`,
      )
      .join("\n");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Suica Pay scripts/local-services.mjs; secrets remain in the private .env. -->
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${envXML}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
    launchctl(["bootout", target], true);
    writeFileSync(plist, content, { mode: 0o600 });
    execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "pipe" });
    await bootstrap(plist);
    console.log(`Started supervised ${service.name}; log: ${log}`);
  } else if (action === "restart") {
    if (!existsSync(plist))
      throw new Error("Install the local services first.");
    const before = launchctl(["print", target], true);
    const oldPID = before?.match(/^\s*pid = (\d+)$/m)?.[1];
    if (!before) await bootstrap(plist);
    else if (oldPID) launchctl(["kill", "SIGTERM", target], true);
    else launchctl(["kickstart", target]);
    // KeepAlive restarts the gracefully stopped job without a bootout/bootstrap teardown race.
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const after = launchctl(["print", target], true);
      const pid = after?.match(/^\s*pid = (\d+)$/m)?.[1];
      if (pid && pid !== oldPID && /^\s*state = running$/m.test(after)) {
        ready = true;
        console.log(`Restarted ${service.name} (PID ${pid})`);
        break;
      }
      await delay(500);
    }
    if (!ready)
      throw new Error(
        `${service.name} is still stopping or restarting. Inspect its status and private log.`,
      );
  } else if (action === "stop") {
    launchctl(["bootout", target], true);
    console.log(`Stopped ${service.name}`);
  } else {
    const status = launchctl(["print", target], true);
    const state = status?.match(/^\s*state = (.+)$/m)?.[1] ?? "not loaded";
    const pid = status?.match(/^\s*pid = (\d+)$/m)?.[1];
    console.log(`${service.name}: ${state}${pid ? ` (PID ${pid})` : ""}`);
  }
}
