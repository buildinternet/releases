# @buildinternet/releases-lib

Runtime-neutral helpers shared by the `releases` CLI: `logger` (stderr + `~/.releases/logs/`), and `config` (data dir and API settings). Published from the `buildinternet/releases` monorepo in lockstep with `@buildinternet/releases`.

Worker code must not import this package; it uses `fs`. Workers log through `@releases/lib/log-event` instead.
