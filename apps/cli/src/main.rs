use std::io::IsTerminal;

use clap::{Args, Parser, Subcommand};

use inyon_cli::commands::{self, SetupFlags};
use inyon_cli::service::{Role, Sys};
use inyon_cli::sys::RealProc;
use inyon_cli::ui::{dashboard, Theme};
use inyon_cli::{engine, paths, update};

/// Drive your coding agents from the Inyon app: pair this machine, keep it reachable, keep it up to date.
#[derive(Parser)]
#[command(name = "inyon", version, disable_version_flag = true, about, long_about = None)]
struct Cli {
    /// Answer as JSON
    #[arg(long, global = true)]
    json: bool,
    /// Print the version
    #[arg(short = 'V', long)]
    version: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// What this machine is to the app, where it answers, who's paired
    Status {
        /// Plain lines, even in a terminal
        #[arg(long)]
        plain: bool,
    },
    /// Set this machine up: a few questions, then the pairing code
    Setup(SetupArgs),
    /// Show a code to pair the phone app with this machine
    #[command(trailing_var_arg = true, allow_hyphen_values = true)]
    Pair { args: Vec<String> },
    /// List paired phones
    Phones,
    /// Unpair a phone
    Forget { phone: String },
    /// Add this machine to an Inyon hub, with the token in INYON_TOKEN
    Join {
        hub: String,
        /// Save the hub without starting the connection
        #[arg(long)]
        no_autostart: bool,
    },
    /// Leave the hub this machine was added to
    Disconnect,
    /// The browsers this machine sends notifications to
    #[command(trailing_var_arg = true, allow_hyphen_values = true)]
    Push { args: Vec<String> },
    /// The hub: start, stop or restart it in the background
    Hub {
        #[command(subcommand)]
        action: HubAction,
    },
    /// Run in the background at login, or stop
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// The log of what runs in the background
    Logs {
        /// link, node or hub
        #[arg(long)]
        role: Option<String>,
        /// How many lines
        #[arg(short = 'n', long, default_value_t = 50)]
        lines: usize,
        /// Keep showing new lines
        #[arg(short = 'f', long)]
        follow: bool,
    },
    /// Check what the app needs on this machine
    Doctor,
    /// Get the newest version and restart what runs in the background
    Update {
        /// Run on its own and return at once (how the app asks for it)
        #[arg(long)]
        background: bool,
    },
    /// Take inyon off this machine (a role name keeps the old `inyon uninstall link` form)
    Uninstall {
        role: Option<String>,
        /// Remove the pairings, keys and logs too
        #[arg(long)]
        purge: bool,
        /// Don't ask anything (tmux or psmux that setup installed stays)
        #[arg(short = 'y', long)]
        yes: bool,
        /// Wait for Enter at the end (how Windows runs it from Settings, in a window of its own)
        #[arg(long, hide = true)]
        pause: bool,
    },
    /// Print the version
    Version,
    /// Move services set up as tether-node to inyon's own
    #[command(hide = true)]
    Migrate,
    /// The old `inyon install [role]` form
    #[command(hide = true)]
    Install { role: Option<String> },
    /// The icon in the Windows notification area while `role` runs (the engine starts it)
    #[command(hide = true)]
    Tray {
        role: String,
        /// The engine it belongs to: the icon goes when it stops
        #[arg(long)]
        pid: Option<u32>,
    },
}

#[derive(Args)]
struct SetupArgs {
    /// Skip the questions and take the flags (and the defaults)
    #[arg(short = 'y', long)]
    yes: bool,
    /// hub, node (paired with the phone) or join
    #[arg(long)]
    role: Option<String>,
    /// For a node: tunnel, lan, vpn or a wss:// address, comma-separated. For a hub: localhost, lan, vpn or an address
    #[arg(long)]
    network: Option<String>,
    #[arg(long)]
    port: Option<u16>,
    /// Start at login and come back after a crash (the default; --no-autostart turns it off)
    #[arg(long, overrides_with = "no_autostart")]
    autostart: bool,
    #[arg(long)]
    no_autostart: bool,
    /// The hub to join, with the token in INYON_TOKEN
    #[arg(long)]
    hub: Option<String>,
}

#[derive(Subcommand)]
enum HubAction {
    /// Run the hub in the background from now on, and say how to sign in
    Start,
    /// Stop running it in the background (its records stay)
    Stop,
    Restart,
    /// Show the setup code a new hub asks for
    Code,
    /// Choose a new password for a forgotten one
    ResetPassword {
        password: Option<String>,
    },
    /// The same as start
    #[command(hide = true)]
    Install,
    /// The same as stop
    #[command(hide = true)]
    Uninstall,
}

#[derive(Subcommand)]
enum ServiceAction {
    /// link, node or hub (the one this machine has, if none is given)
    Install {
        role: Option<String>,
    },
    Uninstall {
        role: Option<String>,
    },
    /// Which jobs are set up and running
    Status,
}

/// What goes straight to the engine, before the arguments are read here.
const FORWARDED: [&str; 2] = ["link", "connect"];
const HUB_OWN: [&str; 7] = ["start", "stop", "restart", "install", "uninstall", "code", "reset-password"];

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    // copies an earlier update renamed aside (a running .exe can't be deleted until it has
    // stopped): this program's and the engine's, which no longer looks after its own
    if let Ok(me) = std::env::current_exe() {
        let now = inyon_cli::state::now_ms() as u64;
        update::cleanup_old(&update::RealFiles, &me, now);
        update::cleanup_old(&update::RealFiles, &update::engine_beside(&me), now);
    }
    if let Some(first) = argv.get(1) {
        if FORWARDED.contains(&first.as_str()) || first.starts_with("http://") || first.starts_with("https://") {
            engine::forward(&argv[1..]);
        }
        if first == "hub" && !argv.get(2).is_some_and(|a| HUB_OWN.contains(&a.as_str()) || a == "--json") {
            commands::hub_other(&argv[2..]);
        }
    }
    let cli = Cli::parse();
    let proc = RealProc;
    let sys = Sys::new(&proc);
    let tty = std::io::stdout().is_terminal() && std::io::stdin().is_terminal();
    let theme = Theme::detect(tty);
    let json = cli.json;
    if cli.version {
        std::process::exit(commands::finish(commands::version(json), json));
    }
    let code = match cli.command {
        None | Some(Command::Status { plain: false }) if tty && !json => {
            if let Err(e) = dashboard::run_screen(&sys, theme) {
                eprintln!("{e}");
                1
            } else {
                0
            }
        }
        None | Some(Command::Status { .. }) => {
            let s = dashboard::gather(&sys, true);
            if json {
                println!("{}", serde_json::to_string(&s).unwrap_or_default());
            } else {
                println!("{}", dashboard::plain(&s));
            }
            0
        }
        Some(Command::Setup(a)) => {
            let flags = SetupFlags {
                yes: a.yes,
                role: a.role,
                network: a.network,
                port: a.port,
                autostart: if a.no_autostart {
                    Some(false)
                } else if a.autostart {
                    Some(true)
                } else {
                    None
                },
                hub: a.hub,
            };
            commands::finish(commands::setup(&sys, theme, Some(&flags), tty), json)
        }
        Some(Command::Pair { args }) => commands::finish(commands::pair(&args, json), json),
        Some(Command::Phones) => commands::finish(commands::phones(), json),
        Some(Command::Forget { phone }) => commands::finish(commands::forget(&phone), json),
        Some(Command::Join { hub, no_autostart }) => commands::finish(commands::join(&sys, &hub, &paths::env_var("INYON_TOKEN").unwrap_or_default(), !no_autostart), json),
        Some(Command::Disconnect) => commands::finish(commands::disconnect(&sys), json),
        Some(Command::Push { args }) => commands::finish(commands::push(&args), json),
        Some(Command::Hub { action }) => commands::finish(
            match action {
                HubAction::Start | HubAction::Install => commands::hub_start(&sys),
                HubAction::Stop | HubAction::Uninstall => commands::hub_stop(&sys),
                HubAction::Restart => commands::hub_restart(&sys),
                HubAction::Code => commands::hub_code(),
                HubAction::ResetPassword { password } => commands::hub_reset_password(&sys, password.as_deref()),
            },
            json,
        ),
        Some(Command::Service { action }) => commands::finish(
            match action {
                ServiceAction::Install { role } => commands::service_install(&sys, role.as_deref()),
                ServiceAction::Uninstall { role } => commands::service_uninstall(&sys, role.as_deref()),
                ServiceAction::Status => commands::service_status(&sys),
            },
            json,
        ),
        Some(Command::Install { role }) => commands::finish(commands::service_install(&sys, role.as_deref()), json),
        Some(Command::Logs { role, lines, follow }) => commands::finish(commands::logs(&sys, role.as_deref(), lines, follow), json),
        Some(Command::Doctor) => commands::finish(commands::doctor(&sys), json),
        Some(Command::Update { background }) => commands::finish(commands::update_command(&sys, background, json), json),
        Some(Command::Uninstall { role: Some(role), .. }) => commands::finish(commands::service_uninstall(&sys, Some(&role)), json),
        Some(Command::Uninstall { role: None, purge, yes, pause }) => {
            let code = commands::finish(commands::uninstall_all(&sys, purge, !yes && tty), json);
            if pause {
                inyon_cli::ui::wait_for_enter();
            }
            code
        }
        Some(Command::Version) => commands::finish(commands::version(json), json),
        Some(Command::Migrate) => commands::finish(commands::migrate(&sys), json),
        Some(Command::Tray { role, pid }) => match Role::parse(&role) {
            Some(r) => inyon_cli::tray::run(r, pid),
            None => {
                eprintln!("{role} isn't link, node or hub");
                2
            }
        },
    };
    std::process::exit(code);
}
