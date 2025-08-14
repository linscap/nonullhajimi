/**
 * @fileoverview Vercel Function proxy for Gemini API with robust streaming retry and standardized error responses.
 * Handles model's "thought" process and can filter thoughts after retries to maintain a clean output stream.
 * @version 3.9.0
 * @license MIT
 */

const CONFIG = {
  upstream_url_base: "https://generativelanguage.googleapis.com",
  max_consecutive_retries: 100,
  debug_mode: true,
  retry_delay_ms: 750,
  swallow_thoughts_after_retry: true,
};

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 429]);

const logDebug = (...args) => { if (CONFIG.debug_mode) console.log(`[DEBUG ${new Date().toISOString()}]`, ...args); };
const logInfo  = (...args) => console.log(`[INFO ${new Date().toISOString()}]`, ...args);
const logError = (...args) => console.error(`[ERROR ${new Date().toISOString()}]`, ...args);

const handleOPTIONS = () => {
  return {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Goog-Api-Key",
    }
  };
};

const jsonError = (status, message, details = null) => {
  return {
    status,
    headers: { 
      "Content-Type": "application/json; charset=utf-8", 
      "Access-Control-Allow-Origin": "*" 
    },
    body: JSON.stringify({ 
      error: { 
        code: status, 
        message, 
        status: statusToGoogleStatus(status), 
        details 
      } 
    })
  };
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
  const h = {};
  const copy = (k) => { 
    const v = reqHeaders[k]; 
    if (v) h[k] = v; 
  };
  
  copy("authorization");
  copy("x-goog-api-key");
  copy("content-type");
  copy("accept");
  return h;
}

async function standardizeInitialError(initialResponse) {
  let upstreamText = "";
  try {
    upstreamText = await initialResponse.text();
    logError(`Upstream error body (truncated): ${upstreamText.length > 2000 ? upstreamText.slice(0, 2000) + "..." : upstreamText}`);
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
        details: upstreamText ? [{ "@type": "proxy.upstream", upstream_error: upstreamText.slice(0, 8000) }] : undefined
      }
    };
  }

  const safeHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Goog-Api-Key"
  };
  
  const retryAfter = initialResponse.headers.get("Retry-After");
  if (retryAfter) safeHeaders["Retry-After"] = retryAfter;

  return {
    status: initialResponse.status,
    headers: safeHeaders,
    body: JSON.stringify(standardized)
  };
}

// helper: write one SSE error event based on upstream error response (used when retry hits non-retryable status)
async function writeSSEErrorFromUpstream(writer, upstreamResp) {
  const std = await standardizeInitialError(upstreamResp);
  let text = std.body;
  const ra = upstreamResp.headers.get("Retry-After");
  if (ra) {
    try {
      const obj = JSON.parse(text);
      obj.error.details = (obj.error.details || []).concat([{ "@type": "proxy.retry", retry_after: ra }]);
      text = JSON.stringify(obj);
    } catch (_) {}
  }
  await writer.write(`event: error\ndata: ${text}\n\n`);
}

async function* sseLineIterator(reader) {
  let buffer = "";
  let lineCount = 0;
  logDebug("Starting SSE line iteration");
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      logDebug(`SSE stream ended. Total lines processed: ${lineCount}. Remaining buffer: "${buffer.trim()}"`);
      if (buffer.trim()) yield buffer;
      break;
    }
    buffer += new TextDecoder("utf-8").decode(value);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        lineCount++;
        logDebug(`SSE Line ${lineCount}: ${line.length > 200 ? line.substring(0, 200) + "..." : line}`);
        yield line;
      }
    }
  }
}

const isDataLine = (line) => line.startsWith("data: ");
const isBlockedLine = (line) => line.includes("blockReason");

function extractFinishReason(line) {
  if (!line.includes("finishReason")) return null;
  try {
    const i = line.indexOf("{");
    if (i === -1) return null;
    const data = JSON.parse(line.slice(i));
    const fr = data?.candidates?.[0]?.finishReason || null;
    logDebug(`Extracted finishReason: ${fr}`);
    return fr;
  } catch (e) {
    logDebug(`Failed to extract finishReason from line: ${e.message}`);
    return null;
  }
}

/**
 * Parses a "data:" line from an SSE stream to extract text content and determine if it's a "thought" chunk.
 * @param {string} line The "data: " line from the SSE stream.
 * @returns {{text: string, isThought: boolean}} An object containing the extracted text and a boolean indicating if it's a thought.
 */
function parseLineContent(line) {
  try {
    const jsonStr = line.slice(line.indexOf('{'));
    const data = JSON.parse(jsonStr);
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    if (!part) return { text: "", isThought: false };

    const text = part.text || "";
    const isThought = part.thought === true;
    
    if (isThought) {
        logDebug("Extracted thought chunk. This will be tracked.");
    } else if (text) {
        logDebug(`Extracted text chunk (${text.length} chars): ${text.length > 100 ? text.substring(0, 100) + "..." : text}`);
    }

    return { text, isThought };
  } catch (e) {
    logDebug(`Failed to parse content from data line: ${e.message}`);
    return { text: "", isThought: false };
  }
}

function buildRetryRequestBody(originalBody, accumulatedText) {
  logDebug(`Building retry request body. Accumulated text length: ${accumulatedText.length}`);
  logDebug(`Accumulated text preview: ${accumulatedText.length > 200 ? accumulatedText.substring(0, 200) + "..." : accumulatedText}`);
  const retryBody = JSON.parse(JSON.stringify(originalBody));
  if (!retryBody.contents) retryBody.contents = [];
  const lastUserIndex = retryBody.contents.map(c => c.role).lastIndexOf("user");
  const history = [
    { role: "model", parts: [{ text: accumulatedText }] },
    { role: "user", parts: [{ text: "Continue exactly where you left off without any preamble or repetition." }] }
  ];
  if (lastUserIndex !== -1) {
    retryBody.contents.splice(lastUserIndex + 1, 0, ...history);
    logDebug(`Inserted retry context after user message at index ${lastUserIndex}`);
  } else {
    retryBody.contents.push(...history);
    logDebug(`Appended retry context to end of conversation`);
  }
  logDebug(`Final retry request has ${retryBody.contents.length} messages`);
  return retryBody;
}

async function processStreamAndRetryInternally({ req, res, originalRequestBody, upstreamUrl, originalHeaders }) {
  let accumulatedText = "";
  let consecutiveRetryCount = 0;
  let totalLinesProcessed = 0;
  let currentStream = null;
  const sessionStartTime = Date.now();
  
  let isOutputtingFormalText = false; // Tracks if we have started sending real content.
  let swallowModeActive = false; // Is the worker actively swallowing thoughts post-retry?

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const writer = {
    write: (text) => {
      res.write(text);
      return Promise.resolve();
    },
    close: () => {
      res.end();
      return Promise.resolve();
    }
  };

  logInfo(`Starting stream processing session. Max retries: ${CONFIG.max_consecutive_retries}`);

  // Make initial request
  const initialResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: originalHeaders,
    body: JSON.stringify(originalRequestBody)
  });

  if (!initialResponse.ok) {
    logError(`Initial request failed with status ${initialResponse.status}`);
    const errorResponse = await standardizeInitialError(initialResponse);
    res.status(errorResponse.status).set(errorResponse.headers).send(errorResponse.body);
    return;
  }

  let currentReader = initialResponse.body.getReader();

  const cleanup = (reader) => { 
    if (reader) { 
      logDebug("Cleaning up reader"); 
      reader.cancel().catch(() => {}); 
    } 
  };

  while (true) {
    let interruptionReason = null; // "DROP", "BLOCK", "FINISH_DURING_THOUGHT", "FINISH_ABNORMAL", "FINISH_INCOMPLETE", "FETCH_ERROR"
    let cleanExit = false; // Flag to signal a valid, successful end of the stream.
    const streamStartTime = Date.now();
    let linesInThisStream = 0;
    let textInThisStream = "";

    logDebug(`=== Starting stream attempt ${consecutiveRetryCount + 1}/${CONFIG.max_consecutive_retries + 1} ===`);

    try {
      for await (const line of sseLineIterator(currentReader)) {
        totalLinesProcessed++;
        linesInThisStream++;

        const { text: textChunk, isThought } = isDataLine(line) ? parseLineContent(line) : { text: "", isThought: false };
        
        // --- Thought Swallowing Logic ---
        if (swallowModeActive) {
            if (isThought) {
                logDebug("Swallowing thought chunk due to post-retry filter:", line);
                const finishReasonOnSwallowedLine = extractFinishReason(line);
                if (finishReasonOnSwallowedLine) {
                    logError(`Stream stopped with reason '${finishReasonOnSwallowedLine}' while swallowing a 'thought' chunk. Triggering retry.`);
                    interruptionReason = "FINISH_DURING_THOUGHT";
                    break; 
                }
                continue; // Skip the rest of the loop for this line.
            } else {
                logInfo("First formal text chunk received after swallowing. Resuming normal stream.");
                swallowModeActive = false;
            }
        }

        // --- Retry Decision Logic ---
        const finishReason = extractFinishReason(line);
        let needsRetry = false;
        
        if (finishReason && isThought) {
          logError(`Stream stopped with reason '${finishReason}' on a 'thought' chunk. This is an invalid state. Triggering retry.`);
          interruptionReason = "FINISH_DURING_THOUGHT";
          needsRetry = true;
        } else if (isBlockedLine(line)) {
          logError(`Content blocked detected in line: ${line}`);
          interruptionReason = "BLOCK";
          needsRetry = true;
        } else if (finishReason === "STOP") {
          const tempAccumulatedText = accumulatedText + textChunk;
          const trimmedText = tempAccumulatedText.trim();
          const lastChar = trimmedText.slice(-1);
          if (!(trimmedText.length === 0 || trimmedText.endsWith('[done]'))) {
            logError(`Finish reason 'STOP' treated as incomplete because text ends with '${lastChar}'. Triggering retry.`);
            interruptionReason = "FINISH_INCOMPLETE";
            needsRetry = true;
          }
        } else if (finishReason && finishReason !== "MAX_TOKENS" && finishReason !== "STOP") {
          logError(`Abnormal finish reason: ${finishReason}. Triggering retry.`);
          interruptionReason = "FINISH_ABNORMAL";
          needsRetry = true;
        }

        if (needsRetry) {
          break;
        }
        
        // --- Line is Good: Forward and Update State ---
        await writer.write(line + "\n\n");

        if (textChunk && !isThought) {
          isOutputtingFormalText = true; // Mark that we've started sending real text.
          accumulatedText += textChunk;
          textInThisStream += textChunk;
        }

        if (finishReason === "STOP" || finishReason === "MAX_TOKENS") {
          logInfo(`Finish reason '${finishReason}' accepted as final. Stream complete.`);
          cleanExit = true;
          break;
        }
      }

      if (!cleanExit && interruptionReason === null) {
        logError("Stream ended without finish reason - detected as DROP");
        interruptionReason = "DROP";
      }

    } catch (e) {
      logError(`Exception during stream processing:`, e.message, e.stack);
      interruptionReason = "FETCH_ERROR";
    } finally {
      cleanup(currentReader);
      const streamDuration = Date.now() - streamStartTime;
      logDebug(`Stream attempt summary:`);
      logDebug(`  Duration: ${streamDuration}ms`);
      logDebug(`  Lines processed: ${linesInThisStream}`);
      logDebug(`  Text generated this stream: ${textInThisStream.length} chars`);
      logDebug(`  Total accumulated text: ${accumulatedText.length} chars`);
    }

    if (cleanExit) {
      const sessionDuration = Date.now() - sessionStartTime;
      logInfo(`=== STREAM COMPLETED SUCCESSFULLY ===`);
      logInfo(`Total session duration: ${sessionDuration}ms`);
      logInfo(`Total lines processed: ${totalLinesProcessed}`);
      logInfo(`Total text generated: ${accumulatedText.length} characters`);
      logInfo(`Total retries needed: ${consecutiveRetryCount}`);
      return writer.close();
    }

    // --- Interruption & Retry Activation ---
    logError(`=== STREAM INTERRUPTED ===`);
    logError(`Reason: ${interruptionReason}`);
    
    if (CONFIG.swallow_thoughts_after_retry && isOutputtingFormalText) {
        logInfo("Retry triggered after formal text output. Will swallow subsequent thought chunks until formal text resumes.");
        swallowModeActive = true;
    }

    logError(`Current retry count: ${consecutiveRetryCount}`);
    logError(`Max retries allowed: ${CONFIG.max_consecutive_retries}`);
    logError(`Text accumulated so far: ${accumulatedText.length} characters`);

    if (consecutiveRetryCount >= CONFIG.max_consecutive_retries) {
      const payload = {
        error: {
          code: 504,
          status: "DEADLINE_EXCEEDED",
          message: `Retry limit (${CONFIG.max_consecutive_retries}) exceeded after stream interruption. Last reason: ${interruptionReason}.`,
          details: [{ "@type": "proxy.debug", accumulated_text_chars: accumulatedText.length }]
        }
      };
      await writer.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      return writer.close();
    }

    consecutiveRetryCount++;
    logInfo(`=== STARTING RETRY ${consecutiveRetryCount}/${CONFIG.max_consecutive_retries} ===`);

    try {
      const retryBody = buildRetryRequestBody(originalRequestBody, accumulatedText);
      const retryHeaders = originalHeaders;

      logDebug(`Making retry request to: ${upstreamUrl}`);
      logDebug(`Retry request body size: ${JSON.stringify(retryBody).length} bytes`);

      const retryResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody)
      });

      logInfo(`Retry request completed. Status: ${retryResponse.status} ${retryResponse.statusText}`);

      if (NON_RETRYABLE_STATUSES.has(retryResponse.status)) {
        logError(`=== FATAL ERROR DURING RETRY ===`);
        logError(`Received non-retryable status ${retryResponse.status} during retry attempt ${consecutiveRetryCount}`);
        await writeSSEErrorFromUpstream(writer, retryResponse);
        return writer.close();
      }

      if (!retryResponse.ok) {
        logError(`Retry attempt ${consecutiveRetryCount} failed with status ${retryResponse.status}`);
        logError(`This is considered a retryable error - will try again if retries remain`);
        throw new Error(`Upstream server error on retry: ${retryResponse.status}`);
      }

      logInfo(`✓ Retry attempt ${consecutiveRetryCount} successful - got new stream`);
      logInfo(`Continuing with accumulated context (${accumulatedText.length} chars)`);
      currentReader = retryResponse.body.getReader();

    } catch (e) {
      logError(`=== RETRY ATTEMPT ${consecutiveRetryCount} FAILED ===`);
      logError(`Exception during retry:`, e.message);
      logError(`Will wait ${CONFIG.retry_delay_ms}ms before next attempt (if any)`);
      await new Promise(res => setTimeout(res, CONFIG.retry_delay_ms));
    }
  }
}

async function handleStreamingPost(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const upstreamUrl = `${CONFIG.upstream_url_base}${urlObj.pathname}${urlObj.search}`;

  logInfo(`=== NEW STREAMING REQUEST ===`);
  logInfo(`Upstream URL: ${upstreamUrl}`);
  logInfo(`Request method: ${req.method}`);
  logInfo(`Content-Type: ${req.headers["content-type"]}`);

  // Parse the request body
  let body = req.body;
  
  // system prompt inject
  const newSystemPromptPart = {
    text: "Your message must end with [done] to signify the end of your output."
  };
  
  // Case 1: `systemInstruction` field is missing or null.
  // Create the `systemInstruction` object with the new prompt part.
  if (!body.systemInstruction) {
    body.systemInstruction = { parts: [newSystemPromptPart] };
  } 
  // Case 2: `systemInstruction` exists, but its `parts` array is missing, null, or not an array.
  // Overwrite `parts` with a new array containing the new prompt part.
  else if (!Array.isArray(body.systemInstruction.parts)) {
    body.systemInstruction.parts = [newSystemPromptPart];
  } 
  // Case 3: `systemInstruction` and its `parts` array both exist.
  // Append the new prompt part to the end of the existing array.
  else {
    body.systemInstruction.parts.push(newSystemPromptPart);
  }

  logDebug(`Parsed request body with ${body.contents?.length || 0} messages`);

  // Start the streaming process
  await processStreamAndRetryInternally({
    req,
    res,
    originalRequestBody: body,
    upstreamUrl,
    originalHeaders: buildUpstreamHeaders(req.headers)
  }).catch(e => {
    logError("=== UNHANDLED EXCEPTION IN STREAM PROCESSOR ===");
    logError("Exception:", e.message);
    logError("Stack:", e.stack);
    try { res.end(); } catch (_) {}
  });
}

async function handleNonStreaming(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const upstreamUrl = `${CONFIG.upstream_url_base}${url.pathname}${url.search}`;

  const upstreamHeaders = buildUpstreamHeaders(req.headers);
  
  let requestBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    requestBody = req.body;
  }

  const response = await fetch(upstreamUrl, {
    method: req.method,
    headers: upstreamHeaders,
    body: requestBody ? JSON.stringify(requestBody) : undefined
  });

  if (!response.ok) {
    const errorResponse = await standardizeInitialError(response);
    return res.status(errorResponse.status).set(errorResponse.headers).send(errorResponse.body);
  }

  const responseBody = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  headers["Access-Control-Allow-Origin"] = "*";

  return res.status(response.status).set(headers).send(responseBody);
}

export default async function handler(req, res) {
  try {
    logInfo(`=== VERCEL FUNCTION REQUEST ===`);
    logInfo(`Method: ${req.method}`);
    logInfo(`URL: ${req.url}`);
    logInfo(`User-Agent: ${req.headers["user-agent"] || "unknown"}`);
    logInfo(`Client IP: ${req.headers["x-forwarded-for"] || req.connection.remoteAddress || "unknown"}`);

    if (req.method === "OPTIONS") {
      logDebug("Handling CORS preflight request");
      const options = handleOPTIONS();
      return res.status(options.status).set(options.headers).end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const alt = url.searchParams.get("alt");
    const isStream = /stream|sse/i.test(url.pathname) || alt === "sse";
    logInfo(`Detected streaming request: ${isStream}`);

    if (req.method === "POST" && isStream) {
      return await handleStreamingPost(req, res);
    }

    return await handleNonStreaming(req, res);

  } catch (e) {
    logError("=== TOP-LEVEL EXCEPTION ===");
    logError("Message:", e.message);
    logError("Stack:", e.stack);
    const error = jsonError(500, "Internal Server Error", "The proxy function encountered a critical, unrecoverable error.");
    return res.status(error.status).set(error.headers).send(error.body);
  }
}
