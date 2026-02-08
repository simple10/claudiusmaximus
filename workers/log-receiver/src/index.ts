import { validateAuth } from "./auth";
import { handlePreflight, addCorsHeaders } from "./cors";
import { jsonError } from "./errors";
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

    // POST /logs — receive log events from Vector
    if (request.method === "POST" && pathname === "/logs") {
      const authError = await validateAuth(request, env.AUTH_TOKEN);
      if (authError) {
        return addCorsHeaders(jsonError(authError, 401));
      }

      return addCorsHeaders(await handleLogs(request));
    }

    return addCorsHeaders(jsonError("Not found", 404));
  },
} satisfies ExportedHandler<Env>;

/**
 * Handle incoming log events from Vector.
 *
 * Vector's HTTP sink with encoding.codec = "json" sends newline-delimited JSON.
 * Each line is one log event with fields like container_name, message, stream, timestamp.
 * We console.log() each event — Cloudflare captures Worker console output via
 * real-time Logs dashboard and Logpush.
 */
async function handleLogs(request: Request): Promise<Response> {
  const body = await request.text();
  if (!body.trim()) {
    return jsonError("Empty request body", 400);
  }

  const lines = body.trim().split("\n");
  let count = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);
      // Cloudflare captures this via real-time Logs and Logpush
      console.log(JSON.stringify(entry));
      count++;
    } catch {
      // Log parse failures but don't reject the whole batch
      console.error(`Failed to parse log line: ${line.slice(0, 200)}`);
    }
  }

  return new Response(JSON.stringify({ status: "ok", count }), {
    headers: { "Content-Type": "application/json" },
  });
}
