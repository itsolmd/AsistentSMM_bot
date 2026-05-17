const FormData = require("form-data");
const axios = require("axios");

/**
 * Decode a JWT payload (base64) without verifying signature.
 * Returns null on invalid input.
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Check if a JWT token has expired, based on its `exp` claim.
 * Returns { expired: true, expiredAt: <Date|null> } or { expired: false }.
 * If the token has no `exp` claim or is malformed, assumes it is still valid.
 */
function checkTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) {
    return { expired: false }; // can't determine → assume valid
  }
  const expiredAt = new Date(payload.exp * 1000);
  const now = new Date();
  if (now >= expiredAt) {
    return { expired: true, expiredAt };
  }
  return { expired: false, expiredAt };
}

/**
 * removeWatermark - Removes watermark from an image buffer using dewatermark.ai API
 *
 * @param {Buffer} imageBuffer - The original image buffer
 * @returns {Promise<{success: boolean, buffer: Buffer|null, error: string|null}>}
 *   - success: true if watermark was removed, false on failure
 *   - buffer: the dewatermarked image buffer (or null on failure)
 *   - error: error message if failed, null otherwise
 */
const removeWatermark = async (imageBuffer) => {
  try {
    // ── Token from .env first, hardcoded fallback ──
    const apiKey =
      process.env.DEWATERMARK_API_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJpZ25vcmUiLCJwbGF0Zm9ybSI6IndlYiIsImlzX3BybyI6ZmFsc2UsImV4cCI6MTczMDk5NzI0M30.UPYSK0Vt-Jx2FHz_ACqRPQc7FFmi3gKGBt4gotC5kvA";

    // ── Pre-emptive token expiry check ──
    const expiryCheck = checkTokenExpiry(apiKey);
    if (expiryCheck.expired) {
      const msg =
        `DEWATERMARK_API_KEY token expired on ${expiryCheck.expiredAt.toISOString()}. ` +
        `Please generate a new API key at https://dewatermark.ai and update the DEWATERMARK_API_KEY variable in .env`;
      console.error(`[dewatermark] ❌ ${msg}`);
      return { success: false, buffer: null, error: msg };
    }

    const formData = new FormData();
    formData.append("original_preview_image", imageBuffer, "image.jpg");
    formData.append("zoom_factor", "2");

    const dewatermarkResponse = await axios.post(
      "https://api.dewatermark.ai/api/object_removal/v5/erase_watermark",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: 60000, // 60s timeout for API call
      }
    );

    if (!dewatermarkResponse?.data?.edited_image?.image) {
      console.error(
        "[dewatermark] ❌ API response missing edited_image.image field"
      );
      return {
        success: false,
        buffer: null,
        error: "API response missing image data",
      };
    }

    const editedImageData = dewatermarkResponse.data.edited_image.image;
    const editedImageBuffer = Buffer.from(editedImageData, "base64");

    console.log("[dewatermark] ✅ Watermark removed successfully");
    return { success: true, buffer: editedImageBuffer, error: null };
  } catch (error) {
    // Detailed error logging for debugging
    const statusCode = error.response?.status || "N/A";
    const errorMsg =
      error.response?.data?.message || error.message || "Unknown error";
    console.error(
      `[dewatermark] ❌ Failed to remove watermark (HTTP ${statusCode}): ${errorMsg}`
    );

    // Log response body for API debugging
    if (error.response?.data) {
      console.error(
        "[dewatermark] API response body:",
        JSON.stringify(error.response.data).slice(0, 500)
      );
    }

    // Specific suggestion for token-related errors
    if (
      statusCode === 401 &&
      (errorMsg.toLowerCase().includes("token") ||
        errorMsg.toLowerCase().includes("expired"))
    ) {
      console.error(
        "[dewatermark] 💡 TIP: The DEWATERMARK_API_KEY in .env has expired. " +
          "Get a new key at https://dewatermark.ai and update the .env file."
      );
    }

    return { success: false, buffer: null, error: errorMsg };
  }
};

module.exports = { removeWatermark };
