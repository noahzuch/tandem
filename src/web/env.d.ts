// Lets tools that use the plain TypeScript compiler (typescript-eslint) type `.vue` imports.
// vue-tsc type-checks the real component types.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
