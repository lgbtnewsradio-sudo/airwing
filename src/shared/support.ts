/**
 * Receiver support rules shared by the renderer (row labels) and the main process
 * (connection logic), so the two can never disagree about what will work.
 */

import type { Device } from './types';

/** Apple TV model generation from a model string such as "AppleTV5,3", or null. */
export function appleTvGeneration(model?: string): number | null {
  const m = /^AppleTV(\d+),/i.exec(model ?? '');
  return m ? parseInt(m[1], 10) : null;
}

export const APPLE_TV_REASON =
  'tvOS only accepts a screen stream from senders that pass Apple\'s FairPlay authentication, which AirWing does not implement. ' +
  'Measured on this network: the Apple TV accepts the request, shows its loading spinner, never fetches a single byte, and gives up. ' +
  'Chromecast, AirPlay speakers and the browser receiver all work.';

/** Compact form for a list row. */
export const APPLE_TV_SHORT = 'Apple TV · needs Apple FairPlay, not supported';

/**
 * Why a receiver cannot be used from AirWing, or null if it can.
 *
 * Only Apple TVs running tvOS are refused (4th generation "AppleTV5,3" and later). Verified
 * against a real device: it answers /fp-setup with a 142-byte FairPlay message, and it
 * ignores video handed to it by an unlicensed sender, including Apple's own reference
 * stream. Older Apple TV 3 units speak AirPlay 1 and do play third-party video, so they are
 * deliberately not caught by this rule.
 */
export function unsupportedReason(device: Pick<Device, 'kind' | 'model'>): string | null {
  if (device.kind !== 'airplay' && device.kind !== 'raop') return null;
  const gen = appleTvGeneration(device.model);
  if (gen !== null && gen >= 5) return APPLE_TV_REASON;
  return null;
}

/** Short label for the same rule, or null when the receiver is usable. */
export function unsupportedLabel(device: Pick<Device, 'kind' | 'model'>): string | null {
  return unsupportedReason(device) ? APPLE_TV_SHORT : null;
}
