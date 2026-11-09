// PLACEHOLDER (F00) — delete in the next feature

import { describe, expect, it } from 'vitest';
import { greeting } from './greeting.ts';
import { PRODUCT_NAME } from './product.ts';

describe('greeting', () => {
  it('greets the given name from the product', () => {
    expect(greeting('world')).toBe(`Hello, world — from ${PRODUCT_NAME}`);
  });
});
