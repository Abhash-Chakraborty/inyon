//! The hub in Rust: apps/hub's HTTP server (index.ts and its routes) on inyon-core, the same
//! records, routes, answers, cookies and checks, so the web app, the phone app and machines
//! connect to it as they do to the Bun hub. `inyon` runs it in place of the Bun hub when
//! INYON_HUB_IMPL=rust.
//!
//! Everything the hub keeps lives on one thread with one current-thread tokio runtime, the
//! listener included; see `server` for why.

pub mod auth;
pub mod cli;
pub mod clients;
pub mod companions;
pub mod core_routes;
pub mod hostnames;
pub mod http;
pub mod hub_update;
pub mod idle;
pub mod index;
pub mod multipart;
pub mod node_dist;
pub mod pages;
pub mod password;
pub mod phones;
pub mod push;
pub mod server;
pub mod start;
pub mod static_files;
#[cfg(test)]
pub mod test_util;
pub mod tls;
pub mod ws;

/// `inyon-engine hub …`: the arguments after `hub`; the process's exit code.
pub fn run(args: &[String]) -> i32 {
    cli::run(args)
}
