const FormData = require("form-data");
const axios = require("axios");

const removeWatermark = async (imageBuffer) => {
  const formData = new FormData();
  formData.append("original_preview_image", imageBuffer, "image.jpg");
  formData.append("zoom_factor", "2");

  const dewatermarkResponse = await axios.post(
    "https://api.dewatermark.ai/api/object_removal/v5/erase_watermark",
    formData,
    { 
      headers: {
        ...formData.getHeaders(),
        Authorization:
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJpZ25vcmUiLCJwbGF0Zm9ybSI6IndlYiIsImlzX3BybyI6ZmFsc2UsImV4cCI6MTczMDk5NzI0M30.UPYSK0Vt-Jx2FHz_ACqRPQc7FFmi3gKGBt4gotC5kvA",
        Accept: "application/json",
      },
    }
  );

  const editedImageData = dewatermarkResponse.data.edited_image.image;
  const editedImageBuffer = Buffer.from(editedImageData, "base64");

  return editedImageBuffer;
};

module.exports = { removeWatermark };
