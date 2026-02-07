export interface Env {
  // Vars (wrangler.toml)
  ACCOUNT_ID: string;
  GATEWAY_ID: string;

  // Secrets (wrangler secret put)
  AUTH_TOKEN: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}
