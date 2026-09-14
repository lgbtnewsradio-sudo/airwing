// FairPlay SAP crypto module — a byte-for-byte TypeScript port of the doubletake
// Go reference implementation. See the individual modules for details.

export {
  fairplayMD5Compress,
  fairplayWordsFromLittleEndian,
  fairplayWordsBigEndian,
  rotl32,
  FairplayMD5Mutation,
} from './md5';

export { fairplaySAPHash, rotl8, sapSeed } from './sap';

export {
  decryptFairPlayMessage,
  encryptFairPlayMessage,
  fairplayMessageIV,
} from './message';

export {
  FpsapSession,
  newFPSAPSession,
  byteSource,
  deriveFairPlayWrappingKey,
  wrapFairPlayKey,
  fpsapExchangeForSAP,
  fpsapDescriptorForSAP,
  decryptFPSAPBody,
  validateFPSAPM4,
} from './fpsap';

export type { ByteSource } from './fpsap';

export type { FpsapByteLookup, FpsapNetworkTables } from './tables';
export {
  fpsapFirstTables,
  fpsapSecondTables,
  fpsapFirstInputMask,
  fpsapSecondOutputMask,
  fpsapSubstitutionBases,
  fpsapMixBases,
  substitute as fpsapSubstitute,
  mix as fpsapMix,
} from './tables';
