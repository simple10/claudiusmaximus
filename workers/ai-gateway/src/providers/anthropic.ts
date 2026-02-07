import type { Env } from "../types";

const GW_PATH = "anthropic/v1/messages";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Returns the AI Gateway sub-path if this request matches the Anthropic route, or null. */
export function matchAnthropic(
  method: string,
  pathname: string
): string | null {
  if (method === "POST" && pathname === "/v1/messages") {
    return GW_PATH;
  }
  return null;
}

/** Proxy the request to Anthropic via AI Gateway. */
export function proxyAnthropic(
  request: Request,
  env: Env,
  gwPath: string
): Promise<Response> {
  const url = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/${gwPath}`;

  const headers = new Headers(request.headers);
  // Remove client auth headers before forwarding to upstream
  headers.delete("Authorization");
  headers.delete("x-api-key");
  // Set the real Anthropic API key for upstream
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);
  // Authenticate to Cloudflare AI Gateway
  headers.set("cf-aig-authorization", `Bearer ${env.CF_AI_GATEWAY_TOKEN}`);

  // Ensure anthropic-version is set
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: request.body,
  });
}
