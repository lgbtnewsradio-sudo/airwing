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

/**
 * Whether a receiver needs AirWing's FairPlay screen-mirroring transport (tvOS Apple TVs,
 * 4th generation "AppleTV5,3" and later). These speak the encrypted mirroring protocol
 * rather than the /play HLS path; AirWing now drives that transport for them.
 */
export function needsFairPlay(device: Pick<Device, 'kind' | 'model'>): boolean {
  if (device.kind !== 'airplay' && device.kind !== 'raop') return false;
  const gen = appleTvGeneration(device.model);
  return gen !== null && gen >= 5;
}

/**
 * Why a receiver cannot be used from AirWing, or null if it can. Modern Apple TVs are no
 * longer refused: they are handled by the FairPlay mirroring transport (see needsFairPlay).
 */
export function unsupportedReason(_device: Pick<Device, 'kind' | 'model'>): string | null {
  return null;
}

/** Short label for a receiver that cannot be used, or null. */
export function unsupportedLabel(_device: Pick<Device, 'kind' | 'model'>): string | null {
  return null;
}
