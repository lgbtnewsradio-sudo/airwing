import { describe, it, expect } from 'vitest';
import { appleTvGeneration, unsupportedReason, unsupportedLabel, needsFairPlay } from '../../src/shared/support';

/**
 * Receiver support rules. Modern Apple TVs are no longer refused — they are driven through
 * the FairPlay screen-mirroring transport — so nothing here is "unsupported"; instead the
 * rule identifies which receivers need that mirroring path.
 */
describe('receiver support rules', () => {
  it('reads the Apple TV generation from the model string', () => {
    expect(appleTvGeneration('AppleTV5,3')).toBe(5);
    expect(appleTvGeneration('AppleTV14,1')).toBe(14);
    expect(appleTvGeneration('AppleTV3,2')).toBe(3);
    expect(appleTvGeneration('AudioAccessory5,1')).toBeNull();
    expect(appleTvGeneration(undefined)).toBeNull();
  });

  it('flags tvOS Apple TVs as needing the FairPlay mirroring transport', () => {
    for (const model of ['AppleTV5,3', 'AppleTV6,2', 'AppleTV11,1', 'AppleTV14,1']) {
      expect(needsFairPlay({ kind: 'airplay', model })).toBe(true);
    }
  });

  it('does not require FairPlay for anything that speaks the ordinary paths', () => {
    expect(needsFairPlay({ kind: 'airplay', model: 'AppleTV3,2' })).toBe(false); // AirPlay 1
    expect(needsFairPlay({ kind: 'airplay', model: 'AudioAccessory5,1' })).toBe(false); // HomePod
    expect(needsFairPlay({ kind: 'airplay', model: 'C158X' })).toBe(false); // Roku
    expect(needsFairPlay({ kind: 'airplay', model: 'AFTHA004' })).toBe(false); // Fire TV
    expect(needsFairPlay({ kind: 'cast', model: 'Chromecast Ultra' })).toBe(false);
    expect(needsFairPlay({ kind: 'airplay', model: undefined })).toBe(false);
  });

  it('no longer marks any receiver unsupported', () => {
    for (const model of ['AppleTV5,3', 'AppleTV14,1', 'AppleTV3,2', 'C158X', undefined]) {
      expect(unsupportedReason({ kind: 'airplay', model })).toBeNull();
      expect(unsupportedLabel({ kind: 'airplay', model })).toBeNull();
    }
    expect(unsupportedReason({ kind: 'cast', model: 'Chromecast' })).toBeNull();
  });
});
