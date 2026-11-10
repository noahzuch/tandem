// PLACEHOLDER (F00) — delete in the next feature

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the greeting from /api/hello', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ message: 'Hello, test' })));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(App);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/api/hello');
    expect(wrapper.get('[data-testid="greeting"]').text()).toBe('Hello, test');
    expect(wrapper.text()).toContain('Placeholder page (F00)');
  });

  it('says the server is not reachable when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="greeting"]').text()).toBe('Server not reachable');
  });

  it('says the server is not reachable on an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 500 }))),
    );
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="greeting"]').text()).toBe('Server not reachable');
  });
});
