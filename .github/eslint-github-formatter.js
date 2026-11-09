// ESLint formatter for CI: prints each finding as a GitHub Actions workflow command, so it shows up as an annotation
// on the line of the pull request, followed by a one-line total.

import { relative } from 'node:path';

/** @param {string} value */
const escapeData = (value) => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
/** @param {string} value */
const escapeProperty = (value) => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** @param {import('eslint').ESLint.LintResult[]} results */
export default function format(results) {
  const lines = [];
  let problems = 0;
  for (const result of results) {
    const file = relative(process.cwd(), result.filePath);
    for (const message of result.messages) {
      problems += 1;
      const level = message.severity === 2 ? 'error' : 'warning';
      const title = escapeProperty(message.ruleId ?? 'eslint');
      const position = `line=${message.line ?? 1},col=${message.column ?? 1}`;
      lines.push(`::${level} file=${escapeProperty(file)},${position},title=${title}::${escapeData(message.message)}`);
    }
  }
  lines.push(`${problems} problem${problems === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}
