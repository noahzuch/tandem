// PLACEHOLDER (F00) — delete in the next feature

import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

describe('web main', () => {
  it('mounts the app into #app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ message: 'Hello, page' }))),
    );
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main.ts');
    await flushPromises();
    expect(document.querySelector('#app')?.textContent).toContain('Hello, page');
    vi.unstubAllGlobals();
  });
});
