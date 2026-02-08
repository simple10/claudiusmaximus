/**
 * Validate the Authorization header using timing-safe comparison.
 * Returns null on success, or an error message string on failure.
 */
export async function validateAuth(
  request: Request,
  expectedToken: string
): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return "Missing Authorization header (expected Bearer token)";
  }

  if (!authHeader.startsWith("Bearer ")) {
    return "Authorization header must use Bearer scheme";
  }

  const provided = authHeader.slice(7);
  const match = await timingSafeEqual(provided, expectedToken);
  if (!match) {
    return "Invalid token";
  }

  return null;
}

/** Constant-time string comparison via SHA-256 digest. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);

  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);

  if (viewA.length !== viewB.length) return false;

  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i];
  }
  return result === 0;
}
