/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** auth-provider API origin (the ONE base URL every auth endpoint derives from). */
  readonly VITE_AUTH_API_BASE_URL: string;
  /** Registered public client id. */
  readonly VITE_AUTH_CLIENT_ID: string;
  /** Pre-registered callback URL — must match the registration exactly. */
  readonly VITE_AUTH_REDIRECT_URI: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}