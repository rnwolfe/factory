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
  factory channel       view or set the upgrade channel                    (cut 4)
  factory upgrade       fetch + restart on the current channel             (cut 5)
  factory doctor        preflight checks                                   (cut 7)
`;
