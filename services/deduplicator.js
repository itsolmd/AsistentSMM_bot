/**
 * services/deduplicator.js
 *
 * Image URL deduplication + Facebook post deduplication.
 *
 * Facebook Post Deduplication:
 *   - Generates content hash before posting
 *   - Checks MongoDB if content was already posted (10-minute anti-duplicate rule)
 *   - Saves post info (postId, contentHash, platform, timestamp, link) AFTER successful post
 *   - Cleanup function to find and remove Facebook duplicates (last 5 min)
 */

const crypto = require("crypto");
const { getCollection } = require("../db");

// ── Image URL Deduplication ─────────────────────────────────────

/**
 * normalizeImageUrl(url)
 * Strips query params, trailing slashes, protocol differences
 * to compare image URLs semantically.
 */
function normalizeForDedupe(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const protocol = u.protocol;
    const params = new URLSearchParams(u.search);
    params.sort();
    const queryStr = params.toString();
    return `${protocol}//${u.hostname}${u.pathname}${queryStr ? "?" + queryStr : ""}`;
  } catch {
    return url.replace(/\/+$/, "").trim().toLowerCase();
  }
}

/**
 * hashUrl(url)
 * Creates a deterministic hash of a normalized URL.
 */
function hashUrl(url) {
  const normalized = normalizeForDedupe(url);
  if (!normalized) return null;
  return crypto.createHash("md5").update(normalized).digest("hex");
}

/**
 * deduplicateImages(imageUrls)
 *
 * Removes duplicate image URLs while preserving order.
 */
function deduplicateImages(imageUrls) {
  if (!Array.isArray(imageUrls)) return [];

  const seen = new Set();
  const result = [];

  for (const url of imageUrls) {
    if (!url || typeof url !== "string") continue;

    const h = hashUrl(url);
    if (h && !seen.has(h)) {
      seen.add(h);
      result.push(url);
    }
  }

  const removed = imageUrls.length - result.length;
  if (removed > 0) {
    console.log(
      `[deduplicator] Removed ${removed} duplicate image URL(s) (${result.length} unique)`
    );
  }

  return result;
}

/**
 * areSameImage(bufferA, bufferB)
 * Quick check if two image buffers have the same length.
 */
async function areSameImage(bufferA, bufferB) {
  if (!bufferA || !bufferB) return false;
  if (bufferA.length === bufferB.length) return true;
  return false;
}

// ── Facebook Post Deduplication ─────────────────────────────────

/**
 * generateContentHash(data)
 *
 * Creates a deterministic SHA-256 hash of the content being posted.
 * Uses key fields: description text, property type, price, area, rooms, location.
 *
 * @param {Object} data - The session.data object containing listing info
 * @returns {string} - SHA-256 hex hash
 */
function generateContentHash(data) {
  if (!data) return null;

  // Build a canonical string from the most important fields
  const canonicalParts = [
    data.description || data.descriere || '',
    data.type || '',
    String(data.price || ''),
    String(data.area || ''),
    String(data.rooms || ''),
    data.sector?.ro || data.sector || '',
    data.suburb?.ro || data.suburb || '',
    data.parsedLocation?.sector || '',
    data.parsedLocation?.city || '',
  ];

  const canonicalStr = canonicalParts.join('||').toLowerCase().trim();
  if (!canonicalStr) return null;

  return crypto.createHash('sha256').update(canonicalStr).digest('hex');
}

/**
 * checkDuplicatePost(contentHash, platform)
 *
 * Checks MongoDB if this content hash was posted within the last 10 minutes.
 * Implements the "NICIODATĂ să nu postezi același conținut de două ori în mai puțin de 10 minute" rule.
 *
 * @param {string} contentHash - SHA-256 hash of content
 * @param {string} platform - Platform name (e.g. "facebook", "instagram")
 * @returns {Promise<Object|null>} - Existing post record or null if not duplicate
 */
async function checkDuplicatePost(contentHash, platform) {
  if (!contentHash) return null;

  try {
    const postsCollection = await getCollection("published_posts");

    // Check for any post with same contentHash in last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const existing = await postsCollection.findOne({
      contentHash: contentHash,
      platform: platform,
      timestamp: { $gte: tenMinutesAgo },
    });

    if (existing) {
      console.log(`[deduplicator] ⛔ DUPLICATE DETECTED: contentHash=${contentHash.slice(0, 12)}... platform=${platform} last posted at ${existing.timestamp}`);
      return existing;
    }

    console.log(`[deduplicator] ✅ No duplicate found for contentHash=${contentHash.slice(0, 12)}... platform=${platform}`);
    return null;
  } catch (err) {
    console.error(`[deduplicator] ❌ Error checking duplicate post: ${err.message}`);
    // Non-blocking: on error, allow the post to proceed
    return null;
  }
}

/**
 * savePostedRecord(postInfo)
 *
 * Saves a successful post record to MongoDB for future deduplication checks.
 *
 * @param {Object} postInfo - Info about the posted content
 * @param {string} postInfo.postId - Platform-specific post ID
 * @param {string} postInfo.contentHash - SHA-256 hash of content
 * @param {string} postInfo.platform - "facebook" or "instagram"
 * @param {string} postInfo.link - URL to the post
 * @param {Object} postInfo.metadata - Optional extra data
 */
async function savePostedRecord(postInfo) {
  if (!postInfo || !postInfo.contentHash || !postInfo.platform) {
    console.warn('[deduplicator] ⚠️ Cannot save posted record: missing contentHash or platform');
    return;
  }

  try {
    const postsCollection = await getCollection("published_posts");

    const record = {
      postId: postInfo.postId || null,
      contentHash: postInfo.contentHash,
      platform: postInfo.platform,
      link: postInfo.link || null,
      timestamp: new Date(),
      metadata: postInfo.metadata || {},
    };

    await postsCollection.insertOne(record);
    console.log(`[deduplicator] ✅ Saved posted record: ${postInfo.platform} | contentHash=${postInfo.contentHash.slice(0, 12)}... | postId=${postInfo.postId}`);
  } catch (err) {
    console.error(`[deduplicator] ❌ Error saving posted record: ${err.message}`);
    // Non-blocking: don't fail the post if we can't save the record
  }
}

/**
 * cleanupDuplicatePosts(platform)
 *
 * Scans for duplicate Facebook posts within the last 5 minutes.
 * If duplicates are found, deletes all but the first one.
 *
 * @param {string} platform - "facebook" or "instagram"
 * @returns {Promise<number>} - Number of duplicates removed
 */
async function cleanupDuplicatePosts(platform = "facebook") {
  try {
    const postsCollection = await getCollection("published_posts");

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Find all posts from last 5 minutes grouped by contentHash
    const duplicates = await postsCollection.aggregate([
      {
        $match: {
          platform: platform,
          timestamp: { $gte: fiveMinutesAgo },
        },
      },
      {
        $group: {
          _id: "$contentHash",
          records: { $push: { _id: "$_id", postId: "$postId", timestamp: "$timestamp", link: "$link" } },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 }, // Only groups with more than 1 post
        },
      },
    ]).toArray();

    let totalRemoved = 0;

    for (const group of duplicates) {
      // Sort by timestamp ascending — keep the first one
      const sorted = group.records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const keep = sorted[0];
      const toRemove = sorted.slice(1);

      console.log(`[deduplicator] 🧹 Found ${toRemove.length} duplicate(s) for contentHash=${group._id.slice(0, 12)}... Keeping: ${keep.postId}`);

      // Remove duplicate records from MongoDB
      const removeIds = toRemove.map(r => r._id);
      await postsCollection.deleteMany({ _id: { $in: removeIds } });

      totalRemoved += toRemove.length;
    }

    if (totalRemoved > 0) {
      console.log(`[deduplicator] 🧹 Cleanup complete: removed ${totalRemoved} duplicate post record(s)`);
    } else {
      console.log(`[deduplicator] 🧹 No duplicates found in last 5 minutes`);
    }

    return totalRemoved;
  } catch (err) {
    console.error(`[deduplicator] ❌ Error during duplicate cleanup: ${err.message}`);
    return 0;
  }
}

module.exports = {
  // Image dedup
  deduplicateImages,
  normalizeForDedupe,
  hashUrl,
  areSameImage,
  // Facebook post dedup
  generateContentHash,
  checkDuplicatePost,
  savePostedRecord,
  cleanupDuplicatePosts,
};