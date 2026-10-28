//! Inyon's core in the phone app and in the browser copy, as wasm: inyon-api's routes and the
//! app's sockets on the browser's event loop, with the app's storage and `fetch`. The web app
//! loads it in place of the TypeScript core (apps/hub/src/phone), with the same `startPhone`.

pub mod phone;
mod tables;
pub mod web;
