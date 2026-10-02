import { ManagedRuntime } from "@opencode/server/managed-runtime"
import { assertManagedMode, readBootstrap } from "../../openchamber-bootstrap"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerProcess } from "../../server-process"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fnUntraced(function* (input) {
    if (input.service && input.stdio) return yield* Effect.fail(new Error("--service and --stdio cannot be combined"))
    yield* Effect.try({ try: () => assertManagedMode(input), catch: (error) => error })
    const bootstrap = input.openchamberBootstrap
      ? yield* Effect.tryPromise({ try: () => readBootstrap(), catch: () => new Error("OpenChamber bootstrap failed") })
      : undefined
    const runtime = input.compiledPluginsOnly
      ? yield* Effect.try({
          try: () => ManagedRuntime.create(bootstrap),
          catch: () => new Error("Invalid OpenChamber bootstrap"),
        })
      : undefined
    return yield* ServerProcess.run(
      {
        mode: input.service ? "service" : input.stdio ? "stdio" : "default",
        hostname: Option.getOrUndefined(input.hostname),
        port: Option.getOrUndefined(input.port),
        cors: input.cors.length > 0 ? input.cors : undefined,
      },
      runtime,
    )
  }),
)
