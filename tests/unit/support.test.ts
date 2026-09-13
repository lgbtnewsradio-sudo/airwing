import { describe, it, expect } from 'vitest';
import { appleTvGeneration, unsupportedReason, unsupportedLabel } from '../../src/shared/support';

/**
 * The rule that stops AirWing spinning for 12 seconds against an Apple TV that will never
 * play third-party video. It must catch tvOS devices without catching anything that works.
 */
describe('receiver support rules', () => {
  it('reads the Apple TV generation from the model string', () => {
    expect(appleTvGeneration('AppleTV5,3')).toBe(5);
    expect(appleTvGeneration('AppleTV14,1')).toBe(14);
    expect(appleTvGeneration('AppleTV3,2')).toBe(3);
    expect(appleTvGeneration('AudioAccessory5,1')).toBeNull();
    expect(appleTvGeneration(undefined)).toBeNull();
  });

  it('refuses tvOS Apple TVs, which require FairPlay', () => {
    for (const model of ['AppleTV5,3', 'AppleTV6,2', 'AppleTV11,1', 'AppleTV14,1']) {
      expect(unsupportedReason({ kind: 'airplay', model })).toMatch(/FairPlay/);
      expect(unsupportedLabel({ kind: 'airplay', model })).toMatch(/FairPlay/);
    }
  });

  it('still allows everything that actually works', () => {
    // Apple TV 3 speaks AirPlay 1 and does play third-party video.
    expect(unsupportedReason({ kind: 'airplay', model: 'AppleTV3,2' })).toBeNull();
    // HomePod and other AirPlay speakers are fine.
    expect(unsupportedReason({ kind: 'airplay', model: 'AudioAccessory5,1' })).toBeNull();
    // Roku, Fire TV and other AirPlay 2 TVs are fine.
    expect(unsupportedReason({ kind: 'airplay', model: 'C158X' })).toBeNull();
    expect(unsupportedReason({ kind: 'airplay', model: 'AFTHA004' })).toBeNull();
    // Chromecast is a different protocol entirely.
    expect(unsupportedReason({ kind: 'cast', model: 'Chromecast Ultra' })).toBeNull();
    // A receiver that never reported a model must not be blocked.
    expect(unsupportedReason({ kind: 'airplay', model: undefined })).toBeNull();
    expect(unsupportedLabel({ kind: 'cast', model: 'Chromecast' })).toBeNull();
  });
});
