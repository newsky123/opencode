import { Tool } from "@opencode/schema/tool"
export * as OpenChamber from "./openchamber.js"

import { define } from "@opencode/plugin/effect/plugin"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, type JsonSchema, Layer, Schema } from "effect"
import { request } from "node:http"
import { networkInterfaces } from "node:os"
import { isIP } from "node:net"
import { Config } from "../config.js"
import { Permission } from "../permission.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"

const names = ["openchamber", "openchamber_web", "openchamber_memory", "openchamber_notify"] as const
const keys = {
  openchamber: "control",
  openchamber_web: "web",
  openchamber_memory: "memory",
  openchamber_notify: "notify",
} as const
const CatalogEntry = Schema.Struct({
  name: Schema.Literals(names),
  description: Schema.String,
  input: Schema.Record(Schema.String, Schema.Json),
  actionTitles: Schema.Record(Schema.String, Schema.String),
})
const Bootstrap = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  token: Schema.String,
  catalog: Schema.Array(CatalogEntry),
})
type Entry = typeof CatalogEntry.Type
export interface Interface {
  readonly enabled: boolean
  readonly catalog: readonly Entry[]
  readonly call: (input: unknown, signal: AbortSignal) => Promise<string>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OpenChamber") {}
export const configured = (service: Interface) =>
  makeGlobalNode({ service: Service, layer: Layer.succeed(Service, service), deps: [] })
export const node = configured({ enabled: false, catalog: [], call: () => Promise.reject(new Error("Unavailable")) })

/** Only the trusted CLI bootstrap calls this. Never put the payload in config, logs, or environment. */
export function fromBootstrap(value: unknown): Interface {
  const decoded = Schema.decodeUnknownSync(Bootstrap)(value)
  const endpoint = new URL(decoded.url)
  const host = endpoint.hostname.replace(/^\[|\]$/g, "")
  const local =
    host === "127.0.0.1" ||
    host === "::1" ||
    Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === host))
  if (
    endpoint.protocol !== "http:" ||
    !isIP(host) ||
    !local ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/api/openchamber/agent-tool"
  )
    throw new Error("Invalid OpenChamber callback endpoint")
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(decoded.token)) throw new Error("Invalid OpenChamber bootstrap credential")
  if (
    decoded.catalog.length > names.length ||
    new Set(decoded.catalog.map((entry) => entry.name)).size !== decoded.catalog.length
  )
    throw new Error("Invalid OpenChamber catalog")
  for (const entry of decoded.catalog) {
    if (entry.input.type !== "object" || entry.description.length > 16_384)
      throw new Error("Invalid OpenChamber catalog")
  }
  // The credential is reachable only through this request closure. node:http never
  // consults proxy environment variables and never follows redirects.
  const token = decoded.token
  return {
    enabled: true,
    catalog: decoded.catalog,
    call: (input, signal) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(input)
        const req = request(
          endpoint,
          {
            method: "POST",
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on("data", (chunk: Buffer) => {
              size += chunk.length
              if (size > 16 * 1024 * 1024) {
                res.destroy()
                reject(new Error("OpenChamber response is too large"))
                return
              }
              chunks.push(chunk)
            })
            res.on("error", () => reject(new Error("OpenChamber callback failed")))
            res.on("end", () => {
              if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error("OpenChamber callback failed"))
                return
              }
              resolve(Buffer.concat(chunks).toString("utf8"))
            })
          },
        )
        req.on("error", () => reject(new Error("OpenChamber callback failed")))
        req.end(body)
      }),
  }
}

const Envelope = Schema.Struct({ schemaVersion: Schema.Literal(1), ok: Schema.Boolean, action: Schema.String })

export const Plugin = define({
  id: "openchamber-agent-tool",
  effect: Effect.fn(function* (ctx) {
    const bridge = yield* Service
    if (!bridge.enabled) return
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    yield* ctx.tool.transform((tools) => {
      const settings = Object.assign(
        { control: false, web: false, memory: false, notify: false, codeMode: false },
        ...loaded.entries.flatMap((entry) =>
          entry.type === "document" ? [entry.info.openchamber?.agentTools ?? {}] : [],
        ),
      )
      for (const entry of bridge.catalog) {
        if (!settings[keys[entry.name]]) continue
        tools.add({
          name: entry.name,
          description: entry.description,
          options: { codemode: settings.codeMode, permission: entry.name },
          input: entry.input as JsonSchema.JsonSchema,
          execute: (input, context) =>
            Effect.gen(function* () {
              // Built-in tools must assert permissions explicitly, before side effects.
              yield* permission
                .assert({
                  action: entry.name,
                  resources: ["*"],
                  save: ["*"],
                  metadata: {},
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError(() => new Tool.Error({ message: `Permission denied: ${entry.name}` })))
              const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
              const { action: requestedAction, parameters, ...flattened } = record
              const args = {
                ...flattened,
                ...(typeof parameters === "object" && parameters !== null ? parameters : {}),
                action: requestedAction,
              }
              const action = typeof args.action === "string" ? args.action : "unknown"
              const title = Object.hasOwn(entry.actionTitles, action) ? entry.actionTitles[action] : action
              const metadata = (ok?: boolean) => ({
                schemaVersion: 1,
                action,
                description: title,
                ...(ok === undefined ? {} : { ok }),
              })
              yield* context.progress({ [entry.name]: metadata() })
              const content = yield* Effect.tryPromise({
                try: (signal) => bridge.call({ input: args, sessionID: context.sessionID, tool: entry.name }, signal),
                catch: () => new Error("OpenChamber managed tool request failed"),
              }).pipe(
                Effect.flatMap((content) =>
                  Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(content).pipe(
                    Effect.map((result) => ({ content, ok: result.ok })),
                  ),
                ),
                Effect.orElseSucceed(() => ({
                  content: JSON.stringify({
                    schemaVersion: 1,
                    ok: false,
                    action,
                    error: { message: "OpenChamber managed tool request failed", kind: "runtime" },
                  }),
                  ok: false,
                })),
              )
              yield* context.progress({ [entry.name]: metadata(content.ok) })
              return { content: content.content, metadata: { openchamber: metadata(content.ok) } }
            }),
        })
      }
    })
  }),
})
