// Start server/server.ts as a child process on an ephemeral port (no HMR) — used by verify + fidelity.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function startServer(doc: string, extraArgs: string[] = []): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', 'server/server.ts', doc, '--port', '0', '--no-hmr', ...extraArgs],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`server did not start:\n${out}`))
    }, 20000)
    const onData = (d: Buffer) => {
      out += d.toString()
      const m = /spike 02 editor: (http:\/\/\S+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ proc, url: m[1] })
      }
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited ${code}:\n${out}`))
    })
  })
}
