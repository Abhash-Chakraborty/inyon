//! Port of apps/hub/src/features: what the app asks a machine for beyond the chat. Each module is
//! the port of the TS file of the same name; everything runs as shell on the machine through
//! `Host::exec`, so it works the same for this machine, an SSH server, a joined machine or the
//! phone's own link.

pub mod agent_latest;
pub mod conversations;
// features/features.ts, named as the TS file is
#[allow(clippy::module_inception)]
pub mod features;
pub mod models;
// the rules for serving a page (pages-core.ts): no shell, no disk; the hub brings its own
pub mod pages_core;
pub mod paths;
pub mod providers;
pub mod setup;
pub mod signin;
pub mod workspace;
