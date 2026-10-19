# @xos/cli

`xos`, the command line for the XOS public API. Every operation in the API reference is a command; output is a table in a terminal and JSON in scripts. Built on [`@xos/sdk`](https://www.npmjs.com/package/@xos/sdk). Requires Node.js 22.12 or later.

```sh
npm install --global @xos/cli
xos --version
```

## Sign in and call operations

```sh
export XOS_API_KEY="xos_live_..."
xos auth login --base-url https://atlas.example.com/api/v1 --profile northwind
xos projects list --filter project_state.eq=Active --sort -created_at --limit 20
xos projects update <id> --data '{"name":"Fall Series"}' --if-match auto
xos call purchaseOrders.approve <id> --data @approval.json
```

The key is read from `XOS_API_KEY` or `--key-stdin`, never from a flag, and profiles are saved to `~/.config/xos/config.json`, readable only by you. In CI, set `XOS_API_KEY` and `XOS_BASE_URL` and skip `auth login`.

Other commands: `xos org` (profiles and organizations), `xos resources` and `xos ops` (discover operations), `xos import` and `xos export` (CSV and JSON), `xos canon` (validate canon codes) and `xos webhooks` (sign and verify test deliveries). Run `xos --help` for the full list.

## Documentation

Guide: [The xos CLI](https://github.com/ghxstship/atlas/blob/main/apps/docs/content/guides/en-US/cli.md).

## License

MIT. See [LICENSE](LICENSE). The XOS platform itself is AGPL-3.0-only.
