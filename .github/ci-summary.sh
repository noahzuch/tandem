#!/usr/bin/env bash
# Adds "✅ <check> passed" to the GitHub job summary; called by the -ci tasks after the check succeeded.
# Does nothing outside GitHub Actions.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "✅ $1 passed" >>"$GITHUB_STEP_SUMMARY"
fi
