// netlify/functions/api.js
// Serverless dispatcher for the image automation pipeline.
// Actions: proxy-image, extract-sku, submit-birefnet, poll-status.
//
// Polling note: the Fal queue status/result endpoints require the FAL_KEY
// header, so the browser cannot poll them directly without leaking the key.
// We expose a thin server-side poll-status proxy that holds the key.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FAL_API_KEY = process.env.FAL_API_KEY;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB ceiling for proxy fetches
const FETCH_TIMEOUT_MS = 15000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

// fetch with an abort-based timeout so a hung upstream can't wedge the function.
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Block SSRF: reject private / loopback / link-local / metadata hosts.
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4 ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;       // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function validateRemoteUrl(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return { error: "Invalid url" };
  }
  if (!/^https?:$/.test(target.protocol)) return { error: "Only http(s) urls allowed" };
  if (isBlockedHost(target.hostname)) return { error: "Host not allowed" };
  return { target };
}

// ---------- proxy-image ----------
async function proxyImage(payload) {
  const { url } = payload;
  if (!url) return json(400, { error: "Missing url" });

  const { target, error } = validateRemoteUrl(url);
  if (error) return json(400, { error });

  const resp = await fetchWithTimeout(target.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (AssetProcessor)" },
  });
  if (!resp.ok) return json(resp.status, { error: `Fetch failed: ${resp.status}` });

  const contentType = resp.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) {
    return json(415, { error: `Not an image: ${contentType}` });
  }
  const lenHeader = Number(resp.headers.get("content-length") || 0);
  if (lenHeader && lenHeader > MAX_IMAGE_BYTES) {
    return json(413, { error: "Image too large" });
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) return json(413, { error: "Image too large" });

  const dataUri = `data:${contentType};base64,${buf.toString("base64")}`;
  return json(200, { dataUri, contentType });
}

// ---------- extract-sku ----------
async function extractSku(payload) {
  if (!OPENAI_API_KEY) return json(500, { error: "OPENAI_API_KEY not configured" });
  const { dataUri } = payload;
  if (!dataUri) return json(400, { error: "Missing dataUri" });

  const resp = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 30,
      messages: [
        {
          role: "system",
          content:
            "You read product SKU/style codes from packaging or labels. " +
            "Respond with ONLY the SKU string, no prose, no punctuation. " +
            "If none is visible, respond with the single word UNKNOWN.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is the SKU/product code in this image?" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    }),
  }, 25000);

  if (!resp.ok) {
    const errText = await resp.text();
    return json(resp.status, { error: `OpenAI error: ${errText}` });
  }
  const data = await resp.json();
  let sku = (data.choices?.[0]?.message?.content || "").trim();
  sku = sku.replace(/^["'`]+|["'`]+$/g, "").trim();
  return json(200, { sku: sku || "UNKNOWN" });
}

// ---------- submit-birefnet ----------
// Correct v2 input schema: operating_resolution enum, model, output_format.
async function submitBirefnet(payload) {
  if (!FAL_API_KEY) return json(500, { error: "FAL_API_KEY not configured" });
  const { imageUrl } = payload;
  if (!imageUrl) return json(400, { error: "Missing imageUrl" });

  const resp = await fetchWithTimeout("https://queue.fal.run/fal-ai/birefnet/v2", {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: imageUrl,
      model: "General Use (Heavy)",      // accurate edges for packshots
      operating_resolution: "2048x2048", // valid v2 enum value
      refine_foreground: true,
      output_format: "png",              // preserve alpha for the canvas
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return json(resp.status, { error: `Fal submit error: ${errText}` });
  }
  const data = await resp.json();
  return json(200, {
    request_id: data.request_id,
    status_url: data.status_url,
    response_url: data.response_url,
  });
}

// ---------- poll-status ----------
// Browser calls this with the request_id; we attach FAL_KEY server-side.
// Returns { status, ... } and, when COMPLETED, the resolved cutout url.
async function pollStatus(payload) {
  if (!FAL_API_KEY) return json(500, { error: "FAL_API_KEY not configured" });
  const { request_id } = payload;
  if (!request_id) return json(400, { error: "Missing request_id" });

  const base = `https://queue.fal.run/fal-ai/birefnet/v2/requests/${encodeURIComponent(request_id)}`;
  const authHeader = { Authorization: `Key ${FAL_API_KEY}` };

  const stResp = await fetchWithTimeout(`${base}/status`, { headers: authHeader });
  if (!stResp.ok) {
    const errText = await stResp.text();
    return json(stResp.status, { error: `Fal status error: ${errText}` });
  }
  const status = await stResp.json();

  // A failed run surfaces an `error` field on the COMPLETED status payload.
  if (status.status === "COMPLETED") {
    if (status.error) {
      return json(200, { status: "FAILED", error: status.error });
    }
    const resResp = await fetchWithTimeout(base, { headers: authHeader });
    if (!resResp.ok) {
      const errText = await resResp.text();
      return json(resResp.status, { error: `Fal result error: ${errText}` });
    }
    const result = await resResp.json();
    const cutoutUrl = result.images?.[0]?.url || result.image?.url || null;
    if (!cutoutUrl) return json(200, { status: "FAILED", error: "No cutout in result" });
    return json(200, { status: "COMPLETED", cutoutUrl });
  }

  // IN_QUEUE / IN_PROGRESS
  return json(200, { status: status.status, queue_position: status.queue_position });
}

// ---------- health ----------
// Shallow mode: reports whether each key is present (booleans only).
// Deep mode ({ deep: true }): makes a lightweight authenticated request to
// each service to confirm the key actually works, not just that it exists.
// Never returns key values.
async function health(payload) {
  const result = {
    ok: true,
    fal_configured: Boolean(FAL_API_KEY),
    openai_configured: Boolean(OPENAI_API_KEY),
  };

  if (!payload.deep) return json(200, result);

  // Validate Fal: hit a cheap authenticated endpoint. A 401/403 means bad key.
  if (FAL_API_KEY) {
    try {
      const r = await fetchWithTimeout("https://rest.alpha.fal.ai/tokens/", {
        headers: { Authorization: `Key ${FAL_API_KEY}` },
      }, 8000);
      // Some Fal accounts return 405 for GET on this path — that still proves
      // the key authenticated (auth happens before method check). Only treat
      // explicit auth rejections as invalid.
      result.fal_valid = !(r.status === 401 || r.status === 403);
    } catch {
      result.fal_valid = null; // network/unknown, not a definitive failure
    }
  } else {
    result.fal_valid = false;
  }

  // Validate OpenAI: list models is a cheap GET that requires a valid key.
  if (OPENAI_API_KEY) {
    try {
      const r = await fetchWithTimeout("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      }, 8000);
      result.openai_valid = r.ok;
    } catch {
      result.openai_valid = null;
    }
  } else {
    result.openai_valid = false;
  }

  return json(200, result);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  try {
    switch (payload.action) {
      case "health":         return await health(payload);
      case "proxy-image":     return await proxyImage(payload);
      case "extract-sku":     return await extractSku(payload);
      case "submit-birefnet": return await submitBirefnet(payload);
      case "poll-status":     return await pollStatus(payload);
      default: return json(400, { error: `Unknown action: ${payload.action}` });
    }
  } catch (err) {
    if (err.name === "AbortError") return json(504, { error: "Upstream timeout" });
    return json(500, { error: err.message || "Internal error" });
  }
};
