import { describe, it, expect, vi } from 'vitest';
import * as store from '../lib/weeklyScheduleStore.js';
import { handleWeeklyScheduleTool } from '../lib/weeklySchedule.js';

describe('handleWeeklyScheduleTool', () => {
  it('forwards entries to the store, returning a summary', async () => {
    const saveSpy = vi.spyOn(store, 'saveWeeklySchedule').mockResolvedValue();

    const result = await handleWeeklyScheduleTool({
      entries: [
        { weekday: 'monday', activityType: 'vélo', avgKcal: 350.6 },
        { weekday: 'thursday', activityType: 'crossfit', avgKcal: 500 },
      ],
    });

    expect(saveSpy).toHaveBeenCalledWith([
      { weekday: 'monday', activityType: 'vélo', avgKcal: 350.6 },
      { weekday: 'thursday', activityType: 'crossfit', avgKcal: 500 },
    ]);
    expect(result).toContain('monday: vélo');
    expect(result).toContain('thursday: crossfit');
  });
});
