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
| `varis test <slug>` | Call a published service and show what it returns. Free. |
| `varis logout` | Sign this machine out of Varis. |

Run `varis <command> --help` for details.

## Install

Coming soon: an install script, Homebrew, and Scoop. The CLI is a single
binary and doesn't need Node.js.

## Report a problem

Open an issue on [GitHub](https://github.com/AugustineOjeh/varis-cli/issues).
When the CLI hits a bug, it prints a link that fills in the details for you.
See [how to write a report we can act on](docs/reporting-issues.md).

## License

MIT
