import type { AirWingApi } from './index';

declare global {
  interface Window {
    airwing: AirWingApi;
  }
}

export {};
