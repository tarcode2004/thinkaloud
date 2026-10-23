// "Sign in with Google": verify a Google Identity Services ID token (JWT) on the server.
// The browser gets the token from the official GIS button / One Tap and posts it to POST /api/auth/google.
import { OAuth2Client } from 'google-auth-library';
import { HttpError } from './http.ts';

/** Read at call time so the provider can be switched by env without a code change (and in tests). */
export function googleConfig(): { clientId: string; oneTap: boolean } | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) return null;
  return { clientId, oneTap: /^(1|true|yes|on)$/i.test(process.env.GOOGLE_ONE_TAP || '') };
}

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let client: OAuth2Client | null = null;
let clientFor = '';
function oauthClient(clientId: string) {
  // One client per client id: it caches Google's signing certs between requests.
  if (!client || clientFor !== clientId) {
    client = new OAuth2Client({ clientId });
    clientFor = clientId;
  }
  return client;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

/**
 * Verify signature, audience, issuer and expiry (google-auth-library), then require a verified email.
 * Throws HttpError with plain copy the sign-in page shows as is.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const cfg = googleConfig();
  if (!cfg) throw new HttpError(404, 'Google sign-in is not set up on this server.');
  let payload;
  try {
    const ticket = await oauthClient(cfg.clientId).verifyIdToken({ idToken, audience: cfg.clientId });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'Google sign-in didn’t work. Try again, or use your email and password.');
  }
  // Belt and braces: the library already checked these, but a wrong audience or issuer must never pass.
  if (!payload || payload.aud !== cfg.clientId || !ISSUERS.includes(payload.iss) || !payload.sub || !payload.email) {
    throw new HttpError(401, 'Google sign-in didn’t work. Try again, or use your email and password.');
  }
  if (payload.email_verified !== true) {
    throw new HttpError(403, 'Your Google account’s email isn’t verified yet. Verify it with Google, or use your email.');
  }
  const email = payload.email.toLowerCase();
  const name = (payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ') || email.split('@')[0]).trim().slice(0, 100);
  const picture = typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture.slice(0, 1000) : null;
  return { sub: payload.sub, email, name, picture };
}
