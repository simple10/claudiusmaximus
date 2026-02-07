import { validateAuth } from "./auth";
import { handlePreflight, addCorsHeaders } from "./cors";
import { jsonError } from "./errors";
import { matchOpenAI, proxyOpenAI } from "./providers/openai";
import { matchAnthropic, proxyAnthropic } from "./providers/anthropic";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return handlePreflight();
    }

    const { pathname } = new URL(request.url);

    // Health check — no auth required
    if (request.method === "GET" && pathname === "/health") {
      return addCorsHeaders(
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Auth check for all other routes
    const authError = await validateAuth(request, env.AUTH_TOKEN);
    if (authError) {
      return addCorsHeaders(jsonError(authError, 401));
    }

    // Route to provider
    let response: Response;

    const openaiPath = matchOpenAI(request.method, pathname);
    if (openaiPath) {
      response = await proxyOpenAI(request, env, openaiPath);
      return addCorsHeaders(response);
    }

    const anthropicPath = matchAnthropic(request.method, pathname);
    if (anthropicPath) {
      response = await proxyAnthropic(request, env, anthropicPath);
      return addCorsHeaders(response);
    }

    return addCorsHeaders(jsonError("Not found", 404));
  },
} satisfies ExportedHandler<Env>;
