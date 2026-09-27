/**
 * The Varis API. The only place the hostname appears in the CLI.
 *
 * Paths are appended as `/v1/...`. In production that is api.varis.my/v1/...
 */
export const VARIS_API_ORIGIN = "https://api.varis.my";

/**
 * The API origin this run talks to. `VARIS_API_URL` overrides it, for local
 * development against a running `varis` app, whose routes live under /api:
 *
 *   VARIS_API_URL=http://localhost:3000/api varis login
 *
 * A trailing slash is dropped, so `${apiOrigin()}/v1/...` is always one slash.
 */
export function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VARIS_API_URL?.trim();
  return (override || VARIS_API_ORIGIN).replace(/\/+$/, "");
}
