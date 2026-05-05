export const HELP = `factory — operator CLI for the Factory daemon

usage:
  factory <command> [options]

commands:
  up                    start the daemon (systemctl --user start factory)
  down                  stop the daemon
  restart               restart the daemon
  status                show unit status
  logs [-f] [-n N]      tail the journal (default 100 lines, -f to follow)
                        --since="<expr>" narrows by time (man systemd.time)
  --help, -h            this help

unit lifecycle:
  factory install       write the systemd user unit and enable it
                        --checkout=<path>  override (default: git toplevel of cwd)
                        --home=<path>      override FACTORY_HOME (default: ~/.factory)
                        --force            overwrite an existing unit
                        --yes              non-interactive (assume y on prompts)
  factory uninstall     disable, remove the unit, daemon-reload (data is preserved)

upgrade lifecycle:
  factory channel                       show current channel + last-good sha
  factory channel <stable|nightly|dev>  set the upgrade channel
                        --dev-branch=<name>  override the dev-channel branch
  factory channel resolve               dry-run: print the sha the channel maps to
  factory upgrade       fetch → checkout → bun install → migrate → restart → probe
                        --channel=<n>     override the configured channel
                        --checkout=<p>    override the configured checkout
                        --dry-run         print the target without applying
                        --force           proceed on a dirty checkout
                        --skip-restart    apply without restarting the unit
  factory doctor        preflight checks                                   (cut 7)
`;
