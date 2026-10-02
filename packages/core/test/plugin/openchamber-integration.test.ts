import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Database } from "@opencode/core/database/database"
import { OpenChamber } from "@opencode/core/plugin/openchamber"
import { CodeLoadingPolicy } from "@opencode/core/plugin/code-loading-policy"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Plugin } from "@opencode/core/plugin"
import { Config } from "@opencode/core/config"
import { Document, Info, Event } from "@opencode/schema/config"
import { Bus } from "@opencode/core/bus"
import { Tool } from "@opencode/core/tool"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const catalog = ["openchamber", "openchamber_web", "openchamber_memory", "openchamber_notify"].map((name) => ({
  name,
  description: "test",
  input: { type: "object", properties: { action: { type: "string" } } },
  actionTitles: { "test.action": "Test action" },
}))
const configuration = (settings: NonNullable<NonNullable<Info["openchamber"]>["agentTools"]>) =>
  new Document({ type: "document", info: new Info({ openchamber: { agentTools: settings } }) })
const configLayer = Config.testLayer([configuration({ control: true, memory: true })])
const records: unknown[] = []
const bridge = OpenChamber.fromBootstrap({
  version: 1,
  url: "http://127.0.0.1:12345/api/openchamber/agent-tool",
  token: "x".repeat(43),
  catalog,
})
const it = testEffect(
  Layer.merge(
    configLayer,
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, Session.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      CodeLoadingPolicy.node.replace(CodeLoadingPolicy.configured(true)),
      ConfigPluginSource.node.replace(ConfigPluginSource.empty),
      Config.node.replace(configLayer),
      OpenChamber.node.replace(
        OpenChamber.configured({
          ...bridge,
          call: async (input) => {
            records.push(input)
            return JSON.stringify({ schemaVersion: 1, ok: true, action: "test.action" })
          },
        }),
      ),
    ]),
  ),
)

it.live("full location graph enforces static adapter permissions and hot config without model calls", () =>
  Effect.gen(function* () {
    records.length = 0
    const tmp = yield* tmpdirScoped()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service
    const denied = yield* sessions.create({
      location,
      permissions: [{ action: "openchamber", resource: "*", effect: "deny" }],
    })
    const asking = yield* sessions.create({
      location,
      permissions: [{ action: "openchamber", resource: "*", effect: "ask" }],
    })
    yield* Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.awaitActivation
      const tools = yield* Tool.Service
      const permission = yield* Permission.Service
      const registered = yield* tools.list()
      expect(registered.filter((entry) => entry.name.startsWith("openchamber")).map((entry) => entry.name)).toEqual([
        "openchamber",
        "openchamber_memory",
      ])
      expect((yield* plugin.list()).some((entry) => entry.id === "opencode.browser")).toBe(false)
      const tool = registered.find((entry) => entry.name === "openchamber")!
      const context = {
        sessionID: denied.id,
        messageID: SessionMessage.ID.create(),
        agent: Agent.ID.make("build"),
        id: Tool.CallID.make("call-test"),
        progress: () => Effect.void,
      }
      expect(Exit.isFailure(yield* tool.execute({ action: "test.action" }, context).pipe(Effect.exit))).toBe(true)
      expect(records).toHaveLength(0)
      const waiting = yield* tool
        .execute(
          { action: "test.action", value: "flat", parameters: { value: "nested" } },
          { ...context, sessionID: asking.id },
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      for (let i = 0; i < 200 && (yield* permission.list()).length === 0; i++) yield* Effect.sleep("10 millis")
      const requests = yield* permission.list()
      expect(requests).toHaveLength(1)
      expect(requests[0]!.action).toBe("openchamber")
      expect(records).toHaveLength(0)
      yield* permission.reply({ requestID: requests[0]!.id, reply: "once" })
      const result = yield* Fiber.join(waiting)
      expect(result).not.toHaveProperty("output")
      expect(records).toEqual([
        { input: { action: "test.action", value: "nested" }, sessionID: asking.id, tool: "openchamber" },
      ])
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([configuration({ web: true, notify: true, codeMode: true })])
      yield* bus.publish(Event.Updated, {}, { location })
      for (let i = 0; i < 200; i++) {
        if ((yield* tools.list()).some((entry) => entry.name === "openchamber_notify")) break
        yield* Effect.sleep("10 millis")
      }
      const changed = (yield* tools.list()).filter((entry) => entry.name.startsWith("openchamber"))
      expect(changed.map((entry) => entry.name)).toEqual(["openchamber_web", "openchamber_notify"])
      expect(changed.every((entry) => entry.options?.codemode === true)).toBe(true)
    }).pipe(Effect.provide(locations.get(location)))
  }),
)

it.live("full location ModelResolver rejects external native and AI SDK packages before import", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const locations = yield* LocationServiceMap.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      const resolver = yield* ModelResolver.Service
      const providerID = Provider.ID.make("static-boundary-test")
      yield* providers.transform((editor) =>
        editor.update(providerID, (provider) => {
          provider.activation = "enabled"
        }),
      )
      for (const packageName of ["file:///never-import-native.mjs", "aisdk:file:///never-import-sdk.mjs"]) {
        const id = Model.ID.make("test")
        yield* models.transform((editor) =>
          editor.update(providerID, id, (model) => {
            Object.assign(model, Model.Info.default(providerID, id), { package: packageName, enabled: true })
          }),
        )
        const result = yield* resolver.resolve(Model.Ref.make({ providerID, id })).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.message).toContain("compiled-only policy")
      }
    }).pipe(Effect.provide(locations.get(location)))
  }),
)
