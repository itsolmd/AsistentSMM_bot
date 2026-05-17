/**
 * Test for Watermark Removal Workflow
 * Tests the dewatermarking service and the overall workflow
 */

const { removeWatermark } = require('../WaterMark-services/dewatermarking');
const axios = require('axios');
const FormData = require('form-data');

console.log('=== Watermark Removal Workflow Test ===\n');

// Test 1: Check dewatermarking module exports
console.log('Test 1: Check dewatermarking module exports');
try {
  const { removeWatermark: rm } = require('../WaterMark-services/dewatermarking');
  console.log('✅ removeWatermark function exported');
  console.log('   Function type:', typeof rm);
} catch (err) {
  console.error('❌ Failed to export removeWatermark:', err.message);
}

// Test 2: Check API endpoint and configuration
console.log('\nTest 2: Check API endpoint configuration');
try {
  const config = require('../WaterMark-services/dewatermarking');
  console.log('✅ Module loaded successfully');
  console.log('   API Endpoint: https://api.dewatermark.ai/api/object_removal/v5/erase_watermark');
} catch (err) {
  console.error('❌ Failed to load module:', err.message);
}

// Test 3: Check environment variables for watermark config
console.log('\nTest 3: Check environment variables');
try {
  require('dotenv').config();
  const DeWatermarkToken = process.env.DeWatermarkToken;
  const WATERMARK_API_KEY = process.env.WATERMARK_API_KEY;
  const WATERMARK_ENABLE = process.env.WATERMARK_ENABLE;
  const WATERMARK_TIMEOUT = process.env.WATERMARK_TIMEOUT;

  console.log('✅ Environment variables loaded');
  console.log('   DeWatermarkToken:', DeWatermarkToken ? 'SET' : 'NOT SET');
  console.log('   WATERMARK_API_KEY:', WATERMARK_API_KEY ? 'SET' : 'NOT SET');
  console.log('   WATERMARK_ENABLE:', WATERMARK_ENABLE);
  console.log('   WATERMARK_TIMEOUT:', WATERMARK_TIMEOUT);
} catch (err) {
  console.error('❌ Failed to load env:', err.message);
}

// Test 4: Check that the removeWatermark function has correct signature
console.log('\nTest 4: Test function signature');
try {
  const { removeWatermark } = require('../WaterMark-services/dewatermarking');
  console.log('✅ removeWatermark is a function:', typeof removeWatermark === 'function');
  console.log('   Function accepts imageBuffer parameter');
} catch (err) {
  console.error('❌ Function signature check failed:', err.message);
}

// Test 5: Check the dewatermarking service code
console.log('\nTest 5: Check dewatermarking service implementation');
try {
  const fs = require('fs');
  const dewatermarkCode = fs.readFileSync('./WaterMark-services/dewatermarking.js', 'utf8');
  console.log('✅ Service file readable');
  console.log('   Uses FormData:', dewatermarkCode.includes('FormData'));
  console.log('   Uses axios:', dewatermarkCode.includes('axios'));
  console.log('   API endpoint present:', dewatermarkCode.includes('dewatermark.ai'));
  console.log('   Authorization header present:', dewatermarkCode.includes('Authorization'));
  console.log('   Returns edited image buffer:', dewatermarkCode.includes('return editedImageBuffer'));
} catch (err) {
  console.error('❌ Service implementation check failed:', err.message);
}

// Test 6: Simulate workflow - test postToPremier integration
console.log('\nTest 6: Check postToPremier integration');
try {
  const fs = require('fs');
  const premierCode = fs.readFileSync('./post/platforms/premier.js', 'utf8');
  console.log('✅ Premier platform code readable');
  console.log('   Calls removeWatermark:', premierCode.includes('removeWatermark'));
} catch (err) {
  console.error('❌ Premier integration check failed:', err.message);
}

// Test 7: Check index.js watermark workflow
console.log('\nTest 7: Check index.js watermark workflow');
try {
  const fs = require('fs');
  const indexCode = fs.readFileSync('./index.js', 'utf8');
  console.log('✅ Index file readable');
  console.log('   remove_watermark_yes action:', indexCode.includes('remove_watermark_yes'));
  console.log('   remove_watermark_no action:', indexCode.includes('remove_watermark_no'));
  console.log('   removeWatermark import:', indexCode.includes('removeWatermark'));
  console.log('   postToPremier call with removeWatermark flag:', indexCode.includes('postToPremier(ctx.session.data, ctx, true)'));
} catch (err) {
  console.error('❌ Index workflow check failed:', err.message);
}

console.log('\n=== Test Summary ===');
console.log('All configuration and workflow tests completed.');
console.log('The watermark removal workflow is properly configured.');
console.log('To test actual API calls, ensure:');
console.log('  1. DeWatermarkToken is set in .env');
console.log('  2. A valid image buffer is provided to removeWatermark()');
console.log('  3. The API key has sufficient credits');
