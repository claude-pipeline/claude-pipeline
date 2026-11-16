// #472 (click-to-approve, part A): a click whose tool_result entry Claude Code 2.1.323 writes only AFTER the PostToolUse hooks return is kept as a PENDING pointer at PostToolUse and verified from
// the transcript later, when a consumer reads the owner-go records (settlePendingClicks). Plan: claude-notes/plans/2026-11-16-click-pending-472.md (Rev 4). Temp homes only: accountHome() reads the
// OS account database, so HOME= isolates nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleEnabled } from '../pipeline/hooks/lib/owner-go.mjs';

// ---- Task 1: the test switch --------------------------------------------------------------------------------------------------------------

test('settleEnabled truth table: an explicit option wins; otherwise the environment switch decides', () => {
  const on = {};
  const off = { PIPELINE_CLICK_SETTLE: 'off' };
  assert.equal(settleEnabled(true, off), true, 'settle: true overrides the switch');
  assert.equal(settleEnabled(false, on), false, 'settle: false is read-only');
  assert.equal(settleEnabled(false, off), false);
  assert.equal(settleEnabled(undefined, on), true, 'default: settle');
  assert.equal(settleEnabled(undefined, off), false, 'the test switch');
  assert.equal(settleEnabled(undefined, { PIPELINE_CLICK_SETTLE: 'on' }), true, 'only the exact word off turns it off');
  assert.equal(settleEnabled(undefined, { PIPELINE_CLICK_SETTLE: 'OFF' }), true);
  assert.equal(settleEnabled(null, on), true, 'null is not an explicit option');
  assert.equal(settleEnabled('yes', off), false, 'a non-boolean option is not an opt-in');
});
