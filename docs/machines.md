# Adding machines to a hub

Laptops and desktops: *Add a machine → This device connects to Inyon*, then run the one-line
command it shows on that machine. It downloads `inyon` from the hub, checks it, and runs it as a
small user service. No sudo, no open ports.

Servers: *Add a machine → Connect over SSH* with `user@host` or an alias from the hub's
`~/.ssh/config`. The server only needs tmux, and the hub uses your existing keys and jump hosts.

Each machine's Setup tab checks for tmux, Node.js and every agent, installs what's missing, and
opens sign-in for each agent in a terminal.

## When a machine goes offline

The hub keeps the last thing it saw on disk. The machine stays in the list as "Offline · last seen
5 min ago", with its sessions and recent conversation still readable, and sending waits until it's
back. You get a notification after a minute away and another when it reconnects.

## Updating

A machine paired with a hub updates from its page under *Machines*. That works for any version,
because the hub sends a short script that checks the download first.

Before 0.7.0 the machine program was called `tether-node`. It updates the same way, then moves its
service and files (`~/.tether-node` to `~/.inyon/node`) to the new name a few minutes later. A
Linux or macOS machine that ran it as a Bun script needs the *Add a machine* command once more.
