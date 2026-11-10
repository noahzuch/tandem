// PLACEHOLDER (F00) — delete in the next feature
// CI REPORT DEMO — deliberate failures to inspect the CI summary and annotations; never merge.

import { expect, stop, test } from './fixtures.ts';

test('tandem serve shows the greeting from the server and stops on Ctrl+C', async ({ page, startCli }) => {
  const cli = await startCli(['serve']);
  expect(cli.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

  await page.goto(cli.url);
  await expect(page.getByTestId('greeting')).toHaveText(/^Goodbye, world — from \w+$/);
  await expect(page.getByText('Placeholder page (F00)')).toBeVisible();

  expect(await stop(cli.process)).toBe(0);
});
