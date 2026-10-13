//! Keeps inyon running without a terminal window: a user service that starts at login and comes
//! back if it stops (systemd on Linux, launchd on macOS, a logon task on Windows). No admin
//! rights, nothing outside your home folder. The program copies itself into ~/.inyon/bin first,
//! so the download can be deleted.
//!
//! One program does three jobs, each its own service:
//! - link: the phone link (`inyon setup` or `inyon pair`)
//! - node: an outbound connection to an Inyon hub (the hub's "Add a machine" command)
//! - hub: the hub itself (`get.sh --hub`, Linux and macOS)
//!
//! The units run `~/.inyon/bin/inyon link|connect|hub`: this program, which hands the job to the
//! engine. Units written by earlier versions name the same file, so they keep working.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{basename, bin_dir, home, installed_binary, node_dir, NAME};
use crate::sys::{self, run, run_with_stdin, which, Platform, Proc, Signal};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
    Link,
    Node,
    Hub,
}

pub const ROLES: [Role; 3] = [Role::Link, Role::Node, Role::Hub];

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Link => "link",
            Role::Node => "node",
            Role::Hub => "hub",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "link" => Some(Role::Link),
            "node" => Some(Role::Node),
            "hub" => Some(Role::Hub),
            _ => None,
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// The Android application id, which launchd labels are named after.
pub const APP_ID: &str = "tech.abhashchakraborty.inyon";

struct Spec {
    unit: &'static str,
    label: &'static str,
    task: Option<&'static str>,
    args: &'static [&'static str],
    what: &'static str,
}

const fn spec(role: Role) -> Spec {
    match role {
        Role::Link => Spec { unit: "inyon-link", label: "tech.abhashchakraborty.inyon.link", task: Some("Inyon link"), args: &["link"], what: "Inyon phone link" },
        Role::Node => Spec {
            unit: "inyon-node",
            label: "tech.abhashchakraborty.inyon.node",
            task: Some("Inyon node"),
            args: &["connect"],
            what: "Inyon node (outbound connection to your Inyon hub)",
        },
        Role::Hub => Spec { unit: "inyon-hub", label: "tech.abhashchakraborty.inyon.hub", task: None, args: &["hub"], what: "Inyon hub" },
    }
}

const UPDATE_TASK: &str = "Inyon update";

/// How each job was set up when this program was tether-node, before the rename to Inyon. Both
/// of its installers named their systemd unit tether-node.service; what the unit runs says which job.
struct Old {
    unit: Option<&'static str>,
    label: Option<&'static str>,
    task: Option<&'static str>,
    shortcut: Option<&'static str>,
    cron: Option<&'static str>,
}

const fn old(role: Role) -> Old {
    match role {
        Role::Link => Old { unit: Some("tether-node"), label: Some("dev.tether.node-link"), task: Some("Tether link"), shortcut: None, cron: Some("# tether-node link") },
        Role::Node => Old { unit: Some("tether-node"), label: Some("dev.tether.node"), task: Some("Tether node"), shortcut: Some("Tether node.lnk"), cron: None },
        Role::Hub => Old { unit: Some("tether-hub"), label: None, task: None, shortcut: None, cron: None },
    }
}

/// What the service code needs to know about the machine it runs on. Tests pass a fake process
/// table and whichever platform they're checking.
pub struct Sys<'a> {
    pub platform: Platform,
    pub proc: &'a dyn Proc,
    /// this process, which is never stopped
    pub pid: u32,
    /// the command that runs this program
    pub program: Vec<String>,
}

impl<'a> Sys<'a> {
    pub fn new(proc: &'a dyn Proc) -> Self {
        Sys { platform: Platform::current(), proc, pid: std::process::id(), program: self_command() }
    }
}

/// The command that runs this program: the binary itself.
pub fn self_command() -> Vec<String> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| NAME.to_string());
    vec![exe]
}

pub fn unit_file(name: &str) -> PathBuf {
    home().join(".config").join("systemd").join("user").join(format!("{name}.service"))
}

pub fn plist_file(label: &str) -> PathBuf {
    home().join("Library").join("LaunchAgents").join(format!("{label}.plist"))
}

/// Where a job writes its log when nothing else keeps it (launchd, nohup).
pub fn log_file(role: Role) -> PathBuf {
    node_dir().join(format!("{role}.log"))
}

/// The PID of a job started in the background where there are no user services.
fn pid_file(role: Role) -> PathBuf {
    node_dir().join(format!("{role}.pid"))
}

fn cron_mark(role: Role) -> String {
    format!("# inyon {role}")
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// systemd splits ExecStart on spaces; quote each argument
fn sdq(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn psq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ps(script: &str) -> sys::Output {
    run(&["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Copies this program into ~/.inyon/bin when it runs from somewhere else (a download, a
/// build), so the service points at a file that stays.
pub fn settle(cmd: &[String]) -> Vec<String> {
    let target = installed_binary();
    let Some(first) = cmd.first() else {
        return cmd.to_vec();
    };
    let same = fs::canonicalize(first).ok() == fs::canonicalize(&target).ok() && target.exists();
    if same || Path::new(first) == target {
        return cmd.to_vec();
    }
    let _ = fs::create_dir_all(bin_dir());
    // a running copy can't be overwritten on Windows, but it can be renamed out of the way
    if target.exists() && fs::remove_file(&target).is_err() {
        let _ = fs::rename(&target, format!("{}.old-{}", path_str(&target), crate::state::now_ms() as u64));
    }
    let download = PathBuf::from(format!("{}.download", path_str(&target)));
    if fs::copy(first, &download).is_err() {
        return cmd.to_vec();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&download, fs::Permissions::from_mode(0o755));
    }
    if fs::rename(&download, &target).is_err() {
        return cmd.to_vec();
    }
    vec![path_str(&target)]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub ok: bool,
    /// how it was set up, or why it couldn't be
    pub how: String,
}

fn ok(how: impl Into<String>) -> Installed {
    Installed { ok: true, how: how.into() }
}

fn failed(how: impl Into<String>) -> Installed {
    Installed { ok: false, how: how.into() }
}

fn startup_shortcut(name: &str) -> String {
    format!("(Join-Path ([Environment]::GetFolderPath('Startup')) {})", psq(name))
}

/// Whether `role` is set up to run in the background here, under its own name or the old one.
pub fn has_service(sys: &Sys, role: Role) -> bool {
    let s = spec(role);
    let o = old(role);
    match sys.platform {
        Platform::Linux => unit_file(s.unit).exists() || old_unit_for(role).is_some() || pid_file(role).exists(),
        Platform::Darwin => plist_file(s.label).exists() || o.label.is_some_and(|l| plist_file(l).exists()),
        Platform::Windows => {
            let Some(task) = s.task else { return false };
            let names = [Some(task), o.task].into_iter().flatten().map(psq).collect::<Vec<_>>().join(", ");
            let startup = format!("(Test-Path {})", startup_shortcut(&format!("{task}.lnk")));
            ps(&format!("if (({names} | ForEach-Object {{ Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }}) -or {startup}) {{ exit 0 }} else {{ exit 1 }}")).ok
        }
        Platform::Other => false,
    }
}

/// Installs and starts `role` as a user service; `restart` replaces a copy that's already running.
pub fn install_service(sys: &Sys, role: Role, restart: bool) -> Installed {
    let s = spec(role);
    let cmd = settle(&sys.program);
    let args: Vec<String> = cmd.iter().cloned().chain(s.args.iter().map(|a| a.to_string())).collect();
    match sys.platform {
        Platform::Linux => {
            if !run(&["systemctl", "--user", "show-environment"]).ok {
                return background(sys, role, &args);
            }
            let file = unit_file(s.unit);
            if let Some(dir) = file.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let exec = args.iter().map(|a| sdq(a)).collect::<Vec<_>>().join(" ");
            let text = format!(
                "[Unit]\nDescription={}\nAfter=network-online.target\n\n[Service]\nExecStart={exec}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
                s.what
            );
            if let Err(err) = fs::write(&file, text) {
                return failed(format!("couldn't write {} ({err})", path_str(&file)));
            }
            run(&["systemctl", "--user", "daemon-reload"]);
            let unit = format!("{}.service", s.unit);
            let r = run(&["systemctl", "--user", "enable", "--now", &unit]);
            if !r.ok {
                return failed(if r.out.is_empty() { "systemctl refused".to_string() } else { r.out });
            }
            // enable --now leaves a running unit alone
            if restart {
                run(&["systemctl", "--user", "restart", &unit]);
            }
            // keeps it running while you're logged out (allowed for your own user on most systems)
            run(&["loginctl", "enable-linger", &sys::username()]);
            ok(format!("a user service that starts again by itself after a restart (systemctl --user status {})", s.unit))
        }
        Platform::Darwin => {
            let file = plist_file(s.label);
            if let Some(dir) = file.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::create_dir_all(node_dir());
            let log = xml(&path_str(&log_file(role)));
            let program = args.iter().map(|a| format!("<string>{}</string>", xml(a))).collect::<String>();
            let text = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>{}</string>\n  <key>ProgramArguments</key><array>{program}</array>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>{log}</string>\n  <key>StandardErrorPath</key><string>{log}</string>\n</dict></plist>\n",
                s.label
            );
            if let Err(err) = fs::write(&file, text) {
                return failed(format!("couldn't write {} ({err})", path_str(&file)));
            }
            let f = path_str(&file);
            run(&["launchctl", "unload", &f]);
            let r = run(&["launchctl", "load", "-w", &f]);
            if !r.ok {
                return failed(if r.out.is_empty() { "launchctl refused".to_string() } else { r.out });
            }
            ok("a login item that starts again by itself when you sign in")
        }
        Platform::Windows => {
            let Some(task) = s.task else {
                return failed("the hub runs on Linux and macOS (on Windows, use WSL)");
            };
            // a logon task, started hidden through PowerShell so no console window shows.
            // Start-Process waits for it either way: a hub builds its copies without a console
            let (exe, rest) = args.split_first().expect("a program to run");
            let list = rest.iter().map(|a| psq(a)).collect::<Vec<_>>().join(", ");
            let argument = format!("-NoProfile -WindowStyle Hidden -Command \"Start-Process -FilePath {} -ArgumentList {list} -WindowStyle Hidden -Wait\"", psq(exe));
            let shortcut = startup_shortcut(&format!("{task}.lnk"));
            let stop =
                if restart { format!("Stop-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue\n{}\n", psq(task), stop_copies(sys, Some(role))) } else { String::new() };
            let script = format!(
                "$ErrorActionPreference='Stop'\n{stop}try {{\n  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument {arg}\n  $t = New-ScheduledTaskTrigger -AtLogOn -User \"$env:USERDOMAIN\\$env:USERNAME\"\n  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew\n  $p = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive -RunLevel Limited\n  Register-ScheduledTask -TaskName {name} -Action $a -Trigger $t -Settings $s -Principal $p -Description {what} -Force | Out-Null\n  Start-ScheduledTask -TaskName {name}\n  'task'\n}} catch {{\n  # tasks blocked by policy: a shortcut in the Startup folder, and started now\n  $l = (New-Object -ComObject WScript.Shell).CreateShortcut({shortcut})\n  $l.TargetPath = 'powershell.exe'\n  $l.Arguments = {arg}\n  $l.WindowStyle = 7\n  $l.Save()\n  Start-Process -FilePath {exe} -ArgumentList {list} -WindowStyle Hidden\n  'startup'\n}}",
                arg = psq(&argument),
                name = psq(task),
                what = psq(s.what),
                exe = psq(exe),
            );
            let r = ps(&script);
            if !r.ok {
                return failed(r.out.lines().next().filter(|l| !l.is_empty()).unwrap_or("Task Scheduler refused").to_string());
            }
            if r.out.trim().ends_with("startup") {
                ok("a program that starts when you sign in (Task Scheduler is blocked here, so from the Startup folder)")
            } else {
                ok(format!("a task that starts again by itself when you sign in (\"{task}\" in Task Scheduler)"))
            }
        }
        Platform::Other => failed(format!("{} isn't supported for a background service", sys.platform.name())),
    }
}

/// PowerShell that stops the other copies of this program doing `role`'s job (every job when
/// none is given), under either program name and renamed aside by an update or not. Never this
/// process. tether-node's installers started the hub connection with no arguments.
fn stop_copies(sys: &Sys, role: Option<Role>) -> String {
    let line = "(Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\").CommandLine";
    let job = match role {
        Some(Role::Node) => format!(" -and {line} -notmatch '\\s\"?(link|hub|migrate|update)\"?(\\s|$)'"),
        Some(r) => format!(" -and {line} -match '\\s\"?{}\"?\\s*$'", spec(r).args[0]),
        None => String::new(),
    };
    format!(
        "Get-Process -Name '{NAME}', 'tether-node' -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne {}{job} }} | Stop-Process -Force -ErrorAction SilentlyContinue",
        sys.pid
    )
}

/// No user services (a container, a minimal server): start it detached now, and from cron at
/// boot when cron is there. Our crontab line is marked so it can be found and removed again.
/// Each start writes its PID to ~/.inyon/node/<role>.pid, so uninstall can stop that process and
/// no other.
fn background(sys: &Sys, role: Role, args: &[String]) -> Installed {
    let _ = fs::create_dir_all(node_dir());
    // installing again replaces the copy started last time instead of adding another
    if let Err(note) = stop_background(sys, role) {
        return failed(note);
    }
    let line = format!(
        "nohup {} >> {} 2>&1 < /dev/null & echo $! > {}",
        args.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" "),
        shq(&path_str(&log_file(role))),
        shq(&path_str(&pid_file(role)))
    );
    if !run(&["sh", "-c", &line]).ok {
        return failed("this system has no user services and inyon couldn't start in the background");
    }
    let again = match role {
        Role::Hub => "`inyon hub start`",
        Role::Link => "`inyon pair`",
        Role::Node => "`inyon service install node`",
    };
    if which("crontab").is_none() {
        return ok(format!("a background process (no user services or cron here, so run {again} again after a restart)"));
    }
    let current = run(&["crontab", "-l"]).out;
    let mark = cron_mark(role);
    let mut kept: Vec<String> = current.lines().filter(|l| !l.is_empty() && !l.contains(&mark) && !l.to_lowercase().starts_with("no crontab")).map(String::from).collect();
    kept.push(format!("@reboot {line} {mark}"));
    kept.push(String::new());
    let r = run_with_stdin(&["crontab", "-"], Some(&kept.join("\n")));
    if r.ok {
        ok("a background process that cron starts again after a restart")
    } else {
        ok(format!("a background process (cron refused the restart entry, so run {again} again after a restart)"))
    }
}

/// True while `pid` runs this program as `role` (a PID can be reused once it has exited).
pub fn is_role_process(sys: &Sys, pid: u32, role: Role) -> bool {
    if pid <= 1 {
        return false;
    }
    let Some(args) = sys.proc.cmdline(pid) else {
        return false;
    };
    if !args.iter().any(|a| {
        let b = basename(a);
        b.starts_with("inyon") || b.starts_with("tether-node")
    }) {
        return false;
    }
    let last = args.last().map(String::as_str).unwrap_or("");
    // tether-node's installers started the hub connection with no arguments
    if role == Role::Node {
        return last == "connect" || !["link", "hub", "migrate", "update"].contains(&last);
    }
    last == spec(role).args[spec(role).args.len() - 1]
}

fn stop_pid(sys: &Sys, pid: u32, role: Role) -> Result<(), String> {
    let stop_with = |sig: Signal, ms: u64| {
        sys.proc.signal(pid, sig);
        let mut waited = 0;
        while waited < ms && is_role_process(sys, pid, role) {
            sys.proc.sleep_ms(100);
            waited += 100;
        }
    };
    if is_role_process(sys, pid, role) {
        stop_with(Signal::Term, 3000);
    }
    if is_role_process(sys, pid, role) {
        stop_with(Signal::Kill, 1000);
    }
    if is_role_process(sys, pid, role) {
        return Err(format!("the background {role} (PID {pid}) didn't stop"));
    }
    Ok(())
}

/// Stops the background process recorded for `role`, after checking it's still that job.
fn stop_background(sys: &Sys, role: Role) -> Result<(), String> {
    let file = pid_file(role);
    let Some(pid) = fs::read_to_string(&file).ok().and_then(|t| t.trim().parse::<u32>().ok()) else {
        return Ok(());
    };
    stop_pid(sys, pid, role)?;
    let _ = fs::remove_file(&file);
    Ok(())
}

/// Removes the crontab lines carrying `mark`; says why when crontab refuses.
fn drop_cron(mark: &str) -> Option<String> {
    which("crontab")?;
    let current = run(&["crontab", "-l"]).out;
    if !current.contains(mark) {
        return None;
    }
    let kept: Vec<&str> = current.lines().filter(|l| !l.is_empty() && !l.contains(mark) && !l.to_lowercase().starts_with("no crontab")).collect();
    let text = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
    if run_with_stdin(&["crontab", "-"], Some(&text)).ok {
        None
    } else {
        Some("its restart entry couldn't be removed from your crontab (crontab -e)".to_string())
    }
}

/// Stops and removes `role`'s service (pairings and keys stay; `inyon forget` unpairs phones).
pub fn uninstall_service(sys: &Sys, role: Role) -> Installed {
    let s = spec(role);
    match sys.platform {
        Platform::Linux => {
            let unit = format!("{}.service", s.unit);
            run(&["systemctl", "--user", "disable", "--now", &unit]);
            let _ = fs::remove_file(unit_file(s.unit));
            run(&["systemctl", "--user", "daemon-reload"]);
            let mut problems = Vec::new();
            if let Err(note) = stop_background(sys, role) {
                problems.push(note);
            }
            if let Some(note) = drop_cron(&cron_mark(role)) {
                problems.push(note);
            }
            if !problems.is_empty() {
                return failed(problems.join("; "));
            }
            ok("the background service is removed")
        }
        Platform::Darwin => {
            let file = plist_file(s.label);
            run(&["launchctl", "unload", "-w", &path_str(&file)]);
            let _ = fs::remove_file(&file);
            ok("the login item is removed")
        }
        Platform::Windows => {
            let Some(task) = s.task else {
                return failed("nothing to remove");
            };
            ps(&format!(
                "Stop-ScheduledTask -TaskName {t} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName {t} -Confirm:$false -ErrorAction SilentlyContinue\nRemove-Item -Force -ErrorAction SilentlyContinue {shortcut}\n{stop}",
                t = psq(task),
                shortcut = startup_shortcut(&format!("{task}.lnk")),
                stop = stop_copies(sys, Some(role))
            ));
            ok("the logon task is removed")
        }
        Platform::Other => failed("nothing to remove"),
    }
}

/// Restarts `role`'s service so a new file runs. `cmd` is how the installed program runs. A job
/// still set up under its name from before the rename to Inyon is restarted under that name.
pub fn restart_service(sys: &Sys, role: Role, cmd: &[String]) -> Installed {
    let s = spec(role);
    let o = old(role);
    match sys.platform {
        Platform::Linux => {
            for unit in [Some(s.unit), old_unit_for(role)].into_iter().flatten() {
                if !unit_file(unit).exists() {
                    continue;
                }
                let r = run(&["systemctl", "--user", "restart", &format!("{unit}.service")]);
                return if r.ok { ok(format!("systemctl --user restart {unit}")) } else { failed(if r.out.is_empty() { "systemctl refused".to_string() } else { r.out }) };
            }
        }
        Platform::Darwin => {
            for label in [Some(s.label), o.label].into_iter().flatten() {
                let file = plist_file(label);
                if !file.exists() {
                    continue;
                }
                if run(&["launchctl", "kickstart", "-k", &format!("gui/{}/{label}", sys::uid())]).ok {
                    return ok(format!("launchctl kickstart {label}"));
                }
                let f = path_str(&file);
                run(&["launchctl", "unload", &f]);
                let r = run(&["launchctl", "load", "-w", &f]);
                return if r.ok { ok(format!("launchctl load {label}")) } else { failed(if r.out.is_empty() { "launchctl refused".to_string() } else { r.out }) };
            }
        }
        Platform::Windows => {
            if let Some(task) = s.task {
                // a running copy of the old program (renamed aside or not) is stopped, never this
                // process. Started without a task (install.ps1's Startup shortcut), it's started
                // the same way.
                let exe = cmd.first().map(String::as_str).unwrap_or("");
                let tasks = [Some(task), o.task].into_iter().flatten().map(psq).collect::<Vec<_>>().join(", ");
                let start = if role == Role::Node && basename(exe).starts_with("tether-node") {
                    "Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden".to_string()
                } else {
                    format!("Start-Process -FilePath $exe -ArgumentList {} -WindowStyle Hidden", s.args.iter().map(|a| psq(a)).collect::<Vec<_>>().join(", "))
                };
                let r = ps(&format!(
                    "$ErrorActionPreference='Stop'\n$exe = {}\n$t = {tasks} | ForEach-Object {{ Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }} | Select-Object -First 1\nif ($t) {{ Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue }}\n{}\nStart-Sleep -Milliseconds 500\nif ($t) {{ Start-ScheduledTask -TaskName $t.TaskName }} else {{ {start} }}",
                    psq(exe),
                    stop_copies(sys, Some(role))
                ));
                return if r.ok { ok("restarted its logon task") } else { failed(r.out.lines().next().filter(|l| !l.is_empty()).unwrap_or("Task Scheduler refused").to_string()) };
            }
        }
        Platform::Other => {}
    }
    // no service manager: a process started in the background (nohup), recorded by its pid
    if pid_file(role).exists() {
        let args: Vec<String> = cmd.iter().cloned().chain(s.args.iter().map(|a| a.to_string())).collect();
        return background(sys, role, &args);
    }
    if role == Role::Node {
        return restart_node_process(sys, cmd);
    }
    failed("no background service or process found")
}

/// install.sh's fallback before the rename: the node started with nohup, recorded in node.json.
fn restart_node_process(sys: &Sys, cmd: &[String]) -> Installed {
    let pid = fs::read_to_string(node_dir().join("node.json")).ok().and_then(|t| serde_json::from_str::<crate::state::Running>(&t).ok()).and_then(|r| r.pid);
    let Some(pid) = pid.filter(|p| is_role_process(sys, *p, Role::Node)) else {
        return failed("no background service or process found");
    };
    if let Err(note) = stop_pid(sys, pid, Role::Node) {
        return failed(note);
    }
    let args: Vec<String> = cmd.iter().cloned().chain(spec(Role::Node).args.iter().map(|a| a.to_string())).collect();
    background(sys, Role::Node, &args)
}

/// The systemd unit tether-node made for `role`, if this machine still has it. Both of its
/// installers named it tether-node.service; the phone link's runs `… link`.
fn old_unit_for(role: Role) -> Option<&'static str> {
    let unit = old(role).unit?;
    let text = fs::read_to_string(unit_file(unit)).ok()?;
    if role == Role::Hub {
        return Some(unit);
    }
    let exec = text.lines().find_map(|l| l.strip_prefix("ExecStart=")).map(str::trim).unwrap_or("");
    let last = exec.rsplit(char::is_whitespace).next().unwrap_or("").trim_matches('"');
    let runs_link = last == "link";
    if runs_link == (role == Role::Link) {
        Some(unit)
    } else {
        None
    }
}

/// The jobs still set up under their names from before the rename to Inyon. A hub installed with
/// git clone keeps its unit (its own update restarts either name), so it isn't listed.
pub fn old_services(sys: &Sys) -> Vec<Role> {
    let mut found = Vec::new();
    for role in [Role::Link, Role::Node] {
        let o = old(role);
        let there = match sys.platform {
            Platform::Linux => old_unit_for(role).is_some() || o.cron.is_some_and(|c| which("crontab").is_some() && run(&["crontab", "-l"]).out.contains(c)),
            Platform::Darwin => o.label.is_some_and(|l| plist_file(l).exists()),
            Platform::Windows => match o.task {
                Some(task) => {
                    let startup = o.shortcut.map(|s| format!("(Test-Path {})", startup_shortcut(s))).unwrap_or_else(|| "$false".to_string());
                    ps(&format!("if ((Get-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue) -or {startup}) {{ exit 0 }} else {{ exit 1 }}", psq(task))).ok
                }
                None => false,
            },
            Platform::Other => false,
        };
        if there {
            found.push(role);
        }
    }
    found
}

/// Moves `role` from the service tether-node set up to inyon's own. The old one is stopped
/// first, so two copies never run at once, then the new one is set up and started, and only
/// then is the old one removed. If the new one can't be set up, the old one is started again.
/// Run from a process of its own (see detach): stopping the old service ends everything it started.
pub fn move_old_service(sys: &Sys, role: Role) -> Installed {
    let o = old(role);
    match sys.platform {
        Platform::Linux => {
            let unit = old_unit_for(role);
            if let Some(u) = unit {
                run(&["systemctl", "--user", "stop", &format!("{u}.service")]);
            } else {
                // the nohup fallback: the old copy recorded its PID in link.pid or node.json
                stop_old_background(sys, role);
            }
            let r = install_service(sys, role, true);
            if !r.ok {
                if let Some(u) = unit {
                    run(&["systemctl", "--user", "start", &format!("{u}.service")]);
                }
                return r;
            }
            if let Some(u) = unit {
                run(&["systemctl", "--user", "disable", &format!("{u}.service")]);
                let _ = fs::remove_file(unit_file(u));
                run(&["systemctl", "--user", "daemon-reload"]);
            }
            if let Some(c) = o.cron {
                drop_cron(c);
            }
            r
        }
        Platform::Darwin => {
            let Some(label) = o.label else {
                return failed("nothing to move");
            };
            let file = path_str(&plist_file(label));
            run(&["launchctl", "unload", "-w", &file]);
            let r = install_service(sys, role, true);
            if !r.ok {
                run(&["launchctl", "load", "-w", &file]);
                return r;
            }
            let _ = fs::remove_file(&file);
            r
        }
        Platform::Windows => {
            let Some(task) = o.task else {
                return failed("nothing to move");
            };
            ps(&format!("Stop-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue\n{}", psq(task), stop_copies(sys, Some(role))));
            let r = install_service(sys, role, true);
            if !r.ok {
                ps(&format!("Start-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue", psq(task)));
                return r;
            }
            let remove = o.shortcut.map(|s| format!("Remove-Item -Force -ErrorAction SilentlyContinue {}", startup_shortcut(s))).unwrap_or_default();
            ps(&format!("Unregister-ScheduledTask -TaskName {} -Confirm:$false -ErrorAction SilentlyContinue\n{remove}", psq(task)));
            r
        }
        Platform::Other => failed("nothing to move"),
    }
}

/// The old copy started with nohup where there were no user services.
fn stop_old_background(sys: &Sys, role: Role) {
    let pid = match role {
        Role::Link => fs::read_to_string(node_dir().join("link.pid")).ok().and_then(|t| t.trim().parse::<u32>().ok()),
        _ => fs::read_to_string(node_dir().join("node.json")).ok().and_then(|t| serde_json::from_str::<crate::state::Running>(&t).ok()).and_then(|r| r.pid),
    };
    if let Some(pid) = pid.filter(|p| *p != sys.pid) {
        let _ = stop_pid(sys, pid, role);
    }
}

/// What the phone needs on this machine besides the link: tmux (psmux on Windows). The message
/// says how to install it, when it's missing.
pub fn missing_mux(platform: Platform) -> Option<String> {
    if platform == Platform::Windows {
        if which("psmux").is_some() || which("tmux").is_some() {
            return None;
        }
        return Some("psmux (tmux for Windows) is missing. Install it with: winget install psmux".to_string());
    }
    if which("tmux").is_some() || ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].iter().any(|p| Path::new(p).exists()) {
        return None;
    }
    if platform == Platform::Darwin {
        return Some(if which("brew").is_some() || Path::new("/opt/homebrew/bin/brew").exists() {
            "tmux is missing. Install it with: brew install tmux".to_string()
        } else {
            "tmux is missing. Install Homebrew from https://brew.sh, then run: brew install tmux".to_string()
        });
    }
    let pm = ["apt-get", "dnf", "pacman", "zypper", "apk"].into_iter().find(|p| which(p).is_some());
    let cmd = match pm {
        Some("apt-get") => Some("sudo apt-get install -y tmux"),
        Some("dnf") => Some("sudo dnf install -y tmux"),
        Some("pacman") => Some("sudo pacman -S tmux"),
        Some("zypper") => Some("sudo zypper install -y tmux"),
        Some("apk") => Some("sudo apk add tmux"),
        _ => None,
    };
    Some(match cmd {
        Some(c) => format!("tmux is missing. Install it with: {c}"),
        None => "tmux is missing. Install it with your package manager.".to_string(),
    })
}

/// Runs `args` (this program and a command) on its own: restarting a service ends everything the
/// service started, the command that asked included. On Linux it becomes a transient systemd
/// unit, on Windows a one-off task, elsewhere a process in a session of its own.
pub fn detach(sys: &Sys, args: &[String]) -> Installed {
    if sys.platform == Platform::Linux && which("systemd-run").is_some() && run(&["systemctl", "--user", "show-environment"]).ok {
        let mut cmd: Vec<String> = vec!["systemd-run".into(), "--user".into(), "--collect".into(), "--quiet".into()];
        for k in ["INYON_DOWNLOAD", "INYON_DATA_DIR"] {
            if let Ok(v) = std::env::var(k) {
                if !v.is_empty() {
                    cmd.push(format!("--setenv={k}={v}"));
                }
            }
        }
        cmd.extend(args.iter().cloned());
        let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
        if run(&refs).ok {
            return ok("a transient systemd unit");
        }
    }
    if sys.platform == Platform::Windows {
        let (exe, rest) = args.split_first().expect("a program to run");
        let quoted = rest.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" ");
        let r = ps(&format!(
            "$ErrorActionPreference='Stop'\n$a = New-ScheduledTaskAction -Execute {} -Argument {}\n$p = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive -RunLevel Limited\n$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)\nRegister-ScheduledTask -TaskName '{UPDATE_TASK}' -Action $a -Principal $p -Settings $s -Force | Out-Null\nStart-ScheduledTask -TaskName '{UPDATE_TASK}'",
            psq(exe),
            psq(&quoted)
        ));
        if r.ok {
            return ok("a one-off task");
        }
    }
    let _ = fs::create_dir_all(node_dir());
    match sys::spawn_detached(args, &node_dir().join("update.log")) {
        Ok(()) => ok("a background process"),
        Err(err) => failed(err.to_string()),
    }
}

/// `inyon update`, started on its own (the app asks for it from inside the service it restarts).
pub fn detach_update(sys: &Sys, cmd: &[String]) -> Installed {
    let mut args = cmd.to_vec();
    args.push("update".into());
    detach(sys, &args)
}

/// The one-off task removes itself when it's done (Windows only).
pub fn forget_update_task(sys: &Sys) {
    if sys.platform != Platform::Windows {
        return;
    }
    ps(&format!("Unregister-ScheduledTask -TaskName '{UPDATE_TASK}' -Confirm:$false -ErrorAction SilentlyContinue"));
}

/// Which jobs run in the background here: set up as a service, or started and still running.
pub fn active_roles(sys: &Sys) -> Vec<Role> {
    ROLES.iter().copied().filter(|r| has_service(sys, *r) || crate::update::is_running(sys.proc, *r)).collect()
}
