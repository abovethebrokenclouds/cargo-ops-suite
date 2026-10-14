// Cargo Ops toolbar panel settings.
// scripts\build-msfs-panel.ps1 -Port <n> writes the port into the copy it packages, so this
// file only needs editing when you build the package by hand. The connector's default is 4311
// (start it with --port <n> to change it, and build the panel with the same -Port).
window.CARGO_OPS_PANEL_CONFIG = { port: 4311 };
