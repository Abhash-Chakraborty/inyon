//! The apps go into a release build from apps/app/dist and apps/web/dist (static_files.rs). Cargo
//! only watches the files it embedded last time, so a release built before the apps were, or files
//! added to dist later (each build names its files anew), would never get in: a release watches
//! each folder instead, or while there's none yet, the app's own folder, where it will appear. A
//! debug build reads the folders at run time and embeds nothing, so it watches only this file.
use std::path::Path;

fn main() {
    if std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some() {
        println!("cargo:rerun-if-changed=build.rs");
        return;
    }
    for app in ["../../apps/app", "../../apps/web"] {
        let dist = format!("{app}/dist");
        let watch = if Path::new(&dist).is_dir() { dist } else { app.to_string() };
        println!("cargo:rerun-if-changed={watch}");
    }
}
