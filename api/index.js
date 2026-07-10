/**
 * Bandwidth Hero Proxy — Vercel Serverless Function
 * Ported from Netlify version (functions/index.js)
 */

const pick           = require("../util/pick");
const fetch          = require("node-fetch");
const shouldCompress = require("../util/shouldCompress");
const compress       = require("../util/compress");

const DEFAULT_QUALITY = 40;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=604800, max-age=3600, stale-while-revalidate=86400",
};

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateHost(hostname) {
  return [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^::1$/,
  ].some((p) => p.test(hostname));
}

function fetchWithTimeout(url, options, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("FETCH_TIMEOUT")), ms)
  );
  return Promise.race([fetch(url, options), timeout]);
}

module.exports = async (req, res) => {
  // ---- CORS preflight ----
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  let { url: r } = req.query;
  const { jpeg: s, bw: o, quality: q, l, max_width: mw } = req.query;

  if (!r) {
    res.writeHead(200, CORS_HEADERS);
    return res.end("bandwidth-hero-proxy");
  }

  try { r = JSON.parse(r); } catch {}
  Array.isArray(r) && (r = r.join("&url="));
  r = r.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

  if (!isValidUrl(r)) {
    res.writeHead(400, CORS_HEADERS);
    return res.end("Invalid URL");
  }

  const parsedUrl = new URL(r);
  if (isPrivateHost(parsedUrl.hostname)) {
    res.writeHead(403, CORS_HEADERS);
    return res.end("Forbidden");
  }

  const useWebp   = s !== "1";
  const grayscale = o === "1";
  const quality   = parseInt(q || l, 10) || DEFAULT_QUALITY;
  const maxWidth  = parseInt(mw, 10) || 0;

  // Vercel doesn't give you e.ip directly — pull the client IP from headers
  // or the raw socket instead.
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "";

  try {
    let upstreamHeaders = {}, body, contentType;

    try {
      const response = await fetchWithTimeout(
        r,
        {
          headers: {
            ...pick(req.headers, ["cookie", "dnt", "referer"]),
            "user-agent":
              req.headers["user-agent"] ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept":
              req.headers["accept"] ||
              "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
            "accept-encoding": "identity",
            "x-forwarded-for": req.headers["x-forwarded-for"] || clientIp,
            via: "1.1 bandwidth-hero",
          },
          redirect: "follow",
        },
        8000
      );

      if (!response.ok) {
        res.writeHead(response.status || 302, CORS_HEADERS);
        return res.end();
      }

      upstreamHeaders = response.headers;
      body            = await response.buffer();
      contentType     = response.headers.get("content-type") || "";

    } catch (fetchErr) {
      if (fetchErr.message === "FETCH_TIMEOUT") {
        res.writeHead(504, CORS_HEADERS);
        return res.end("Upstream fetch timed out");
      }
      throw fetchErr;
    }

    if (contentType && !contentType.startsWith("image/")) {
      console.log("Non-image content-type:", contentType, "for URL:", r);
      res.writeHead(415, CORS_HEADERS);
      return res.end(`Upstream returned non-image response (${contentType})`);
    }

    const originalSize = body.length;

    if (!shouldCompress(contentType, originalSize, useWebp)) {
      console.log("Bypassing compression. Size:", originalSize);
      res.writeHead(200, {
        ...CORS_HEADERS,
        ...CACHE_HEADERS,
        "content-encoding": "identity",
        "content-type": contentType,
      });
      return res.end(body); // raw Buffer, no base64 needed
    }

    const { err, output, headers: compressedHeaders } = await compress(
      body, useWebp, grayscale, quality, originalSize, maxWidth
    );

    if (err) {
      console.log("Compression failed:", r);
      throw err;
    }

    console.log(
      `From ${originalSize}, saved: ${((originalSize - output.length) / originalSize * 100).toFixed(1)}%`
    );

    res.writeHead(200, {
      ...CORS_HEADERS,
      ...CACHE_HEADERS,
      "content-encoding": "identity",
      ...compressedHeaders,
    });
    return res.end(output);

  } catch (err) {
    console.error(err);
    res.writeHead(500, CORS_HEADERS);
    return res.end(err.message || "");
  }
};
