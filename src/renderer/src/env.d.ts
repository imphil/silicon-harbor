/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" runs the renderer against the in-memory mock API. */
  readonly VITE_MOCK_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
