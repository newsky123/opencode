# Compiled-only OpenChamber server profile

This first stage targets OpenCode v2.0.21 (upstream tag commit
`8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`). It preserves the four OpenChamber
tool IDs and their permission actions without introducing MCP namespaces.

## Start and build

Build from the reviewed source and lockfile with Bun:

```sh
bun install --frozen-lockfile
cd packages/cli
OPENCODE_VERSION=2.0.21-openchamber bun run script/build.ts --single --skip-install --skip-web-ui
```

The `--skip-web-ui` build is intended for OpenChamber, which supplies its own UI.
Remove that option when the upstream bundled web UI is needed. Only the Linux
x64 binary was built and exercised for this change; Windows/macOS need native CI.

A managed caller must start `opencode serve --compiled-plugins-only` and fail
closed if the flag or capability acknowledgement is absent. The profile is
supported only in default foreground serve mode. Service and stdio modes are
rejected because their lifecycle/restart behavior has not been proved to retain
this policy. Running the binary without the flag retains upstream behavior.

The selected profile is host startup state, not a configuration option. It:

- ignores all configured, discovered, and well-known external plugin sources
  before loading, with an additional denial at the plugin module loader
- permits only the exact native provider module map compiled into the binary
- rejects arbitrary native provider packages and dynamic AI SDK fallback
  packages before resolution, cache access, installation, or import
- preserves statically imported built-ins and fixed provider integrations

The profile does not sandbox shell commands, MCP subprocesses, LSP/formatter
commands, or the built-in code execution tools. These are explicitly separate
process/tool capabilities. Fixed built-ins share the trusted server process.

## Private bootstrap contract

OpenChamber additionally passes `--openchamber-bootstrap`, writes exactly one
JSON document to the child's stdin, and closes it. No newline is required.
Maximum size is 64 KiB; EOF must arrive within five seconds, before server boot.
The payload is never a configuration document or an environment variable:

```json
{
  "version": 1,
  "url": "http://127.0.0.1:12345/api/openchamber/agent-tool",
  "token": "fresh-per-child-tool-only-capability",
  "catalog": [
    {
      "name": "openchamber",
      "description": "Data-only tool description",
      "input": { "type": "object" },
      "actionTitles": { "session.list": "List sessions" }
    }
  ]
}
```

Catalog entries are JSON data. Only `openchamber`, `openchamber_web`,
`openchamber_memory`, and `openchamber_notify` are accepted, once each. Code is
never imported or evaluated from this payload. The callback URL must be plain
HTTP with a literal loopback or verified local-interface IP, explicit port,
exact path above, and no credentials, query, or fragment. Callback requests use
native HTTP, bypass proxy environment variables, reject redirects, and cancel
when the tool's execution is interrupted. The credential remains in a private
request closure, never environment, argv, config, API information, or catalog.
The upstream browser built-in is excluded for this managed bridge only.

The engine emits this acknowledgement directly before its normal listening and
password startup lines (the version is a protocol version, not binary version):

```text
openchamber capabilities {"version":1,"compiledPluginsOnly":true,"agentToolsBootstrap":1}
```

Without bootstrap, the final field is `0`. Callers must validate the expected
value and never retry stock OpenCode without the flags. This is a compatibility
handshake with a trusted installed binary, not cryptographic binary attestation.

## Hot settings and permissions

Ordinary configuration contains only data:

```json
{
  "openchamber": {
    "agentTools": {
      "control": true,
      "web": true,
      "memory": true,
      "notify": false,
      "codeMode": false
    }
  }
}
```

Missing settings default to false, with later configuration sources overriding
earlier fields. Config updates reload tool registration without rewriting or
loading JavaScript. Each execution explicitly asserts its original exact tool
permission action with resource `*` before contacting OpenChamber. The backend
must independently enforce current capability settings to reject stale calls.

## Verification

Focused tests cover helper loader gates, the complete production location graph,
real deny/ask handling, hot settings, code mode, callback routing/cancellation,
bootstrap bounds, and existing loader/provider regressions. Live compiled-binary
probes use isolated data/config directories, dummy credentials, loopback-only
fixtures, and harmless import markers. No paid prompts or real model credentials
are needed.
