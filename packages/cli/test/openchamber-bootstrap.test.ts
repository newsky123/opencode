import { expect, test } from "bun:test"
import { Readable, PassThrough } from "node:stream"
import { readBootstrap, MAX_BOOTSTRAP_BYTES, assertManagedMode } from "../src/openchamber-bootstrap"

test("reads exactly one bounded JSON bootstrap without retaining stdin listeners", async () => {
  const stream = Readable.from([Buffer.from('{"version":'), Buffer.from("1}")])
  expect(await readBootstrap(stream)).toEqual({ version: 1 })
  expect(stream.listenerCount("data")).toBe(0)
})
test("rejects malformed JSON without echoing private input", async () => {
  await expect(readBootstrap(Readable.from(['{"token":"dummy-private-token"']))).rejects.toThrow(
    "Invalid OpenChamber bootstrap JSON",
  )
})
test("rejects oversized bootstrap before parsing", async () => {
  await expect(readBootstrap(Readable.from([Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1)]))).rejects.toThrow("exceeds 64 KiB")
})
test("rejects a closed bootstrap pipe", async () => {
  const stream = new PassThrough()
  const result = readBootstrap(stream)
  stream.destroy()
  await expect(result).rejects.toThrow("could not be read")
})

test("rejects lifecycle modes before consuming bootstrap or starting the engine", () => {
  const defaults = { compiledPluginsOnly: true, openchamberBootstrap: false, service: false, stdio: false }
  expect(() => assertManagedMode(defaults)).not.toThrow()
  expect(() => assertManagedMode({ ...defaults, openchamberBootstrap: true })).not.toThrow()
  expect(() => assertManagedMode({ ...defaults, service: true })).toThrow("default serve mode only")
  expect(() => assertManagedMode({ ...defaults, stdio: true })).toThrow("default serve mode only")
  expect(() => assertManagedMode({ ...defaults, compiledPluginsOnly: false, openchamberBootstrap: true })).toThrow(
    "requires --compiled-plugins-only",
  )
})
test("rejects bootstrap without EOF at the bounded timeout", async () => {
  const stream = new PassThrough()
  const result = readBootstrap(stream)
  stream.write('{"version":1}')
  await expect(result).rejects.toThrow("timed out")
  expect(stream.destroyed).toBe(true)
  expect(stream.listenerCount("data")).toBe(0)
}, 10_000)
