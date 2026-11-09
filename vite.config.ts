// Builds the three outputs into plugin/dist/: the page (web/), the server (server.js) and the CLI (cli.js).
// The two Node outputs inline every dependency, so the installed plugin needs no node_modules.

import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type EnvironmentOptions } from 'vite';

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const dist = path('./plugin/dist');

/** A Node 24 bundle with a single entry and every dependency inlined. */
function nodeBundle(name: string, entry: string): EnvironmentOptions {
  return {
    consumer: 'server',
    resolve: { noExternal: true },
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'node24',
      minify: false,
      rolldownOptions: {
        input: { [name]: path(entry) },
        output: { entryFileNames: '[name].js', format: 'esm' },
      },
    },
  };
}

export default defineConfig({
  root: path('./src/web'),
  base: './',
  plugins: [vue()],
  // Vite also defines a default `ssr` environment; build only the three outputs.
  builder: {
    async buildApp(builder) {
      for (const name of ['client', 'server', 'cli']) {
        const environment = builder.environments[name];
        if (environment === undefined) throw new Error(`Missing build environment ${name}`);
        await builder.build(environment);
      }
    },
  },
  environments: {
    client: {
      build: { outDir: `${dist}/web`, emptyOutDir: true },
    },
    server: nodeBundle('server', './src/server/main.ts'),
    cli: nodeBundle('cli', './src/cli/main.ts'),
  },
});
