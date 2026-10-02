import type { Readable } from "node:stream"

export const MAX_BOOTSTRAP_BYTES = 64 * 1024
export const BOOTSTRAP_TIMEOUT_MS = 5_000

/** A one-shot private stdin channel; errors never include the payload or credentials. */
export function readBootstrap(stream: Readable = process.stdin): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (error?: Error) => {
      clearTimeout(timer)
      stream.off("data", data)
      stream.off("end", end)
      stream.off("error", failed)
      stream.off("close", closed)
      stream.pause()
      stream.destroy()
      for (const chunk of chunks) chunk.fill(0)
      chunks.length = 0
      if (error) reject(error)
    }
    const failed = () => finish(new Error("OpenChamber bootstrap could not be read"))
    const closed = () => {
      if (!stream.readableEnded) failed()
    }
    const data = (value: Buffer | string) => {
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > MAX_BOOTSTRAP_BYTES) {
        finish(new Error("OpenChamber bootstrap exceeds 64 KiB"))
        return
      }
      chunks.push(chunk)
    }
    const end = () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        finish()
        resolve(value)
      } catch {
        finish(new Error("Invalid OpenChamber bootstrap JSON"))
      }
    }
    const timer = setTimeout(() => finish(new Error("OpenChamber bootstrap timed out")), BOOTSTRAP_TIMEOUT_MS)
    stream.on("data", data)
    stream.once("end", end)
    stream.once("error", failed)
    stream.once("close", closed)
    stream.resume()
    if (stream.readableEnded || stream.destroyed) failed()
  })
}

/** Reject lifecycle modes whose restarts do not preserve this startup policy. */
export function assertManagedMode(input: {
  compiledPluginsOnly: boolean
  openchamberBootstrap: boolean
  service: boolean
  stdio: boolean
}) {
  if (input.compiledPluginsOnly && (input.service || input.stdio))
    throw new Error("--compiled-plugins-only supports default serve mode only")
  if (input.openchamberBootstrap && !input.compiledPluginsOnly)
    throw new Error("--openchamber-bootstrap requires --compiled-plugins-only")
}
