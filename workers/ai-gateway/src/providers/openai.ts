import type { Env } from "../types";

/** Map of client paths to AI Gateway sub-paths for OpenAI. */
const ROUTE_MAP: Record<string, { method: string; gwPath: string }> = {
  "/v1/chat/completions": { method: "POST", gwPath: "openai/chat/completions" },
  "/v1/embeddings": { method: "POST", gwPath: "openai/embeddings" },
  "/v1/models": { method: "GET", gwPath: "openai/models" },
};

/** Returns the AI Gateway sub-path if this request matches an OpenAI route, or null. */
export function matchOpenAI(
  method: string,
  pathname: string
): string | null {
  const route = ROUTE_MAP[pathname];
  if (route && route.method === method) {
    return route.gwPath;
  }
  return null;
}

/** Proxy the request to OpenAI via AI Gateway. */
export function proxyOpenAI(
  request: Request,
  env: Env,
  gwPath: string
): Promise<Response> {
  const url = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/${gwPath}`;

  const headers = new Headers(request.headers);
  // Replace auth token with OpenAI API key
  headers.set("Authorization", `Bearer ${env.OPENAI_API_KEY}`);
  // Authenticate to Cloudflare AI Gateway
  headers.set("cf-aig-authorization", `Bearer ${env.CF_AI_GATEWAY_TOKEN}`);

  return fetch(url, {
    method: request.method,
    headers,
    body: request.body,
  });
}
