// TC EXPRESS · Cloudflare Worker
// Static site is served by the ASSETS binding.
// /api/track reads only the logistics fields needed from a private Google Sheet.
// Recipient and cargo columns are deliberately NOT fetched.

const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60_000;

const hits = new Map();
let tokenCache = { token: "", expiresAt: 0 };
let rowsCache = { key: "", at: 0, rows: [] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/track") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET") {
      return json({ found: false, reason: "method_not_allowed" }, 405);
    }

    const ip =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      "unknown";

    if (rateLimited(ip)) {
      return json({ found: false, reason: "rate_limited" }, 429);
    }

    const noRaw = String(url.searchParams.get("no") || "")
      .replace(/\s+/g, "")
      .trim();

    if (!/^[A-Za-z0-9-]{4,60}$/.test(noRaw)) {
      return json({ found: false, reason: "bad_input" }, 400);
    }

    if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_CREDENTIALS) {
      return json({ found: false, reason: "server_not_configured" }, 503);
    }

    try {
      const rows = await loadRows(env);
      const query = noRaw.toUpperCase();

      const hit = rows.find(
        (r) =>
          (r.no && r.no.toUpperCase() === query) ||
          (r.domesticNo && r.domesticNo.toUpperCase() === query)
      );

      if (!hit) {
        return json({ found: false, reason: "not_found" });
      }

      return json({
        found: true,
        tracking_no: hit.no || "",
        tcd_no: hit.no || "",
        domestic: {
          courier: hit.domesticCourier || "",
          no: hit.domesticNo || "",
        },
        status: hit.status || "",
        latest: hit.latest || "",
        updated_at: hit.updated_at || "",
        timeline: hit.timeline || [],
      });
    } catch (error) {
      console.error("[track] error", error);
      return json({ found: false, reason: "server_error" }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { start: now, count: 0 };

  if (now - rec.start > RATE_WINDOW_MS) {
    rec.start = now;
    rec.count = 0;
  }

  rec.count += 1;
  hits.set(ip, rec);

  // Opportunistic cleanup for per-isolate memory.
  if (hits.size > 1000) {
    for (const [key, value] of hits) {
      if (now - value.start > RATE_WINDOW_MS * 2) hits.delete(key);
    }
  }

  return rec.count > RATE_LIMIT;
}

async function loadRows(env) {
  const cacheKey = env.GOOGLE_SHEET_ID;
  const now = Date.now();

  if (
    rowsCache.key === cacheKey &&
    rowsCache.rows.length &&
    now - rowsCache.at < 60_000
  ) {
    return rowsCache.rows;
  }

  const credentials = parseCredentials(env.GOOGLE_CREDENTIALS);
  const accessToken = await getGoogleAccessToken(credentials);

  const sheetTitle = await getFirstSheetTitle(
    env.GOOGLE_SHEET_ID,
    accessToken
  );

  // Fetch only A:F and I:I.
  // Based on the site's documented sheet layout:
  // A 运单号
  // B 国内快递公司
  // C 国内快递单号
  // D 状态
  // E 最新节点
  // F 更新时间
  // G 收件人       <-- deliberately NOT fetched
  // H 货物         <-- deliberately NOT fetched
  // I 轨迹
  const quoted = quoteSheetTitle(sheetTitle);
  const params = new URLSearchParams();
  params.append("ranges", `${quoted}!A:F`);
  params.append("ranges", `${quoted}!I:I`);
  params.set("majorDimension", "ROWS");

  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values:batchGet?${params}`;

  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Google Sheets batchGet failed: ${response.status} ${await response.text()}`
    );
  }

  const payload = await response.json();
  const aToF = payload.valueRanges?.[0]?.values || [];
  const iCol = payload.valueRanges?.[1]?.values || [];
  const maxRows = Math.max(aToF.length, iCol.length);

  const rows = [];

  // Row 1 is the header row.
  for (let i = 1; i < maxRows; i++) {
    const left = aToF[i] || [];
    const timelineCell = iCol[i]?.[0] || "";

    const normalized = normalize({
      no: left[0] || "",
      domesticCourier: left[1] || "",
      domesticNo: left[2] || "",
      status: left[3] || "",
      latest: left[4] || "",
      updated_at: left[5] || "",
      timeline: timelineCell,
    });

    if (normalized) rows.push(normalized);
  }

  rowsCache = { key: cacheKey, at: now, rows };
  return rows;
}

function normalize(row) {
  const clean = (value) => String(value ?? "").trim();

  const no = clean(row.no);
  const domesticNo = clean(row.domesticNo);

  if (!no && !domesticNo) return null;

  return {
    no,
    domesticCourier: clean(row.domesticCourier),
    domesticNo,
    status: clean(row.status),
    latest: clean(row.latest),
    updated_at: clean(row.updated_at),
    timeline: parseTimeline(clean(row.timeline)),
  };
}

function parseTimeline(raw) {
  if (!raw) return [];

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*\|\|?\s*/);
      if (parts.length >= 2) {
        return {
          time: parts[0],
          node: parts.slice(1).join(" | "),
        };
      }
      return { time: "", node: line };
    });
}

function parseCredentials(raw) {
  try {
    const creds = JSON.parse(raw);
    if (!creds.client_email || !creds.private_key) {
      throw new Error("client_email/private_key missing");
    }
    return creds;
  } catch (error) {
    throw new Error(`Invalid GOOGLE_CREDENTIALS JSON: ${error.message}`);
  }
}

async function getFirstSheetTitle(sheetId, accessToken) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `?fields=sheets.properties.title`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Google Sheets metadata failed: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json();
  const title = data.sheets?.[0]?.properties?.title;

  if (!title) throw new Error("No worksheet found in Google Sheet");
  return title;
}

function quoteSheetTitle(title) {
  return `'${String(title).replaceAll("'", "''")}'`;
}

async function getGoogleAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);

  if (tokenCache.token && tokenCache.expiresAt - 60 > now) {
    return tokenCache.token;
  }

  const tokenUri =
    credentials.token_uri || "https://oauth2.googleapis.com/token";

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const unsigned =
    `${base64UrlJson(header)}.${base64UrlJson(claims)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(credentials.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );

  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Google OAuth failed: ${response.status} ${await response.text()}`
    );
  }

  const tokenData = await response.json();

  if (!tokenData.access_token) {
    throw new Error("Google OAuth response missing access_token");
  }

  tokenCache = {
    token: tokenData.access_token,
    expiresAt: now + Number(tokenData.expires_in || 3600),
  };

  return tokenCache.token;
}

function base64UrlJson(value) {
  return base64UrlBytes(
    new TextEncoder().encode(JSON.stringify(value))
  );
}

function base64UrlBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}
