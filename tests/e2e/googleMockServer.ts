// ThinkAloud server for the Google sign-in e2e test: identical to server/src/index.ts, except that
// Google's signing certs come from a local test key (GOOGLE_TEST_CERT_FILE) instead of the network.
// ID-token verification itself (signature, audience, issuer, expiry) runs unchanged.
import fs from 'node:fs';
import { OAuth2Client } from 'google-auth-library';

const pem = fs.readFileSync(process.env.GOOGLE_TEST_CERT_FILE!, 'utf8');
const kid = process.env.GOOGLE_TEST_KID || 'e2e-kid';
OAuth2Client.prototype.getFederatedSignonCertsAsync = async function () {
  return { certs: { [kid]: pem }, format: 'PEM' } as unknown as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>;
};
await import('../../server/src/index.ts');
