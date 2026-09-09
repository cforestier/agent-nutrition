import { describe, it, expect, vi } from 'vitest';
import * as profileLib from '../lib/profile.js';
import { handleFlagConcernTool } from '../lib/safety.js';

describe('handleFlagConcernTool', () => {
  it('flags the profile with the given reason and returns enforcement instructions', async () => {
    const flagSpy = vi.spyOn(profileLib, 'flagEdSignal').mockResolvedValue();

    const result = await handleFlagConcernTool({ reason: 'obsession répétée du chiffre calorique' });

    expect(flagSpy).toHaveBeenCalledWith('obsession répétée du chiffre calorique');
    expect(result).toContain('plus aucune cible chiffrée');
  });
});
