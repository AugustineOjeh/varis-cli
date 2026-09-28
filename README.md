# Varis CLI

Publish services that AI agents discover and pay to call.

```
varis publish
```

The first run signs you in, sets up `varis.json`, builds your service
definitions, and publishes them.

## Commands

| Command | What it does |
| --- | --- |
| `varis login` | Sign in to Varis on this machine. |
| `varis init` | Set up `varis.json` in this project. |
| `varis build` | Update `varis.json` from the services defined in your code. |
| `varis publish [slug]` | Build, then publish every service in `varis.json`, or only one. |
| `varis test <slug>` | Call a service on your own server, as Varis would, before publishing. |
| `varis logout` | Sign this machine out of Varis. |
| `varis upgrade` | Upgrade the CLI to the latest stable version. |
| `varis dracarys` | Burn Varis off this machine: sign out, clean this project, uninstall. |

Run `varis <command> --help` for details.

## Install

The CLI is a single binary and doesn't need Node.js.

With Homebrew, on macOS or Linux:

```sh
brew install usevaris/tap/varis
```

Or with the install script, on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/usevaris/varis-cli/main/install.sh | sh
```

With Scoop, on Windows:

```powershell
scoop bucket add varis https://github.com/usevaris/scoop-bucket
scoop install varis/varis
```

Or with the install script, on Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/usevaris/varis-cli/main/install.ps1 | iex
```

Either installs `varis` into `.varis/bin` in your home folder, checks the
download against the release's `SHA256SUMS`, and adds the folder to your
`PATH`. To install a particular version, set `VARIS_VERSION` first, for
example `VARIS_VERSION=0.2.0`. Each script's header lists its other
settings.

## Report a problem

Open an issue on [GitHub](https://github.com/usevaris/varis-cli/issues).
When the CLI hits a bug, it prints a link that fills in the details for you.
See [how to write a report we can act on](docs/reporting-issues.md).

## License

MIT
