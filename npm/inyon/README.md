# Inyon

Your coding agents keep running in tmux on your machines. Inyon lets you watch them, answer them
and steer them from your phone or any browser. It works with Claude Code, Codex, Gemini CLI,
OpenCode, GitHub Copilot CLI and Antigravity CLI.

```sh
npm install -g @abhash-chakraborty/inyon
inyon setup
```

`inyon setup` downloads the engine, checks its signature, installs the background service and
prints a QR code to pair the [Android app](https://inyon.tech/download/).

## What this package installs

Only the `inyon` command, about 2 MB. npm picks the build for your system from
`@abhash-chakraborty/inyon-<platform>-<arch>` (Linux, macOS and Windows, x64 and arm64). Nothing
runs at install time, so `--ignore-scripts` works. Every version is published from the release
workflow on GitHub with provenance, and the programs are the ones in that release's signed
`SHA256SUMS`.

To update the command, run `npm install -g @abhash-chakraborty/inyon@latest`. From 0.17.1,
`inyon update` updates the copy in `~/.inyon/bin` that the background service runs.

Docs: https://inyon.tech/docs/install/ · Source: https://github.com/Abhash-Chakraborty/inyon · MIT
