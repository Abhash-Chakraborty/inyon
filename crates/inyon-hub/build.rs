//! The web app goes into the program from apps/web/dist (static_files.rs). Cargo only watches the
//! files it embedded last time, so a release built before `bun run build`, or files added to dist
//! later (Vite gives each build new names), would never get in: it watches the folder instead.
//! While the folder is missing, cargo rebuilds this crate every time, until the web app is built.
fn main() {
    println!("cargo:rerun-if-changed=../../apps/web/dist");
}
