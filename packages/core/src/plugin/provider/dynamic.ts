import { CodeLoadingPolicy } from "../code-loading-policy.js"
import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Npm } from "@opencode/util/npm"
import { loadSDKFactory } from "./sdk-factory.js"

export const DynamicProviderPlugin = define({
  id: "opencode.provider.dynamic",
  effect: Effect.fn(function* (ctx) {
    const policy = yield* CodeLoadingPolicy.Service
    const npm = yield* Npm.Service
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.sdk) return

        evt.sdk = ((yield* loadSDKFactory(npm, evt.package, policy.compiledOnly)) as (options: any) => any)(evt.options)
      }),
    )
  }),
})
