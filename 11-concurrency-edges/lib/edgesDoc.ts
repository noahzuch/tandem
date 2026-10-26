// Spike 11: the shared sample (../samples/spec.html) plus two plain-prose sections the concurrency scenarios type into.
// Plain text (no marks/links) on purpose: the classification compares plain strings.
import fs from 'node:fs'
import path from 'node:path'
import { root } from './serverProc.ts'

export const P_PREV = 'Pilot devices are chosen by the field ops lead.'
export const P_A = 'Phase one ships to twenty pilot devices in the northern region. The rollout team collects feedback every week and reports blockers to the sync owner. Phase two follows once the crash rate stays below one percent.'
/** scenario 5: the same paragraph with three typos spread across it (before and after the caret) */
export const P_A_TYPOS = 'Phase one ships to twenty pilto devices in the northern region. The rollout team collects feedbak every week and reports blockers to the sync owner. Phase two folows once the crash rate stays below one percent.'
export const P_RISK = 'Battery drain on older devices is the main risk.'

export const edgesSection = (pa = P_A) => `
  <h2 id="rollout">6. Rollout</h2>
  <p>${P_PREV}</p>
  <p>${pa}</p>
  <h2 id="risks">7. Risks</h2>
  <p>${P_RISK}</p>
`

/** spec.html with the test sections inserted before the appendix */
export function edgesDocHtml(pa = P_A): string {
  const sample = fs.readFileSync(path.resolve(root, '../samples/spec.html'), 'utf8')
  const at = sample.indexOf('  <details class="appendix"')
  if (at < 0) throw new Error('sample changed: no appendix')
  return sample.slice(0, at) + edgesSection(pa).trimStart() + '\n' + sample.slice(at)
}
