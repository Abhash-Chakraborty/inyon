//! `inyon`, the command people type: setup, the status screen, pairing, services and updates.
//! The engine (`inyon-engine`, next to it) runs the link, the hub connection and the hub.

pub mod commands;
pub mod engine;
pub mod http;
pub mod networks;
pub mod paths;
pub mod qr;
pub mod service;
pub mod shellpath;
pub mod signing;
pub mod state;
pub mod sys;
pub mod ui;
pub mod unhook;
pub mod update;
