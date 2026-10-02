import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Provider } from "@opencode/core/provider"
import { Npm } from "@opencode/util/npm"
import { loadSDKFactory } from "@opencode/core/plugin/provider/sdk-factory"
import { PluginModule } from "@opencode/core/plugin/module"
import { CodeLoadingPolicy } from "@opencode/core/plugin/code-loading-policy"
import { Watcher } from "@opencode/core/filesystem/watcher"

const npm = Npm.Service.of({
  add: () => Effect.die("MUST NOT INSTALL"),
  resolve: () => Effect.die("MUST NOT RESOLVE"),
  check: () => Effect.succeed(false),
  update: () => Effect.die("MUST NOT UPDATE"),
  which: () => Effect.undefined,
})

for (const specifier of [
  "file:///does/not/exist.mjs",
  "./not-a-plugin",
  "arbitrary-package",
  "@opencode/ai/not-a-builtin",
  "@opencode/ai/providers/openai?foreign",
]) {
  test(`rejects uncompiled provider before resolution: ${specifier}`, async () => {
    const result = await Effect.runPromise(Provider.loadPackage(specifier, npm, true).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(String(result.failure.cause)).toContain("External provider packages")
  })
  test(`rejects uncompiled SDK factory before resolution: ${specifier}`, async () => {
    await expect(Effect.runPromise(loadSDKFactory(npm, specifier, true))).rejects.toThrow("External AI SDK packages")
  })
}
test("preserves the exact compiled native provider and legacy-scope alias", async () => {
  expect(typeof (await Effect.runPromise(Provider.loadPackage("@opencode/ai/providers/openai", npm, true))).model).toBe(
    "function",
  )
  expect(
    typeof (await Effect.runPromise(Provider.loadPackage("@opencode-ai/ai/providers/openai", npm, true))).model,
  ).toBe("function")
})
test("module loader independently refuses configured local and npm plugins", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const modules = yield* PluginModule.make()
      for (const target of ["/does/not/exist/plugin.ts", "arbitrary-package"]) {
        const result = yield* modules.load({ type: "add", target, options: {} }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }
    }).pipe(
      Effect.provideService(CodeLoadingPolicy.Service, { compiledOnly: true }),
      Effect.provideService(Npm.Service, npm),
      Effect.provide(Watcher.testLayer),
      Effect.scoped,
    ),
  )
})
