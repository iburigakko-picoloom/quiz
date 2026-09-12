// Never print key contents, including on validation failures.
const url = process.env.VITE_SUPABASE_URL?.trim();
const key = process.env.VITE_SUPABASE_ANON_KEY?.trim();
let valid = false;
try {
  valid = Boolean(url && new URL(url).protocol === 'https:' && key);
  if (key?.startsWith('sb_publishable_')) {
    valid &&= key.length > 20;
  } else {
    const payload = JSON.parse(Buffer.from((key ?? '').split('.')[1] ?? '', 'base64url').toString());
    valid &&= payload.role === 'anon';
  }
} catch { valid = false; }
if (!valid) {
  console.error('Native build requires an HTTPS VITE_SUPABASE_URL and a public publishable/anon key. Never use a secret or service_role key.');
  process.exitCode = 1;
} else console.log('Native public client configuration is present.');
