/// <reference types="vite/client" />

import type { AppApi } from '../../shared/types';

declare global {
  interface Window {
    workstation: AppApi;
  }
}
