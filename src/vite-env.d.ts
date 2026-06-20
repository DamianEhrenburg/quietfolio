/// <reference types="vite/client" />

import type { QuietfolioApi } from "../electron/preload";

declare global {
  interface Window {
    quietfolio?: QuietfolioApi;
  }
}
