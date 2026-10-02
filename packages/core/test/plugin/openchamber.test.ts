import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { OpenChamber } from "@opencode/core/plugin/openchamber"

const token = "a".repeat(43)
const entry = {
  name: "openchamber",
  description: "Test data-only tool",
  input: { type: "object" },
  actionTitles: { "session.list": "List sessions" },
}
const payload = (url = "http://127.0.0.1:12345/api/openchamber/agent-tool") => ({
  version: 1,
  url,
  token,
  catalog: [entry],
})

test("accepts only compiler-known, unique tool IDs and local literal callback endpoints", () => {
  expect(OpenChamber.fromBootstrap(payload()).enabled).toBe(true)
  for (const url of [
    "https://127.0.0.1:123/api/openchamber/agent-tool",
    "http://localhost:123/api/openchamber/agent-tool",
    "http://192.0.2.10:123/api/openchamber/agent-tool",
    "http://127.0.0.1:123/other",
    "http://127.0.0.1:123/api/openchamber/agent-tool?leak=1",
    "http://x:y@127.0.0.1:123/api/openchamber/agent-tool",
  ]) {
    expect(() => OpenChamber.fromBootstrap(payload(url))).toThrow()
  }
  expect(() => OpenChamber.fromBootstrap({ ...payload(), catalog: [{ ...entry, name: "arbitrary" }] })).toThrow()
  expect(() => OpenChamber.fromBootstrap({ ...payload(), catalog: [entry, entry] })).toThrow()
})
test("credential is private to callback closure; body keeps session and tool identity", async () => {
  let observed: unknown
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      observed = { authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) }
      res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: "session.list", data: [] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (typeof address !== "object" || !address) throw new Error("No listener")
    const bridge = OpenChamber.fromBootstrap(payload(`http://127.0.0.1:${address.port}/api/openchamber/agent-tool`))
    expect(JSON.stringify(bridge)).not.toContain(token)
    const body = { input: { action: "session.list" }, sessionID: "session-test", tool: "openchamber" }
    expect(JSON.parse(await bridge.call(body, new AbortController().signal)).ok).toBe(true)
    expect(observed).toEqual({ authorization: `Bearer ${token}`, body })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
test("callback never follows redirect with its credential", async () => {
  let count = 0
  const server = createServer((_req, res) => {
    count++
    res.writeHead(302, { location: "/stolen" })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (typeof address !== "object" || !address) throw new Error("No listener")
    const bridge = OpenChamber.fromBootstrap(payload(`http://127.0.0.1:${address.port}/api/openchamber/agent-tool`))
    await expect(bridge.call({}, new AbortController().signal)).rejects.toThrow("callback failed")
    expect(count).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("callback cancellation closes the local request", async () => {
  let accepted: (() => void) | undefined
  let closed: (() => void) | undefined
  const arrived = new Promise<void>((resolve) => {
    accepted = resolve
  })
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve
  })
  const server = createServer((req, res) => {
    req.resume()
    res.once("close", () => closed?.())
    accepted?.()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (typeof address !== "object" || !address) throw new Error("No listener")
    const bridge = OpenChamber.fromBootstrap(payload(`http://127.0.0.1:${address.port}/api/openchamber/agent-tool`))
    const controller = new AbortController()
    const pending = bridge.call({}, controller.signal).catch((error: unknown) => error)
    await arrived
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("callback failed")
    await disconnected
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
