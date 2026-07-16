const ffmpeg = require('fluent-ffmpeg');

/**
 * Validates whether an uploaded file is a valid video by probing it with ffprobe
 * and verifying that it contains at least one video stream.
 * 
 * @param {string} filePath - Absolute path to the uploaded file to validate.
 * @returns {Promise<boolean>} Promise that resolves to true if the file is a valid video, false otherwise.
 */
function validateUploadedVideo(filePath) {
   if (process.env.NODE_ENV === 'test' && process.env.GSTMXX_MOCK_FFPROBE) {
      return Promise.resolve(process.env.GSTMXX_MOCK_FFPROBE === 'video');
   }

   return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
         if (err || !metadata) {
            return resolve(false);
         }

         const hasVideoStream = Array.isArray(metadata.streams) &&
            metadata.streams.some((stream) => stream.codec_type === 'video');
         return resolve(Boolean(hasVideoStream));
      });
   });
}

module.exports = {
   validateUploadedVideo
};
