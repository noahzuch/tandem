// Start server/server.ts as a child process (no HMR) — used by verify.
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export interface ServerHandle {
  proc: ChildProcess
  url: string
  port: number
  /** everything the server printed so far */
  output: () => string
  /** SIGTERM + wait for exit (the server stores open documents first) */
  stop: () => Promise<number | null>
}

export function startServer(doc: string, port = 0, extraArgs: string[] = []): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts', doc, '--port', String(port), '--no-hmr', ...extraArgs], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`server did not start:\n${out}`))
    }, 20000)
    let started = false
    const onData = (d: Buffer) => {
      out += d.toString()
      const m = /spike 10 editor: (http:\/\/\S+)/.exec(out)
      if (m && !started) {
        started = true
        clearTimeout(timer)
        const url = m[1].replace(/\/$/, '')
        resolve({
          proc,
          url,
          port: Number(new URL(url).port),
          output: () => out,
          stop: () =>
            new Promise((res) => {
              if (proc.exitCode !== null) return res(proc.exitCode)
              proc.once('exit', (code) => res(code))
              proc.kill('SIGTERM')
            }),
        })
      }
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (!started) reject(new Error(`server exited ${code}:\n${out}`))
    })
  })
}
