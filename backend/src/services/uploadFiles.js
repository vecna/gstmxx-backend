const fs = require('fs');
const path = require('path');
const {
   STORAGE_INCOMING_DIR,
   STORAGE_APPROVED_DIR,
   STORAGE_THUMBNAILS_DIR
} = require('../paths');

/**
 * Synchronously removes a file from the filesystem if it exists.
 * 
 * @param {string} filePath - Absolute path to the file.
 * @returns {boolean} True if the file existed and was successfully unlinked, false otherwise.
 */
function removeIfExists(filePath) {
   if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
   }
   return false;
}

/**
 * Derives the expected thumbnail filename based on the video's original filename.
 * Removes the 'pub-' prefix if present and appends '.png' to the base name.
 * 
 * @param {string} videoFilename - Name of the video file.
 * @returns {string|null} The derived thumbnail filename, or null if input is falsy.
 */
function deriveThumbnailName(videoFilename) {
   if (!videoFilename) return null;
   const parsed = path.parse(videoFilename);
   const originalBase = parsed.name.startsWith('pub-') ? parsed.name.slice(4) : parsed.name;
   return `thumb-${originalBase}.png`;
}

/**
 * Resolves the expected filesystem paths associated with a given upload database record.
 * Accounts for incoming (pending/rejected) and approved states.
 * 
 * @param {Object} record - The database record object for the upload.
 * @param {string} record.filename - The filename of the video.
 * @param {string} record.status - The current moderation/processing status.
 * @param {string} [record.thumbnail_filename] - The custom or derived thumbnail filename.
 * @returns {string[]} An array of absolute filesystem paths representing the files.
 */
function uploadFilePaths(record) {
   const paths = [];
   if (!record || !record.filename) return paths;

   if (record.status === 'approved') {
      paths.push(path.join(STORAGE_APPROVED_DIR, record.filename));
      if (record.kind !== 'clipboard') {
         paths.push(path.join(STORAGE_THUMBNAILS_DIR, record.thumbnail_filename || deriveThumbnailName(record.filename)));
      } else if (record.thumbnail_filename) {
         paths.push(path.join(STORAGE_THUMBNAILS_DIR, record.thumbnail_filename));
      }
      return paths;
   }

   paths.push(path.join(STORAGE_INCOMING_DIR, record.filename));
   return paths;
}

/**
 * Removes the files (video and optionally thumbnail) corresponding to an upload record.
 * 
 * @param {Object} record - The database record object for the upload.
 * @returns {boolean[]} An array of boolean values representing success for each target file.
 */
function removeUploadFiles(record) {
   return uploadFilePaths(record).filter(removeIfExists);
}

module.exports = {
   deriveThumbnailName,
   removeIfExists,
   removeUploadFiles,
   uploadFilePaths
};
