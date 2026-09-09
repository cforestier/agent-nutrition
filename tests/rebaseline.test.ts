import { describe, it, expect, vi } from 'vitest';
import { handleTriggerRebaselineTool } from '../lib/rebaseline.js';
import * as profileLib from '../lib/profile.js';

describe('handleTriggerRebaselineTool', () => {
  it('freezes adjustments by setting baselineStartedAt to today', async () => {
    const spy = vi.spyOn(profileLib, 'setBaselineStartedAt').mockResolvedValue();

    const result = await handleTriggerRebaselineTool({
      date: '2026-09-09',
      reason: 'reprise après blessure',
    });

    expect(spy).toHaveBeenCalledWith('2026-09-09');
    expect(result).toContain('14 jours');
    expect(result).toContain('reprise après blessure');
  });
});
