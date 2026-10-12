import type { MachineKind } from '@inyon/protocol'

/**
 * What the machine is, for its icon: a server, a laptop or a desktop. The probe gathers the facts on
 * the machine once a day (Windows needs PowerShell for them, too slow for every probe) and keeps them
 * in ~/.inyon/machine-kind as one line:
 *
 *   os|chassis types|hostnamectl chassis|virtualization|graphical 0/1|batteries|model|Windows product type
 */
export const MACHINE_KIND_SH = `
k="$HOME/.inyon/machine-kind"
if [ ! -s "$k" ] || [ -n "$(find "$k" -mmin +1440 2>/dev/null)" ]; then
  mkdir -p "$HOME/.inyon" 2>/dev/null
  os=$(uname -s); ct=; hc=; vt=; g=0; b=0; md=; pt=
  case "$os" in
  Linux)
    ct=$(cat /sys/class/dmi/id/chassis_type 2>/dev/null)
    hc=$(hostnamectl chassis 2>/dev/null || hostnamectl status 2>/dev/null | sed -n 's/^ *Chassis: *\\([a-z-]*\\).*/\\1/p')
    vt=$(systemd-detect-virt 2>/dev/null)
    [ -z "$vt" ] && [ -f /.dockerenv ] && vt=docker
    { [ -n "$DISPLAY$WAYLAND_DISPLAY" ] || ls /tmp/.X11-unix/X* /run/user/*/wayland-* >/dev/null 2>&1 || pgrep -x 'Xorg|Xwayland|gnome-shell|plasmashell|kwin_wayland|sway|Hyprland|weston|xfwm4|cinnamon' >/dev/null 2>&1; } && g=1
    for f in /sys/class/power_supply/*/type; do [ "$(cat "$f" 2>/dev/null)" = Battery ] && b=1; done
    md=$(cat /sys/class/dmi/id/product_name 2>/dev/null) ;;
  Darwin)
    g=1
    pmset -g batt 2>/dev/null | grep -q InternalBattery && b=1
    md=$(sysctl -n hw.model 2>/dev/null) ;;
  Windows_NT|MINGW*|MSYS*|CYGWIN*)
    os=Windows; g=1
    w=$(powershell.exe -NoProfile -NonInteractive -Command '$e = Get-CimInstance Win32_SystemEnclosure; $c = Get-CimInstance Win32_ComputerSystem; $o = Get-CimInstance Win32_OperatingSystem; ($e.ChassisTypes -join ",") + "|" + @(Get-CimInstance Win32_Battery).Count + "|" + $c.Model + "|" + $o.ProductType' 2>/dev/null | tr -d '\\r' | tail -n 1)
    ct=$(echo "$w" | cut -d '|' -f 1); b=$(echo "$w" | cut -d '|' -f 2); md=$(echo "$w" | cut -d '|' -f 3); pt=$(echo "$w" | cut -d '|' -f 4) ;;
  *) g=1 ;;
  esac
  printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$os" "$ct" "$hc" "$vt" "$g" "\${b:-0}" "$(echo "$md" | tr -d '|')" "$pt" > "$k"
fi
echo "@@KIND $(head -n 1 "$k" 2>/dev/null)"
`

/** SMBIOS chassis types of portable machines: portable, laptop, notebook, sub-notebook. */
const PORTABLE = new Set(['8', '9', '10', '14'])
/** Hypervisors and clouds by the model name they give the machine. */
const VIRTUAL_MODEL = /virtual|vmware|kvm|qemu|hvm|xen|bochs|parallels|virtualbox|google compute|amazon ec2|droplet|openstack/i

/** The kind from the facts line, or undefined when the machine gave none (an older probe). */
export function machineKind(line: string): MachineKind | undefined {
  const [os = '', chassis = '', hostChassis = '', virt = '', graphical = '', batteries = '', model = '', product = ''] = line.trim().split('|')
  if (!os) return undefined
  const portable = chassis.split(',').some((c) => PORTABLE.has(c.trim()))
  const battery = Number(batteries) > 0
  if (os === 'Windows') {
    // 2 and 3 are Windows Server (domain controller, server)
    if (product === '2' || product === '3' || VIRTUAL_MODEL.test(model)) return 'server'
    return portable || battery ? 'laptop' : 'desktop'
  }
  if (os === 'Darwin') {
    if (VIRTUAL_MODEL.test(model)) return 'server'
    return battery || /macbook/i.test(model) ? 'laptop' : 'desktop'
  }
  // WSL runs on someone's Windows PC, not in a data centre
  if (virt === 'wsl') return battery ? 'laptop' : 'desktop'
  if ((virt && virt !== 'none') || /^(vm|container|server)$/.test(hostChassis) || VIRTUAL_MODEL.test(model)) return 'server'
  if (graphical !== '1') return 'server'
  if (portable || /^(laptop|convertible|tablet)$/.test(hostChassis) || battery) return 'laptop'
  return 'desktop'
}
