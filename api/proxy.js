import { fetch as nodeFetch } from 'node-fetch';
import { handleRequest } from '../lib/gemini.js';

// Polyfill global fetch if needed
if (!global.fetch) {
  global.fetch = nodeFetch;
}

// Vercel serverless function
export default async function handler(req, res) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Goog-Api-Key');
    res.status(200).end();
    return;
  }

  try {
    // Create an environment object from process.env
    const env = {
      UPSTREAM_URL_BASE: process.env.UPSTREAM_URL_BASE || 'https://generativelanguage.googleapis.com',
      MAX_CONSECUTIVE_RETRIES: parseInt(process.env.MAX_CONSECUTIVE_RETRIES) || 3,
      DEBUG_MODE: process.env.DEBUG_MODE === 'true',
      RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 750,
      LOG_TRUNCATION_LIMIT: parseInt(process.env.LOG_TRUNCATION_LIMIT) || 8000
    };

    // Create headers object from req.headers
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        headers.set(key, value);
      }
    });

    // Create a fetch-compatible request object
    const request = {
      url: `https://${req.headers.host}${req.url}`,
      method: req.method,
      headers: headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      clone: function() {
        return {
          url: this.url,
          method: this.method,
          headers: new Headers(this.headers),
          body: this.body,
          clone: this.clone,
          text: async function() {
            return this.body || '';
          }
        };
      },
      text: async function() {
        return this.body || '';
      }
    };

    // Handle the request using our gemini module
    const response = await handleRequest(request, env);

    // Set response headers
    Object.entries(response.headers.entries()).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    // Set status code
    res.status(response.status);

    // Handle streaming response or normal response
    if (response.body && typeof response.body.getReader === 'function') {
      // Handle streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const reader = response.body.getReader();
      
      // Stream the response
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      // Handle normal response
      res.send(response.body);
    }
  } catch (error) {
    console.error('Error in serverless function:', error);
    res.status(500).json({
      error: {
        code: 500,
        message: 'Internal Server Error',
        status: 'INTERNAL',
        details: error.message
      }
    });
  }
}

// Enable handling of request body
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};
