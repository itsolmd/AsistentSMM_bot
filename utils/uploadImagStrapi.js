const axios = require("axios");
const FormData = require("form-data");
const https = require("https");
const http = require("http");
require("dotenv").config();

/* ── HTTP Keep-Alive Agents (reuse connections) ── */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000,
});

async function uploadImageToStrapi(imageBuffer, ctx) {
  try {
    // ── 1. Token resolution ──────────────────────────────────────
    // Priority: 1) process.env.STRAPI_TOKEN (server-level, has upload perms)
    //           2) ctx.session.user.strapi_token (user-level, may be read-only)
    const envToken    = process.env.STRAPI_TOKEN;
    const sessionToken = ctx?.session?.user?.strapi_token;

    const token = envToken || sessionToken;

    console.log("🔑 [uploadImageToStrapi] Using token from:", envToken ? ".env (server-level)" : "session (user-level)");
    console.log("🔑 [uploadImageToStrapi] STRAPI TOKEN EXISTS:", !!token);

    if (!token) {
      throw new Error("Missing STRAPI token — cannot upload to Strapi");
    }

    // ── 2. Backend URL resolution ────────────────────────────────
    // Priority: 1) process.env.BACK_END (server-level)
    //           2) ctx.session.user.strapi_backend (user-level)
    const envBackend    = process.env.BACK_END;
    const sessionBackend = ctx?.session?.user?.strapi_backend;

    const backend = envBackend || sessionBackend;
    if (!backend || backend === "i" || backend.length < 5) {
      throw new Error(`Malformed Strapi backend URL: "${backend}"`);
    }

    const formData = new FormData();
    formData.append("files", imageBuffer, { filename: "image.jpg" });

    const endpoint = `http://${backend}/api/upload`;
    console.log("📤 [uploadImageToStrapi] Uploading to:", endpoint);

    const uploadResponse = await axios.post(endpoint, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${token}`,
        Connection: "keep-alive",
      },
      httpAgent,
      httpsAgent,
      timeout: 30000,
    });

    // Return the ID of the uploaded image
    const imageId = uploadResponse.data[0].id;
    console.log("✅ [uploadImageToStrapi] Image uploaded, ID:", imageId);
    return imageId;
  } catch (error) {
    console.error("❌ [uploadImageToStrapi] Upload failed:", error.message);
    if (error.response) {
      console.error("❌ [uploadImageToStrapi] Status:", error.response.status);
      console.error("❌ [uploadImageToStrapi] Response data:", JSON.stringify(error.response.data).slice(0, 500));
    }
    return null; // Return null instead of crashing
  }
}

module.exports = { uploadImageToStrapi };
