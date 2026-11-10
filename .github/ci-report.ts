// Reads the reports the -ci tasks wrote to reports/ and turns them into GitHub output: one job summary (a table with
// one row per check, followed by the findings of the checks that failed) and annotations on the lines of the findings.
// The tasks themselves know nothing about GitHub; this step runs after `mise run check-ci`, also when it failed.
//
//   node .github/ci-report.ts
//
// Writes the summary to $GITHUB_STEP_SUMMARY, or to stdout when it is not set (to try it locally). It only reports:
// whether the job fails is decided by the check step.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import vitestConfig from '../vitest.config.ts';

const REPORTS = 'reports';
/** Findings listed per check in the summary; GitHub shows only the first 10 annotations per level and step anyway. */
const MAX_LISTED = 20;

type Level = 'error' | 'warning';

interface Finding {
  level: Level;
  /** Path relative to the repository root, if the finding has a place. */
  file?: string;
  line?: number;
  column?: number;
  title: string;
  message: string;
}

interface CheckResult {
  name: string;
  /** `missing`: the report is not there, so the tool did not run or crashed before writing it. */
  status: 'passed' | 'failed' | 'missing';
  /** One line for the table. */
  summary: string;
  findings: Finding[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading reports

// eslint-disable-next-line no-control-regex -- matching the escape character is the point
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/** Reads a report; without colour codes, which tools add in CI even when they write through a pipe. */
function readText(path: string): string | undefined {
  return existsSync(path) ? stripAnsi(readFileSync(path, 'utf8')) : undefined;
}

function readJson<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const missing = (name: string, report: string): CheckResult => ({
  name,
  status: 'missing',
  summary: `no report (\`${report}\`): the tool did not run or crashed, see the log`,
  findings: [],
});

const toRepoPath = (file: string): string => (isAbsolute(file) ? relative(process.cwd(), file) : file);

/** Drops the stack frames of an error message; the annotation sits on the line already. */
const withoutStack = (text: string): string =>
  stripAnsi(text)
    .split('\n')
    .filter((line) => !/^\s+at /.test(line))
    .join('\n')
    .trim();

const firstLine = (text: string): string => stripAnsi(text).trim().split('\n')[0] ?? '';

const plural = (count: number, word: string, words = `${word}s`): string => `${count} ${count === 1 ? word : words}`;

function countLevels(findings: Finding[]): string {
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;
  return [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
    .filter(Boolean)
    .join(', ');
}

// ---------------------------------------------------------------------------------------------------------------------
// One reader per check

function format(): CheckResult {
  const path = `${REPORTS}/format/prettier.log`;
  const log = readText(path);
  if (log === undefined) return missing('format', path);
  if (log.includes('All matched files use Prettier code style!')) {
    return { name: 'format', status: 'passed', summary: 'all files formatted', findings: [] };
  }
  const files = log
    .split('\n')
    .filter((line) => line.startsWith('[warn] ') && !line.startsWith('[warn] Code style issues'))
    .map((line) => line.slice('[warn] '.length).trim());
  const findings = files.map<Finding>((file) => ({
    level: 'error',
    file,
    title: 'prettier',
    message: 'Not formatted. Run `mise run format`.',
  }));
  const summary = files.length > 0 ? `${plural(files.length, 'file')} not formatted` : 'Prettier failed, see the log';
  return { name: 'format', status: 'failed', summary, findings };
}

interface EslintResult {
  filePath: string;
  messages: { ruleId: string | null; severity: number; message: string; line?: number; column?: number }[];
}

function lint(): CheckResult {
  const path = `${REPORTS}/lint/eslint.json`;
  const results = readJson<EslintResult[]>(path);
  if (results === undefined) return missing('lint', path);
  const findings = results.flatMap((result) =>
    result.messages.map<Finding>((message) => ({
      level: message.severity === 2 ? 'error' : 'warning',
      file: toRepoPath(result.filePath),
      line: message.line,
      column: message.column,
      title: message.ruleId ?? 'eslint',
      message: message.message,
    })),
  );
  if (findings.length === 0) {
    return { name: 'lint', status: 'passed', summary: `${plural(results.length, 'file')} linted`, findings };
  }
  return { name: 'lint', status: 'failed', summary: countLevels(findings), findings };
}

const TSC_LINE = /^(\S.*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

function typecheck(): CheckResult {
  const path = `${REPORTS}/typecheck/vue-tsc.log`;
  const log = readText(path);
  if (log === undefined) return missing('typecheck', path);
  const findings = log.split('\n').flatMap<Finding>((line) => {
    const match = TSC_LINE.exec(line);
    if (!match) return [];
    const [, file = '', row, column, level, code = 'tsc', message = ''] = match;
    return [
      {
        level: level === 'warning' ? 'warning' : 'error',
        file: toRepoPath(file),
        line: Number(row),
        column: Number(column),
        title: code,
        message,
      },
    ];
  });
  if (findings.length > 0) return { name: 'typecheck', status: 'failed', summary: countLevels(findings), findings };
  // vue-tsc --build prints nothing when it passes; any other output means it failed in a way the regexp does not know.
  if (log.trim() !== '')
    return { name: 'typecheck', status: 'failed', summary: 'vue-tsc failed, see the log', findings };
  return { name: 'typecheck', status: 'passed', summary: 'no type errors', findings };
}

interface DepcruiseReport {
  summary: {
    violations: { from: string; to: string; rule: { name: string; severity: string } }[];
    error: number;
    totalCruised: number;
    totalDependenciesCruised: number;
    ruleSetUsed?: { forbidden?: { name: string; comment?: string }[] };
  };
}

function arch(): CheckResult {
  const path = `${REPORTS}/arch/depcruise.json`;
  const report = readJson<DepcruiseReport>(path);
  if (report === undefined) return missing('arch', path);
  const { summary } = report;
  const comments = new Map((summary.ruleSetUsed?.forbidden ?? []).map((rule) => [rule.name, rule.comment]));
  const findings = summary.violations
    .filter((violation) => violation.rule.severity === 'error' || violation.rule.severity === 'warn')
    .map<Finding>((violation) => ({
      level: violation.rule.severity === 'error' ? 'error' : 'warning',
      file: violation.from,
      title: violation.rule.name,
      // An orphan (no imports either way) is reported with `to` equal to `from`.
      message: [violation.to === violation.from ? '' : `Imports ${violation.to}.`, comments.get(violation.rule.name)]
        .filter(Boolean)
        .join(' '),
    }));
  const cruised = `${plural(summary.totalCruised, 'module')}, ${plural(summary.totalDependenciesCruised, 'dependency', 'dependencies')}`;
  if (summary.error > 0) {
    return { name: 'arch', status: 'failed', summary: `${countLevels(findings)} (${cruised})`, findings };
  }
  return { name: 'arch', status: 'passed', summary: `no violations (${cruised})`, findings };
}

interface ValidateIssue {
  message?: string;
  path?: string;
  file?: string;
}
interface ValidateReport {
  success: boolean;
  manifest: { file: string; errors: (ValidateIssue | string)[]; warnings: (ValidateIssue | string)[] };
}

function pluginValidate(): CheckResult {
  const targets = ['plugin', 'marketplace'];
  const findings: Finding[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    const path = `${REPORTS}/plugin-validate/${target}.json`;
    const report = readJson<ValidateReport>(path);
    if (report === undefined) return missing('plugin-validate', path);
    if (!report.success) failed.push(target);
    const file = toRepoPath(report.manifest.file);
    const toFinding =
      (level: Level) =>
      (issue: ValidateIssue | string): Finding => ({
        level,
        file,
        title: `claude plugin validate (${target})`,
        message: typeof issue === 'string' ? issue : [issue.path, issue.message].filter(Boolean).join(': '),
      });
    findings.push(
      ...report.manifest.errors.map(toFinding('error')),
      ...report.manifest.warnings.map(toFinding('warning')),
    );
  }
  if (failed.length > 0) {
    return { name: 'plugin-validate', status: 'failed', summary: `${failed.join(' and ')} invalid`, findings };
  }
  return { name: 'plugin-validate', status: 'passed', summary: 'plugin and marketplace valid', findings };
}

interface VitestReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: {
    name: string;
    status: string;
    message: string;
    assertionResults: {
      fullName: string;
      status: string;
      failureMessages: string[];
      location?: { line: number; column: number };
    }[];
  }[];
}

function unitTests(): CheckResult {
  const path = `${REPORTS}/unit/results.json`;
  const report = readJson<VitestReport>(path);
  if (report === undefined) return missing('unit tests', path);
  const findings: Finding[] = [];
  for (const file of report.testResults) {
    const failedTests = file.assertionResults.filter((test) => test.status === 'failed');
    for (const test of failedTests) {
      findings.push({
        level: 'error',
        file: toRepoPath(file.name),
        line: test.location?.line,
        column: test.location?.column,
        title: test.fullName,
        message: withoutStack(test.failureMessages.join('\n')),
      });
    }
    // A file that fails without a failed test, e.g. because it does not load.
    if (file.status === 'failed' && failedTests.length === 0) {
      findings.push({
        level: 'error',
        file: toRepoPath(file.name),
        title: 'test file failed',
        message: withoutStack(file.message),
      });
    }
  }
  const counts = [
    `${report.numPassedTests} passed`,
    report.numFailedTests > 0 && `${report.numFailedTests} failed`,
    report.numPendingTests + report.numTodoTests > 0 && `${report.numPendingTests + report.numTodoTests} skipped`,
  ]
    .filter(Boolean)
    .join(', ');
  const summary = `${counts} (${plural(report.testResults.length, 'file')})`;
  return {
    name: 'unit tests',
    status: report.success && findings.length === 0 ? 'passed' : 'failed',
    summary,
    findings,
  };
}

type CoverageSummary = Record<string, { lines: { pct: number }; branches: { pct: number } }>;

function coverage(): CheckResult {
  const path = `${REPORTS}/coverage/coverage-summary.json`;
  const report = readJson<CoverageSummary>(path);
  if (report === undefined) return missing('coverage', path);
  // The gate is configured in vitest.config.ts; read from there so that the two never disagree.
  const config = vitestConfig.test?.coverage;
  const thresholds = config && 'thresholds' in config ? config.thresholds : undefined;
  const minLines = typeof thresholds?.lines === 'number' ? thresholds.lines : 0;
  const minBranches = typeof thresholds?.branches === 'number' ? thresholds.branches : 0;
  const files = Object.entries(report).filter(([file]) => file !== 'total');
  const findings = files
    .filter(([, file]) => file.lines.pct < minLines || file.branches.pct < minBranches)
    .map<Finding>(([file, { lines, branches }]) => ({
      level: 'error',
      file: toRepoPath(file),
      title: 'coverage',
      message: `${lines.pct} % lines, ${branches.pct} % branches; the gate is ${minLines} % lines and ${minBranches} % branches.`,
    }));
  const gate = `≥ ${minLines} % lines and ${minBranches} % branches`;
  if (files.length === 0) return { name: 'coverage', status: 'passed', summary: 'no changed source files', findings };
  if (findings.length > 0) {
    return {
      name: 'coverage',
      status: 'failed',
      summary: `${findings.length} of ${plural(files.length, 'changed file')} below ${minLines} % lines or ${minBranches} % branches`,
      findings,
    };
  }
  return { name: 'coverage', status: 'passed', summary: `${plural(files.length, 'changed file')} ${gate}`, findings };
}

interface PlaywrightSuite {
  title: string;
  file: string;
  specs: {
    title: string;
    file: string;
    line: number;
    column: number;
    tests: {
      projectName: string;
      status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
      results: { errors: { message?: string; location?: { file: string; line: number; column: number } }[] }[];
    }[];
  }[];
  suites?: PlaywrightSuite[];
}
interface PlaywrightReport {
  config: { rootDir: string };
  suites: PlaywrightSuite[];
  errors: { message?: string }[];
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
}

function e2e(): CheckResult {
  const path = `${REPORTS}/e2e/results.json`;
  const report = readJson<PlaywrightReport>(path);
  if (report === undefined) return missing('e2e', path);
  const findings: Finding[] = report.errors.map((error) => ({
    level: 'error',
    title: 'Playwright',
    message: withoutStack(error.message ?? 'unknown error'),
  }));
  const visit = (suite: PlaywrightSuite, titles: string[]): void => {
    const path = suite.title === suite.file ? titles : [...titles, suite.title];
    for (const spec of suite.specs) {
      for (const test of spec.tests.filter((t) => t.status === 'unexpected' || t.status === 'flaky')) {
        const error = test.results.flatMap((result) => result.errors)[0];
        findings.push({
          level: test.status === 'flaky' ? 'warning' : 'error',
          file: toRepoPath(error?.location?.file ?? `${report.config.rootDir}/${spec.file}`),
          line: error?.location?.line ?? spec.line,
          column: error?.location?.column ?? spec.column,
          title: `${test.status === 'flaky' ? 'flaky: ' : ''}[${test.projectName}] ${[...path, spec.title].join(' › ')}`,
          message: withoutStack(error?.message ?? 'failed'),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, path);
  };
  for (const suite of report.suites) visit(suite, []);
  const { expected, unexpected, flaky, skipped } = report.stats;
  const summary = [
    `${expected} passed`,
    unexpected > 0 && `${unexpected} failed`,
    flaky > 0 && `${flaky} flaky`,
    skipped > 0 && `${skipped} skipped`,
  ]
    .filter(Boolean)
    .join(', ');
  const failed = unexpected > 0 || report.errors.length > 0;
  return {
    name: 'e2e',
    status: failed ? 'failed' : 'passed',
    summary: failed ? `${summary}; the HTML report with traces is in the run's artifacts` : summary,
    findings,
  };
}

function build(): CheckResult {
  const outputs = ['plugin/dist/cli.js', 'plugin/dist/server.js', 'plugin/dist/web/index.html'];
  const absent = outputs.filter((output) => !existsSync(output));
  if (absent.length > 0)
    return { name: 'build', status: 'failed', summary: `missing ${absent.join(', ')}`, findings: [] };
  return { name: 'build', status: 'passed', summary: 'page, server and CLI built', findings: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

const escapeData = (value: string): string =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (value: string): string => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

/** A GitHub Actions workflow command; GitHub turns it into an annotation on the line. */
function annotation(finding: Finding): string {
  const properties = [
    finding.file && `file=${escapeProperty(finding.file)}`,
    finding.line && `line=${finding.line}`,
    finding.column && `col=${finding.column}`,
    `title=${escapeProperty(finding.title)}`,
  ].filter(Boolean);
  return `::${finding.level} ${properties.join(',')}::${escapeData(finding.message)}`;
}

const escapeMarkdown = (text: string): string => text.replaceAll('|', '\\|').replaceAll('<', '&lt;');

/** A link to the line in the commit the run checked, or just the path outside GitHub Actions. */
function place(finding: Finding): string {
  if (!finding.file) return '';
  const label = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = process.env;
  if (!server || !repository || !sha || finding.file.startsWith('..')) return `\`${label}\``;
  const anchor = finding.line ? `#L${finding.line}` : '';
  return `[\`${label}\`](${server}/${repository}/blob/${sha}/${finding.file}${anchor})`;
}

const ICONS = { passed: '✅', failed: '❌', missing: '⚠️' } as const;

function summaryMarkdown(results: CheckResult[]): string {
  const lines = ['| | Check | Result |', '| - | - | - |'];
  for (const result of results) {
    lines.push(`| ${ICONS[result.status]} | ${result.name} | ${escapeMarkdown(result.summary)} |`);
  }
  for (const result of results.filter((r) => r.findings.length > 0)) {
    lines.push('', `### ${ICONS[result.status]} ${result.name}`, '');
    for (const finding of result.findings.slice(0, MAX_LISTED)) {
      const where = place(finding);
      const message = escapeMarkdown(firstLine(finding.message));
      lines.push(`- ${where ? `${where} ` : ''}**${escapeMarkdown(finding.title)}**: ${message}`);
    }
    if (result.findings.length > MAX_LISTED) {
      lines.push(`- … and ${result.findings.length - MAX_LISTED} more, see the log`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const results = [format(), lint(), typecheck(), arch(), pluginValidate(), unitTests(), coverage(), e2e(), build()];

/**
 * The findings of all checks, interleaved: the first of every check, then the second of every check, and so on.
 * GitHub shows only the first 10 errors and 10 warnings of a step as annotations, so that every failed check gets one.
 */
function interleaved(lists: Finding[][]): Finding[] {
  const longest = Math.max(0, ...lists.map((list) => list.length));
  return Array.from({ length: longest }, (_, index) => lists.flatMap((list) => list[index] ?? [])).flat();
}

for (const finding of interleaved(results.map((result) => result.findings))) console.log(annotation(finding));

const markdown = summaryMarkdown(results);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
else console.log(`\n${markdown}`);
