// Import rules between the source folders. Run with `mise run arch`.
// src/cli, src/server and src/web may import src/shared but not each other; src/shared imports none of them and no
// Node built-ins (it also runs in the browser); src/web imports no Node built-ins.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-environment',
      comment: 'cli, server and web may import shared, but not each other (the CLI starts the built server instead).',
      severity: 'error',
      from: { path: '^src/(cli|server|web)/' },
      to: { path: '^src/(cli|server|web)/', pathNot: '^src/$1/' },
    },
    {
      name: 'shared-imports-no-environment',
      comment: 'shared is imported by the other folders and imports none of them.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(cli|server|web)/' },
    },
    {
      name: 'no-node-in-browser-code',
      comment: 'shared and web run in the browser and may not use Node built-ins.',
      severity: 'error',
      from: { path: '^src/(shared|web)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'A module nothing imports and that imports nothing is dead code (entry files and tests import code).',
      severity: 'error',
      from: { orphan: true, pathNot: ['\\.d\\.ts$'] },
      to: {},
    },
    {
      name: 'no-dev-dependencies-in-shipped-code',
      comment: 'Code that is bundled into the plugin may only use packages from "dependencies".',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.web.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.vue', '.js'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
