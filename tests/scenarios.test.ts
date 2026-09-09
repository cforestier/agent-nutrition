import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/db.js';
import { saveScenario, applyDayPlan, buildScenarioSystemPrompt, handleScenarioTool } from '../lib/scenarios.js';

describe('scenarios', () => {
  const marker = `test-${Date.now()}`;
  const scenarioName = `${marker}-crossfit-velo`;
  const impliedName = `${marker}-dort-chez-remi`;
  const day1 = '2026-11-02';
  const day2 = '2026-11-03';

  afterAll(async () => {
    await prisma.scenario.deleteMany({ where: { name: { contains: marker } } });
    await prisma.dayPlan.deleteMany({ where: { date: { in: [day1, day2] } } });
  });

  it('creates a scenario, matches it case-insensitively, and applies it to a day plan', async () => {
    await saveScenario({
      name: impliedName,
      aliases: [`je dors chez rémi`],
      segments: [{ type: 'vélo', durationMin: 15, intensity: 'léger', timing: 'matin' }],
    });

    await saveScenario({
      name: scenarioName,
      aliases: [`crossfit en vélo (${marker})`],
      segments: [{ type: 'crossfit', durationMin: 45, intensity: 'haute', timing: 'matin' }],
      impliesNextDayScenarioName: impliedName,
    });

    const result = await applyDayPlan({
      date: day1,
      scenarioNames: [scenarioName.toUpperCase()],
      isAtypical: false,
    });

    expect(result).toEqual({ resolved: true, unknownNames: [] });

    const savedPlan = await prisma.dayPlan.findUnique({ where: { date: day1 } });
    expect(savedPlan?.confirmed).toBe(true);
    expect(savedPlan?.segmentsResolved).toEqual([
      { type: 'crossfit', durationMin: 45, intensity: 'haute', timing: 'matin' },
    ]);

    const nextDayPlan = await prisma.dayPlan.findUnique({ where: { date: day2 } });
    expect(nextDayPlan?.confirmed).toBe(false);
    expect(nextDayPlan?.scenariosApplied).toHaveLength(1);
  });

  it('reports unknown scenario names without saving anything', async () => {
    const result = await applyDayPlan({ date: '1999-01-01', scenarioNames: [`${marker}-nope`], isAtypical: false });
    expect(result).toEqual({ resolved: false, unknownNames: [`${marker}-nope`] });
    const plan = await prisma.dayPlan.findUnique({ where: { date: '1999-01-01' } });
    expect(plan).toBeNull();
  });

  it('includes known scenarios in the built system prompt', async () => {
    const prompt = await buildScenarioSystemPrompt('BASE', '2026-11-02');
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('2026-11-02');
    expect(prompt).toContain(scenarioName);
  });

  it('handleScenarioTool dispatches create_scenario and apply_day_plan by name', async () => {
    const createMsg = await handleScenarioTool('create_scenario', {
      name: `${marker}-standalone`,
      aliases: ['x'],
      segments: [{ type: 'vélo', durationMin: 10, intensity: 'léger', timing: 'soir' }],
    });
    expect(createMsg).toContain('créé');

    const applyMsg = await handleScenarioTool('apply_day_plan', {
      date: '2026-11-04',
      scenarioNames: [`${marker}-standalone`],
      isAtypical: true,
    });
    expect(applyMsg).toContain('2026-11-04');
    await prisma.dayPlan.deleteMany({ where: { date: '2026-11-04' } });
  });
});
