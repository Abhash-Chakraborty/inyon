//! How `inyon update` restarts each job, and how tether-node's services move to inyon's.
//! Nothing runs: every command goes to a fake that records it, the process table is a fake, and
//! home is a throwaway folder. The fakes are shell scripts, so the tests that run one are skipped
//! on Windows; the PowerShell each step would run is checked as text, on the other systems.

mod common;

use common::{lock, sys, FakeProc, Home};
use inyon_cli::service::{detach_update, move_old_service, old_services, restart_service, Installed, Role};
use inyon_cli::sys::Platform;

const BIN: &str = "/home/me/.inyon/bin/inyon";

fn v(s: &[&str]) -> Vec<String> {
    s.iter().map(|x| x.to_string()).collect()
}

fn setup(fakes: &[&str]) -> Home {
    Home::new(fakes)
}

#[test]
#[cfg_attr(windows, ignore)]
fn linux_systemctl_restarts_the_jobs_own_unit_or_tether_nodes_while_it_has_not_moved() {
    let _g = lock();
    let home = setup(&["systemctl", "launchctl", "loginctl", "sh", "powershell.exe"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Linux, home.dir.join("x").as_path());
    home.unit("inyon-link", &format!("\"{BIN}\" \"link\""));
    assert!(restart_service(&sys, Role::Link, &v(&[BIN])).ok);
    assert_eq!(home.calls(), vec![v(&["systemctl", "--user", "restart", "inyon-link.service"])]);

    // both of tether-node's installers called their unit tether-node: what it runs says which job
    home.clear_calls();
    home.unit("tether-node", "\"/home/me/.tether-node/bin/tether-node\" \"link\"");
    assert!(!restart_service(&sys, Role::Node, &v(&[BIN])).ok);
    assert!(home.calls().is_empty());
    home.unit("tether-node", "/home/me/.bun/bin/bun /home/me/.tether-node/tether-node.ts");
    assert!(restart_service(&sys, Role::Node, &v(&[BIN])).ok);
    assert_eq!(home.calls(), vec![v(&["systemctl", "--user", "restart", "tether-node.service"])]);
}

#[test]
#[cfg_attr(windows, ignore)]
fn macos_launchd_restarts_the_job_under_its_own_label_or_the_old_one() {
    let _g = lock();
    let home = setup(&["systemctl", "launchctl", "sh"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Darwin, home.dir.join("x").as_path());
    let uid = inyon_cli::sys::uid();
    home.put("Library/LaunchAgents/dev.tether.node.plist", "");
    assert!(restart_service(&sys, Role::Node, &v(&[BIN])).ok);
    assert_eq!(home.calls(), vec![v(&["launchctl", "kickstart", "-k", &format!("gui/{uid}/dev.tether.node")])]);
    home.clear_calls();
    home.put("Library/LaunchAgents/tech.abhashchakraborty.inyon.node.plist", "");
    restart_service(&sys, Role::Node, &v(&[BIN]));
    assert_eq!(home.calls(), vec![v(&["launchctl", "kickstart", "-k", &format!("gui/{uid}/tech.abhashchakraborty.inyon.node")])]);
    // the phone link isn't set up here
    home.clear_calls();
    assert!(!restart_service(&sys, Role::Link, &v(&[BIN])).ok);
    assert!(home.calls().is_empty());
}

#[test]
#[cfg_attr(windows, ignore)]
fn windows_the_logon_task_is_stopped_and_started_and_the_old_copy_stopped_never_the_updater_itself() {
    let _g = lock();
    let home = setup(&["powershell.exe"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Windows, home.dir.join("x").as_path());
    // no task or shortcut of inyon's own: only tether-node's may be there
    std::env::set_var("FAKE_PS_NO", "exit 0 } else { exit 1 }");
    let exe = "C:\\Users\\me\\.tether-node\\tether-node.exe";
    assert!(restart_service(&sys, Role::Node, &v(&[exe])).ok);
    let calls = home.calls();
    assert!(calls[0].last().unwrap().contains("Get-ScheduledTask -TaskName 'Inyon node'"), "{calls:?}");
    let ps = calls[1].last().unwrap().clone();
    assert_eq!(calls[0][0], "powershell.exe");
    assert!(ps.contains("$exe = 'C:\\Users\\me\\.tether-node\\tether-node.exe'"), "{ps}");
    assert!(ps.contains("'Inyon node', 'Tether node' | ForEach-Object"), "{ps}");
    assert!(ps.contains("Get-Process -Name 'inyon', 'inyon-engine', 'tether-node'"), "{ps}");
    assert!(ps.contains(&format!("$_.Id -ne {}", std::process::id())), "{ps}");
    assert!(ps.find("Stop-ScheduledTask").unwrap() < ps.find("Start-ScheduledTask").unwrap());
    // install.ps1's Startup-folder fallback has no task: start it the way that does
    assert!(ps.contains("Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden"), "{ps}");
    home.clear_calls();
    restart_service(&sys, Role::Link, &v(&["C:\\Users\\o'brien\\.inyon\\bin\\inyon.exe"]));
    let ps = home.calls()[1].last().unwrap().clone();
    assert!(ps.contains("'Inyon link', 'Tether link'"), "{ps}");
    assert!(ps.contains("$exe = 'C:\\Users\\o''brien\\.inyon\\bin\\inyon.exe'"), "{ps}");
    assert!(ps.contains("-ArgumentList 'link'"), "{ps}");
    // the link's tunnel is stopped with it
    assert!(ps.contains("Name='cloudflared.exe'"), "{ps}");
    std::env::remove_var("FAKE_PS_NO");
}

#[test]
#[cfg_attr(windows, ignore)]
fn windows_inyons_own_task_is_registered_again_to_start_the_engine_with_no_console() {
    let _g = lock();
    let home = setup(&["powershell.exe"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Windows, home.dir.join("x").as_path());
    // the command and the engine next to it, as an install leaves them
    let bin = home.dir.join(".inyon").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("inyon"), "").unwrap();
    std::fs::write(bin.join("inyon-engine"), "").unwrap();
    let cli = bin.join("inyon").to_string_lossy().into_owned();
    let engine = bin.join("inyon-engine").to_string_lossy().into_owned();
    assert!(restart_service(&sys, Role::Link, &v(&[&cli])).ok);
    let calls = home.calls();
    let ps = calls.last().unwrap().last().unwrap().clone();
    assert!(ps.contains(&format!("New-ScheduledTaskAction -Execute '{engine}' -Argument 'link'")), "{ps}");
    assert!(!ps.contains("powershell.exe"), "no PowerShell window in between: {ps}");
    assert!(ps.find("Stop-ScheduledTask").unwrap() < ps.find("Register-ScheduledTask").unwrap(), "{ps}");
    assert!(ps.contains("Get-Process -Name 'inyon', 'inyon-engine', 'tether-node'"), "{ps}");
    // the Startup-folder fallback starts the engine too
    assert!(ps.contains(&format!("$l.TargetPath = '{engine}'")), "{ps}");
}

#[test]
#[cfg_attr(windows, ignore)]
fn no_service_manager_the_node_named_in_node_json_is_stopped_and_the_new_one_started_with_nohup() {
    let _g = lock();
    let home = setup(&["sh"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Linux, home.dir.join("x").as_path());
    home.put(".inyon/node/node.json", r#"{"pid":777,"version":"0.6.3"}"#);
    proc.set(777, &["/home/me/.bun/bin/bun", "/home/me/.tether-node/tether-node.ts"]);
    assert!(restart_service(&sys, Role::Node, &v(&[BIN])).ok);
    assert_eq!(*proc.signals.borrow(), vec![(777, "SIGTERM".to_string())]);
    let pid = home.dir.join(".inyon/node/node.pid");
    let last = home.calls().last().unwrap().clone();
    assert_eq!(last, v(&["sh", "-c", &format!("nohup '{BIN}' 'connect' >> '{}/.inyon/node/node.log' 2>&1 < /dev/null & echo $! > '{}'", home.dir.display(), pid.display())]));
}

#[test]
fn a_pid_in_node_json_that_now_belongs_to_another_program_is_left_alone() {
    let _g = lock();
    let home = setup(&["sh"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Linux, home.dir.join("x").as_path());
    home.put(".inyon/node/node.json", r#"{"pid":777}"#);
    proc.set(777, &["/usr/bin/vim"]);
    assert!(!restart_service(&sys, Role::Node, &v(&[BIN])).ok);
    assert!(proc.signals.borrow().is_empty());
    assert!(home.calls().is_empty());
}

#[test]
#[cfg_attr(windows, ignore)]
fn the_app_starts_the_update_on_its_own_a_transient_unit_on_linux_with_systemd() {
    let _g = lock();
    let home = setup(&["systemd-run", "systemctl"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Linux, home.dir.join("x").as_path());
    assert!(detach_update(&sys, &v(&[BIN])).ok);
    let last = home.calls().last().unwrap().clone();
    assert_eq!(&last[..4], &v(&["systemd-run", "--user", "--collect", "--quiet"])[..]);
    assert_eq!(&last[last.len() - 2..], &v(&[BIN, "update"])[..]);
    assert!(!home.exists(".inyon/node/update.log"));
}

#[test]
#[cfg_attr(windows, ignore)]
fn without_systemd_the_update_runs_detached_in_a_session_of_its_own_logging_to_a_file() {
    let _g = lock();
    let home = setup(&["inyon"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Linux, home.dir.join("x").as_path());
    let program = home.fakes.join("inyon");
    assert!(detach_update(&sys, &v(&[&program.to_string_lossy()])).ok);
    // the detached copy runs on its own: wait for it to have written its line
    let mut log = String::new();
    for _ in 0..40 {
        log = home.read(".inyon/node/update.log");
        if log.contains("inyon ran update") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(log.contains("inyon ran update"), "{log}");
    let calls = home.calls();
    assert_eq!(calls, vec![v(&["inyon", "update"])]);
}

#[test]
#[cfg_attr(windows, ignore)]
fn on_windows_the_update_becomes_a_one_off_task_outside_the_task_it_was_asked_from() {
    let _g = lock();
    let home = setup(&["powershell.exe"]);
    let proc = FakeProc::new(&home);
    let sys = sys(&proc, Platform::Windows, home.dir.join("x").as_path());
    let cli = home.dir.join("inyon.exe").to_string_lossy().into_owned();
    assert!(detach_update(&sys, &v(&[&cli])).ok);
    let ps = home.calls()[0].last().unwrap().clone();
    assert!(ps.contains(&format!("New-ScheduledTaskAction -Execute '{cli}' -Argument '\"update\"'")), "{ps}");
    assert!(ps.contains("Start-ScheduledTask -TaskName 'Inyon update'"), "{ps}");
    // with the engine next to it, through the engine, so no console window opens
    let engine = home.dir.join("inyon-engine.exe").to_string_lossy().into_owned();
    std::fs::write(&engine, "").unwrap();
    home.clear_calls();
    assert!(detach_update(&sys, &v(&[&cli])).ok);
    let ps = home.calls()[0].last().unwrap().clone();
    assert!(ps.contains(&format!("New-ScheduledTaskAction -Execute '{engine}' -Argument '\"hidden\" \"{cli}\" \"update\"'")), "{ps}");
}

#[test]
#[cfg_attr(not(target_os = "linux"), ignore)]
fn tether_nodes_systemd_unit_moves_to_inyons_stopped_first_removed_once_the_new_one_runs() {
    let _g = lock();
    let home = setup(&["systemctl", "loginctl", "crontab"]);
    let proc = FakeProc::new(&home);
    let program = home.dir.join("download").join("inyon");
    std::fs::create_dir_all(program.parent().unwrap()).unwrap();
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    let sys = sys(&proc, Platform::Linux, &program);
    home.unit("tether-node", "\"/home/me/.tether-node/bin/tether-node\" \"link\"");
    assert_eq!(old_services(&sys), vec![Role::Link]);
    let r = move_old_service(&sys, Role::Link);
    assert!(r.ok, "{}", r.how);
    let calls = home.calls();
    let at = |cmd: &[&str]| calls.iter().position(|c| c == &v(cmd));
    let stop = at(&["systemctl", "--user", "stop", "tether-node.service"]).unwrap();
    let start = at(&["systemctl", "--user", "enable", "--now", "inyon-link.service"]).unwrap();
    let disable = at(&["systemctl", "--user", "disable", "tether-node.service"]).unwrap();
    assert!(start > stop);
    assert!(disable > start);
    let unit = home.read(".config/systemd/user/inyon-link.service");
    assert!(unit.lines().any(|l| l.starts_with("ExecStart=") && l.ends_with(" \"link\"")), "{unit}");
    assert!(!home.exists(".config/systemd/user/tether-node.service"));
    assert_eq!(old_services(&sys), Vec::<Role>::new());
}

#[test]
#[cfg_attr(not(target_os = "linux"), ignore)]
fn if_inyons_own_unit_will_not_start_tether_nodes_is_started_again_and_kept() {
    let _g = lock();
    let home = setup(&["systemctl", "loginctl"]);
    let proc = FakeProc::new(&home);
    let program = home.dir.join("download").join("inyon");
    std::fs::create_dir_all(program.parent().unwrap()).unwrap();
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    let sys = sys(&proc, Platform::Linux, &program);
    home.unit("tether-node", "/home/me/.bun/bin/bun /home/me/.tether-node/tether-node.ts");
    home.refuse("enable");
    assert_eq!(old_services(&sys), vec![Role::Node]);
    let r = move_old_service(&sys, Role::Node);
    assert_eq!(r, Installed { ok: false, how: "Failed to enable".into() });
    assert_eq!(home.calls().last().unwrap(), &v(&["systemctl", "--user", "start", "tether-node.service"]));
    assert!(home.exists(".config/systemd/user/tether-node.service"));
}
