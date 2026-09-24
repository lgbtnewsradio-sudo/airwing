import { describe, it, expect } from 'vitest';
import { appleTvGeneration, unsupportedReason, unsupportedLabel, needsFairPlay } from '../../src/shared/support';
import type { DeviceCaps } from '../../src/shared/types';

function caps(overrides: Partial<DeviceCaps> = {}): DeviceCaps {
  return { video: true, audio: true, pairingRequired: false, transientPairing: false, paired: true, ...overrides };
}

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
      expect(needsFairPlay({ kind: 'airplay', model, caps: caps() })).toBe(true);
    }
  });

  it('flags any AirPlay 2 receiver as needing FairPlay mirroring, not just Apple TVs — a third-party smart TV never advertises an AppleTV<gen>,<model> string, but speaks the same encrypted mirroring protocol (real failure: a Roku TV and a Vizio-style "Dallas\'s TV" both paired fine, then got a 404 sending the old /play request instead)', () => {
    expect(needsFairPlay({ kind: 'airplay', model: '55in TCL Roku TV', caps: caps({ airplayVersion: 2 }) })).toBe(true);
    expect(needsFairPlay({ kind: 'airplay', model: undefined, caps: caps({ airplayVersion: 2 }) })).toBe(true);
  });

  it('does not require FairPlay for anything that speaks the ordinary paths', () => {
    expect(needsFairPlay({ kind: 'airplay', model: 'AppleTV3,2', caps: caps({ airplayVersion: 1 }) })).toBe(false); // AirPlay 1
    expect(needsFairPlay({ kind: 'airplay', model: 'AudioAccessory5,1', caps: caps({ airplayVersion: 1 }) })).toBe(false); // HomePod
    expect(needsFairPlay({ kind: 'airplay', model: 'C158X', caps: caps({ airplayVersion: 1 }) })).toBe(false); // AirPlay-1-only Roku
    expect(needsFairPlay({ kind: 'airplay', model: 'AFTHA004', caps: caps({ airplayVersion: 1 }) })).toBe(false); // Fire TV
    expect(needsFairPlay({ kind: 'cast', model: 'Chromecast Ultra', caps: caps({ airplayVersion: 2 }) })).toBe(false); // wrong kind entirely
    expect(needsFairPlay({ kind: 'airplay', model: undefined, caps: caps() })).toBe(false); // no version signal at all
  });

  it('no longer marks any receiver unsupported', () => {
    for (const model of ['AppleTV5,3', 'AppleTV14,1', 'AppleTV3,2', 'C158X', undefined]) {
      expect(unsupportedReason({ kind: 'airplay', model })).toBeNull();
      expect(unsupportedLabel({ kind: 'airplay', model })).toBeNull();
    }
    expect(unsupportedReason({ kind: 'cast', model: 'Chromecast' })).toBeNull();
  });
});
