import geminiModule from '../gemini.js';

export default async function handler(request) {
  // Vercel's request object is already a Web Standard Request object,
  // which is what gemini.js's fetch handler expects.

  // Create the environment object from Vercel's environment variables.
  const workerEnv = {
    UPSTREAM_URL_BASE: process.env.UPSTREAM_URL_BASE || 'https://generativelanguage.googleapis.com',
    MAX_CONSECUTIVE_RETRIES: parseInt(process.env.MAX_CONSECUTIVE_RETRIES) || 3,
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 750,
    LOG_TRUNCATION_LIMIT: parseInt(process.env.LOG_TRUNCATION_LIMIT) || 8000,
  };

  // Call the fetch handler from gemini.js and return the response.
  // Vercel's runtime can handle the Web Standard Response object directly,
  // including streaming responses.
  return geminiModule.fetch(request, workerEnv);
}
