// npm run check -- <file.html> [more.html …] [--json] [--strict]
// Would be `collab check` in the product. Exit 1 on errors (or on warnings with --strict).
import { readFileSync } from 'node:fs'
import { checkHtml, formatResult } from '../lib/check.ts'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
if (!files.length) {
  console.error('usage: npm run check -- <file.html> [--json] [--strict]')
  process.exit(2)
}
const results = files.map((f) => checkHtml(readFileSync(f, 'utf8'), f))
if (args.includes('--json')) console.log(JSON.stringify(results, null, 2))
else console.log(results.map(formatResult).join('\n\n'))
const bad = results.some((r) => r.findings.some((f) => f.severity === 'error' || (args.includes('--strict') && f.severity === 'warn')))
process.exit(bad ? 1 : 0)
