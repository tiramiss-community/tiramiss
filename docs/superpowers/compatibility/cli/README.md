# CLI basics (#572)

Scope: #572 / parent #138 / overall #114. Fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`. This slice implements no-argument/help, ping and unknown commands. Parent distribution/management features remain incomplete.

Build `pnpm --filter backend-next... build`, then run `pnpm --filter backend-next cli [command]`. Configuration uses the existing `MISSKEY_CONFIG_YML`/`.config` rules. Only `argv[2]` selects the command, including an empty string; surplus arguments are ignored as upstream.

| Input | Fixed upstream command output | backend-next |
| --- | --- | --- |
| no argument / `help` | stdout lists help and reset-captcha; exit 0 | stdout lists help and ping; exit 0 |
| `ping`, also with trailing arguments | stdout `pong\n`, stderr empty, exit 0 | identical |
| unknown, `--help`, empty string | stderr `Unrecognized command: <command>\nUse "help" to see available commands.\n`, stdout empty, exit 1 | identical |
| `reset-captcha` | updates captcha Meta fields, then prints success | unsupported: same unknown-command guidance and exit 1; no mutation |
| initialization failure | dispatch never reaches ping; nonzero exit | config read/validation failure prints `CLI initialization failed.\n` to stderr, stdout empty, exit 1 |

The help difference is intentional for this bounded slice: upstream omits implemented ping while advertising reset-captcha. Advertising an unsupported mutation would mislead operators. backend-next lists its available commands. The dedicated reset-captcha inventory row stays unimplemented; responsibility/CommandService rows must remain partial until that mutation is implemented through the management contract.

## Initialization and shutdown differences

Upstream `boot/cli.ts:18–22` constructs a Nest application context **before** selecting the command. `CommandModule` imports `GlobalModule` and `CoreModule`; `GlobalModule` loads configuration and initializes PostgreSQL (`$db`, `.initialize()`), creates Redis clients (including a pubsub subscription), and optionally creates a Meilisearch client. The broad `CoreModule` graph is therefore involved even for help and ping. `CommandService` injects configuration and MetaService, but `ping()` itself only calls `console.log('pong')`.

backend-next uses the existing configuration loader before dispatch, retaining its validation and nonzero failures. It creates none of those connections, listeners, worker runtimes or Nest objects. The existing loader's validation can reject configuration that upstream accepts; no new validation rules are added here. Missing/unreachable DB/Redis services therefore do not make ping fail, and ping is not a health check. No Nest startup logs, process title/global EventEmitter/stack-trace changes are copied. Upstream calls `process.exit(0|1)` without `app.close()`; backend-next sets `process.exitCode` and naturally exits with no owned connection to clean up. No general lifecycle or retry guarantees are introduced.

## Reproduction and limits

```sh
UPSTREAM_ROOT=/path/to/fixed/upstream node docs/superpowers/compatibility/cli/source-probe.mjs --check
pnpm --filter backend-next test:process test/processes/cli.test.ts
node --test scripts/cli-package-evidence.test.mjs scripts/url-preview-contract.test.mjs scripts/drive-files-contract.test.mjs
```

`source-probe.mjs` checks five live source files against their pinned Git blobs and records their SHA256 identities in `source-observations.json`. Seven dispatch cases run in isolated subprocesses using every non-import boot statement (including real process.exit) and the actual `CommandService.ping` body. Only Nest creation/get and imported module tokens are doubled, so stdout/stderr/exit observations describe command behavior after a successful context initialization, excluding Nest initialization diagnostics. The eighth subprocess injects a rejected context initialization and observes no pong, empty stdout and exit 1; stderr is checked for its injected error marker, not a stable full stack. Full Nest/DB/Redis initialization and its diagnostic byte stream are source-reviewed, not runtime measured. reset-captcha mutation is outside this source probe and this implementation.

The product process tests run the built entrypoint against a valid configuration with unreachable PostgreSQL/Redis addresses, preload a socket-connect trap, and require exact stdout/stderr plus natural successful/failed termination. They additionally exercise the actual package script and missing/malformed configuration, with no sensitive config contents in diagnostics. Five non-help observations are compared directly to fixed source results; help's exact product output is checked separately against the documented difference.

The package script adds no dependencies or lockfile change. `package-predecessor.json` and `scripts/cli-package-evidence.mjs` provide one finite, sealed reverse patch for that single measured package input before the existing image-ingest dependency projection. Previous receipts remain unchanged. The reader rereads bytes/proof on every invocation and rejects current-input or proof drift; unrelated inputs, including the lockfile, pass through to existing checks. #599's scoped evidence validation and optional log/receipt identity checks remain in place.
