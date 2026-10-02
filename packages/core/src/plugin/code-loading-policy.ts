export * as CodeLoadingPolicy from "./code-loading-policy.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Layer } from "effect"

/** A host-only startup choice. Configuration documents cannot weaken this policy. */
export class Service extends Context.Service<Service, { readonly compiledOnly: boolean }>()(
  "@opencode/CodeLoadingPolicy",
) {}

export const configured = (compiledOnly: boolean) =>
  makeGlobalNode({ service: Service, layer: Layer.succeed(Service, { compiledOnly }), deps: [] })

export const node = configured(false)
