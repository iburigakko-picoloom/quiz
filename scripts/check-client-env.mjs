// Build-time checks only. Never print credentials, including on failure.
import { pathToFileURL } from 'node:url';

export function validateClientEnvironment(env) {
  const rawUrl = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  const expectedRef = env.QUIZMAKE_EXPECTED_SUPABASE_PROJECT_REF?.trim();
  const provider = env.VITE_LINE_AUTH_PROVIDER?.trim();
  let url;
  try { url = new URL(rawUrl); } catch { return 'A valid Supabase HTTPS URL is required.'; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.port || !['', '/'].includes(url.pathname)) {
    return 'Supabase URL must be an HTTPS origin without credentials, a query or a path.';
  }
  const hostedRef = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
  if (expectedRef && (!/^[a-z0-9]{20}$/.test(expectedRef) || expectedRef !== hostedRef)) {
    return 'Supabase URL does not match the approved project reference. Cutover is blocked.';
  }
  if (!key || key.startsWith('sb_secret_')) {
    return 'A public publishable/anon key is required. Never use a secret or service_role key.';
  }
  if (key.startsWith('sb_publishable_')) {
    if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return 'Invalid public publishable key format.';
    // Publishable keys do not encode a project ref. A live read-only API check is
    // still required in the cutover rehearsal; this is not credential verification.
  } else {
    try {
      const segments = key.split('.');
      if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
        return 'Invalid public anon key format.';
      }
      const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
      if (payload.role !== 'anon') return 'Only a public anon key may be included in the app.';
      if (hostedRef && payload.ref !== hostedRef) return 'Supabase URL and anon key belong to different projects.';
    } catch { return 'Invalid public anon key format.'; }
  }
  if (provider && !['custom:line', 'custom:quizmake-line'].includes(provider)) {
    return 'Unsupported LINE provider. Verify the provider before building.';
  }
  return null;
}

export function checkClientEnvironment(env = process.env) {
  const error = validateClientEnvironment(env);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return false;
  }
  console.log('Public client configuration passed offline safety checks. Live login/API verification is still required.');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkClientEnvironment();
