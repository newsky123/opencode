export * as ManagedRuntime from "./managed-runtime"

import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { CodeLoadingPolicy } from "@opencode/core/plugin/code-loading-policy"
import { OpenChamber } from "@opencode/core/plugin/openchamber"
import { LayerNode } from "@opencode/util/effect/layer-node"

export interface Runtime {
  readonly replacements: LayerNode.Replacements
  readonly capabilities: {
    readonly version: 1
    readonly compiledPluginsOnly: true
    readonly agentToolsBootstrap: 0 | 1
  }
}

/** Host-only startup state; never accepted through configuration or HTTP. */
export function create(bootstrap?: unknown): Runtime {
  const bridge = bootstrap === undefined ? undefined : OpenChamber.fromBootstrap(bootstrap)
  return {
    replacements: [
      CodeLoadingPolicy.node.replace(CodeLoadingPolicy.configured(true)),
      ConfigPluginSource.node.replace(ConfigPluginSource.empty),
      ...(bridge ? [OpenChamber.node.replace(OpenChamber.configured(bridge))] : []),
    ],
    capabilities: { version: 1, compiledPluginsOnly: true, agentToolsBootstrap: bridge ? 1 : 0 },
  }
}
