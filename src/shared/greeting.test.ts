// PLACEHOLDER (F00) — delete in the next feature
// CI REPORT DEMO — deliberate failures to inspect the CI summary and annotations; never merge.

import { describe, expect, it } from 'vitest';
import { greeting } from './greeting.ts';
import { PRODUCT_NAME } from './product.ts';

describe('greeting', () => {
  it('greets the given name from the product', () => {
    expect(greeting('world')).toBe(`Hi, world — from ${PRODUCT_NAME}`);
  });
});
