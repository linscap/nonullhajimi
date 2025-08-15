import geminiModule from '../gemini.js';

export default async function handler(request) {
  // The comment below was incorrect. Vercel's incoming request object in the Node.js
  // runtime is NOT a standard Web Request object. We must construct one manually
  // for gemini.js to work correctly.

  // 1. Construct a full URL. The host doesn't matter as much as the path.
  const url = new URL(request.url, `https://${request.headers.host || 'localhost'}`);

  // 2. Create a standard Headers object from Vercel's plain object.
  const headers = new Headers(request.headers);

  // 3. Create the standard Request object that gemini.js expects.
  const standardRequest = new Request(url, {
    method: request.method,
    headers: headers,
    body: request.body,
    duplex: 'half' // Required for streams in Node.js
  });

  // Create the environment object from Vercel's environment variables.
  const workerEnv = {
    UPSTREAM_URL_BASE: process.env.UPSTREAM_URL_BASE || 'https://generativelanguage.googleapis.com',
    MAX_CONSECUTIVE_RETRIES: parseInt(process.env.MAX_CONSECUTIVE_RETRIES) || 3,
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 750,
    LOG_TRUNCATION_LIMIT: parseInt(process.env.LOG_TRUNCATION_LIMIT) || 8000,
  };

  // Call the fetch handler from gemini.js with the compliant request object.
  return geminiModule.fetch(standardRequest, workerEnv);
}
