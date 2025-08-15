/**
 * @fileoverview Vercel Serverless Function for Gemini API proxy.
 * Combines the Vercel handler with the core Gemini proxy logic.
 * Features robust streaming retry to handle premature stream termination and empty replies.
 * @version 4.0.0
 * @license MIT
 */

// --- Start of Core Gemini Proxy Logic ---

const CONFIG = {
  upstream_url_base: "https://generativelanguage.googleapis.com",
  max_consecutive_retries: 20,
  debug_mode: true,
  retry_delay_ms: 750,
  log_truncation_limit: 8000
};

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 429]);

const logDebug = (...args) => { if (CONFIG.debug_mode) console.log(`[DEBUG ${new Date().toISOString()}]`, ...args); };
const logInfo  = (...args) => console.log(`[INFO ${new Date().toISOString()}]`, ...args);
const logError = (...args) => console.error(`[ERROR ${new Date().toISOString()}]`, ...args);

const truncate = (s, n = CONFIG.log_truncation_limit) => {
  if (typeof s !== "string") return s;
  return s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s;
};

const handleOPTIONS = () => new Response(null, {
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Goog-Api-Key",
  },
});

const jsonError = (status, message, details = null) => {
  return new Response(JSON.stringify({ error: { code: status, message, status: statusToGoogleStatus(status), details } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
};

function statusToGoogleStatus(code) {
  if (code === 400) return "INVALID_ARGUMENT";
  if (code === 401) return "UNAUTHENTICATED";
  if (code === 403) return "PERMISSION_DENIED";
  if (code === 404) return "NOT_FOUND";
  if (code === 429) return "RESOURCE_EXHAUSTED";
  if (code === 500) return "INTERNAL";
  if (code === 503) return "UNAVAILABLE";
  if (code === 504) return "DEADLINE_EXCEEDED";
  return "UNKNOWN";
}

function buildUpstreamHeaders(reqHeaders) {
  const h = new Headers();
  const copy = (k) => { const v = reqHeaders.get(k); if (v) h.set(k, v); };
  copy("authorization");
  copy("x-goog-api-key");
  copy("content-type");
  copy("accept");
  return h;
}

async function standardizeInitialError(initialResponse) {
  let upstreamText = "";
  try {
    upstreamText = await initialResponse.clone().text();
    logError(`Upstream error body: ${truncate(upstreamText)}`);
  } catch (e) {
    logError(`Failed to read upstream error text: ${e.message}`);
  }

  let standardized = null;
  if (upstreamText) {
    try {
      const parsed = JSON.parse(upstreamText);
      if (parsed && parsed.error && typeof parsed.error === "object" && typeof parsed.error.code === "number") {
        if (!parsed.error.status) parsed.error.status = statusToGoogleStatus(parsed.error.code);
        standardized = parsed;
      }
    } catch (_) {}
  }

  if (!standardized) {
    const code = initialResponse.status;
    const message = code === 429 ? "Resource has been exhausted (e.g. check quota)." : (initialResponse.statusText || "Request failed");
    const status = statusToGoogleStatus(code);
    standardized = {
      error: {
        code,
        message,
        status,
        details: upstreamText ? [{ "@type": "proxy.upstream", upstream_error: truncate(upstreamText) }] : undefined
      }
    };
  }

  const safeHeaders = new Headers();
  safeHeaders.set("Content-Type", "application/json; charset=utf-8");
  safeHeaders.set("Access-Control-Allow-Origin", "*");
  safeHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Goog-Api-Key");
  const retryAfter = initialResponse.headers.get("Retry-After");
  if (retryAfter) safeHeaders.set("Retry-After", retryAfter);

  return new Response(JSON.stringify(standardized), {
    status: initialResponse.status,
    statusText: initialResponse.statusText,
    headers: safeHeaders
  });
}

const SSE_ENCODER = new TextEncoder();
async function writeSSEErrorFromUpstream(writer, upstreamResp) {
  const std = await standardizeInitialError(upstreamResp);
  let text = await std.text();
  const ra = upstreamResp.headers.get("Retry-After");
  if (ra) {
    try {
      const obj = JSON.parse(text);
      obj.error.details = (obj.error.details || []).concat([{ "@type": "proxy.retry", retry_after: ra }]);
      text = JSON.stringify(obj);
    } catch (_) {}
  }
  await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${text}\n\n`));
}

async function* sseLineIterator(reader) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  logDebug("Starting SSE line iteration.");
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      logDebug(`SSE stream ended. Remaining buffer: "${buffer.trim()}"`);
      if (buffer.trim()) yield buffer;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        yield line;
      }
    }
  }
}

function buildRetryRequestBody(originalBody, accumulatedText) {
  logDebug(`Building retry request. Accumulated text length: ${accumulatedText.length}`);
  logDebug(`Accumulated text preview (includes thoughts): ${truncate(accumulatedText, 500)}`);
  
  const retryBody = JSON.parse(JSON.stringify(originalBody));
  if (!retryBody.contents) retryBody.contents = [];

  const lastUserIndex = retryBody.contents.map(c => c.role).lastIndexOf("user");

  const history = [
    { role: "model", parts: [{ text: accumulatedText }] },
    { role: "user", parts: [{ text: "Continue exactly where you left off, providing the final answer without repeating the previous thinking steps." }] }
  ];

  if (lastUserIndex !== -1) {
    retryBody.contents.splice(lastUserIndex + 1, 0, ...history);
  } else {
    retryBody.contents.push(...history);
  }
  
  logDebug(`Constructed retry request body: ${truncate(JSON.stringify(retryBody))}`);
  return retryBody;
}

async function processStreamAndRetryInternally({ initialReader, writer, originalRequestBody, upstreamUrl, originalHeaders }) {
  let accumulatedText = "";
  let consecutiveRetryCount = 0;
  let currentReader = initialReader;
  const sessionStartTime = Date.now();

  logInfo(`Starting stream processing session. Max retries: ${CONFIG.max_consecutive_retries}`);

  const cleanup = (reader) => { if (reader) { logDebug("Cancelling reader"); reader.cancel().catch(() => {}); } };

  while (true) {
    let interruptionReason = null;
    const streamStartTime = Date.now();
    let linesInThisStream = 0;
    let textInThisStream = "";
    let reasoningStepDetected = false;
    let hasReceivedFinalAnswerContent = false;

    logInfo(`=== Starting stream attempt ${consecutiveRetryCount + 1}/${CONFIG.max_consecutive_retries + 1} ===`);

    try {
      let finishReasonArrived = false;

      for await (const line of sseLineIterator(currentReader)) {
        linesInThisStream++;
        await writer.write(new TextEncoder().encode(line + "\n\n"));
        logDebug(`SSE Line ${linesInThisStream}: ${truncate(line, 500)}`);

        if (!line.startsWith("data: ")) continue;

        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch (e) {
          logDebug("Ignoring non-JSON data line.");
          continue;
        }

        const candidate = payload?.candidates?.[0];
        if (!candidate) continue;

        const parts = candidate.content?.parts;
        if (parts && Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part.text === 'string') {
              accumulatedText += part.text;
              textInThisStream += part.text;
              if (part.thought !== true) {
                hasReceivedFinalAnswerContent = true;
                logDebug("Received final answer content (non-thought part).");
              } else {
                logDebug("Received 'thought' content part.");
              }
            } else if (part.functionCall || part.toolCode) {
              reasoningStepDetected = true;
              logInfo(`Reasoning step detected (tool/function call): ${truncate(JSON.stringify(part))}`);
            }
          }
        }

        const finishReason = candidate.finishReason;
        if (finishReason) {
            finishReasonArrived = true;
            logInfo(`Finish reason received: ${finishReason}`);

            if (finishReason === "STOP") {
                if (hasReceivedFinalAnswerContent) {
                    const sessionDuration = Date.now() - sessionStartTime;
                    logInfo(`=== STREAM COMPLETED SUCCESSFULLY (Reason: STOP after receiving final answer) ===`);
                    logInfo(`  - Total session duration: ${sessionDuration}ms, Retries: ${consecutiveRetryCount}`);
                    return writer.close();
                } else {
                    logError(`Stream finished with STOP but no final answer content was received. This is a failure.`);
                    interruptionReason = "STOP_WITHOUT_ANSWER";
                    break;
                }
            } else if (["MAX_TOKENS", "TOOL_CODE", "SAFETY", "RECITATION"].includes(finishReason)) {
                 logInfo(`Stream terminated with reason: ${finishReason}. Closing stream.`);
                 return writer.close();
            } else {
                 logError(`Abnormal/unknown finish reason: ${finishReason}`);
                 interruptionReason = "FINISH_ABNORMAL";
                 break;
            }
        }
      }

      if (!finishReasonArrived && !interruptionReason) {
        logError(`Stream ended prematurely without a finish reason (DROP).`);
        interruptionReason = reasoningStepDetected ? "DROP_DURING_REASONING" : "DROP";
      }

    } catch (e) {
      logError(`Exception during stream processing:`, e.message, e.stack);
      interruptionReason = "FETCH_ERROR";
    } finally {
      cleanup(currentReader);
      logInfo(`Stream attempt ${consecutiveRetryCount + 1} summary: Duration: ${Date.now() - streamStartTime}ms, ` + 
              `Lines: ${linesInThisStream}, Chars: ${textInThisStream.length}, Total Chars: ${accumulatedText.length}`);
    }

    if (!interruptionReason) {
      logInfo("Stream finished without interruption. Closing.");
      return writer.close();
    }

    logError(`=== STREAM INTERRUPTED (Reason: ${interruptionReason}) ===`);
    
    if (consecutiveRetryCount >= CONFIG.max_consecutive_retries) {
      logError("Retry limit exceeded. Sending final error to client.");
      const payload = {
        error: { code: 504, status: "DEADLINE_EXCEEDED", message: `Proxy retry limit (${CONFIG.max_consecutive_retries}) exceeded. Last interruption: ${interruptionReason}.`}
      };
      await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
      return writer.close();
    }

    consecutiveRetryCount++;
    logInfo(`Proceeding to retry attempt ${consecutiveRetryCount}...`);

    try {
      if (CONFIG.retry_delay_ms > 0) {
        logDebug(`Waiting ${CONFIG.retry_delay_ms}ms before retrying...`);
        await new Promise(res => setTimeout(res, CONFIG.retry_delay_ms));
      }
      
      const retryBody = buildRetryRequestBody(originalRequestBody, accumulatedText);
      const retryHeaders = buildUpstreamHeaders(originalHeaders);

      logDebug(`Making retry request to: ${upstreamUrl}`);
      const retryResponse = await fetch(upstreamUrl, { method: "POST", headers: retryHeaders, body: JSON.stringify(retryBody) });
      logInfo(`Retry request completed. Status: ${retryResponse.status} ${retryResponse.statusText}`);

      if (NON_RETRYABLE_STATUSES.has(retryResponse.status)) {
        logError(`FATAL: Received non-retryable status ${retryResponse.status} during retry.`);
        await writeSSEErrorFromUpstream(writer, retryResponse);
        return writer.close();
      }

      if (!retryResponse.ok || !retryResponse.body) {
        throw new Error(`Upstream server error on retry: ${retryResponse.status}`);
      }
      
      logInfo(`✓ Retry successful. Got new stream.`);
      currentReader = retryResponse.body.getReader();
    } catch (e) {
      logError(`Exception during retry setup:`, e.message);
    }
  }
}

async function handleStreamingPost(request, env) {
    let requestUrlStr = request.url.toString();
    let urlObj = new URL(requestUrlStr);
    
    const upstreamUrl = `${CONFIG.upstream_url_base}${urlObj.pathname}${urlObj.search}`;
    logInfo(`=== NEW STREAMING REQUEST: ${request.method} ${requestUrlStr} ===`);
  
    let originalRequestBody;
    try {
      const requestText = await request.clone().text();
      logInfo(`Request body (raw, ${requestText.length} bytes): ${truncate(requestText)}`);
      originalRequestBody = JSON.parse(requestText);
    } catch (e) {
      logError("Failed to parse request body:", e.message);
      return jsonError(400, "Invalid JSON in request body", e.message);
    }
  
    const initialRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers),
      body: JSON.stringify(originalRequestBody),
      duplex: "half"
    });
  
    const t0 = Date.now();
    const initialResponse = await fetch(initialRequest);
    logInfo(`Initial upstream response received in ${Date.now() - t0}ms. Status: ${initialResponse.status}`);
  
    if (!initialResponse.ok) {
      logError(`Initial request failed with status ${initialResponse.status}.`);
      return await standardizeInitialError(initialResponse);
    }
  
    const initialReader = initialResponse.body?.getReader();
    if (!initialReader) {
      return jsonError(502, "Bad Gateway", "Upstream returned a success code but the response body is missing.");
    }
  
    const { readable, writable } = new TransformStream();
    
    processStreamAndRetryInternally({
      initialReader,
      writer: writable.getWriter(),
      originalRequestBody,
      upstreamUrl,
      originalHeaders: request.headers
    }).catch(e => {
      logError("!!! UNHANDLED CRITICAL EXCEPTION IN STREAM PROCESSOR !!!", e.message, e.stack);
      try { writable.getWriter().close(); } catch (_) {}
    });
  
    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    });
}
  
async function handleNonStreaming(request, env) {
    let requestUrlStr = request.url.toString();
    let url = new URL(requestUrlStr);
    
    const upstreamUrl = `${CONFIG.upstream_url_base}${url.pathname}${url.search}`;
    logInfo(`=== NEW NON-STREAMING REQUEST: ${request.method} ${requestUrlStr} ===`);
  
    const requestBody = await request.text();
    logInfo(`Request body (raw, ${requestBody.length} bytes): ${truncate(requestBody)}`);

    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers),
      body: requestBody,
      duplex: 'half',
    });
  
    const resp = await fetch(upstreamReq);
    if (!resp.ok) return await standardizeInitialError(resp);
  
    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}
  
async function fetchProxy(request, env) {
    try {
      Object.assign(CONFIG, env);
      if (request.method === "OPTIONS") return handleOPTIONS();
      
      const url = new URL(request.url);
      const isStream = url.searchParams.get("alt") === "sse";

      if (request.method === "POST" && isStream) {
        return await handleStreamingPost(request, env);
      }
      return await handleNonStreaming(request, env);
    } catch (e) {
      logError("!!! TOP-LEVEL WORKER EXCEPTION !!!", e.message, e.stack);
      return jsonError(500, "Internal Server Error", "The proxy worker encountered a critical error.");
    }
}

// --- End of Core Gemini Proxy Logic ---


// --- Vercel Serverless Handler ---

async function getRequestBody(request) {
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body;
      body += decoder.decode(value);
    }
  }
  return null;
}

export default async function handler(request) {
  const requestBodyString = await getRequestBody(request);
  const url = new URL(request.url, `https://${request.headers.host || 'localhost'}`);
  const headers = new Headers(request.headers);

  const standardRequest = new Request(url, {
    method: request.method,
    headers: headers,
    body: requestBodyString,
  });

  const workerEnv = {
    UPSTREAM_URL_BASE: process.env.UPSTREAM_URL_BASE || 'https://generativelanguage.googleapis.com',
    MAX_CONSECUTIVE_RETRIES: parseInt(process.env.MAX_CONSECUTIVE_RETRIES) || 3,
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 750,
    LOG_TRUNCATION_LIMIT: parseInt(process.env.LOG_TRUNCATION_LIMIT) || 8000,
  };

  return fetchProxy(standardRequest, workerEnv);
}
