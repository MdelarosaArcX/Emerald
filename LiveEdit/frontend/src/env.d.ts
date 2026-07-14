/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL of the main Emerald backend — see .env.example. LiveEdit runs on a separate
  // machine from that backend, so this is always an absolute cross-server URL, never relative.
  readonly VITE_EMERALD_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
