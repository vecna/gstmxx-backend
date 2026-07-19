const path = require('path');

const BASE_URL = process.env.GSTMXX_BASE_URL || 'https://ghostmaxxing.vecna.eu';

function approvedFilenameForUpload(upload) {
   if (upload && upload.filename && upload.status === 'approved') return upload.filename;
   if (upload && upload.filename && /^[-0-9a-f]{36}\.(mp4|png)$/i.test(upload.filename)) return upload.filename;
   const extension = upload && upload.kind === 'clipboard' ? '.png' : '.mp4';
   return `${upload.id}${extension}`;
}

function publicPathForUpload(upload) {
   const section = upload && upload.kind === 'clipboard' ? 'clipboard' : 'videos';
   return `/${section}/${approvedFilenameForUpload(upload)}`;
}

function publicUrlForUpload(upload) {
   return new URL(publicPathForUpload(upload), BASE_URL).href;
}

function outputNamesForApproval(inputFilename, uploadId, kind) {
   if (uploadId) {
      return {
         mediaName: `${uploadId}${kind === 'clipboard' ? '.png' : '.mp4'}`,
         thumbnailName: kind === 'clipboard' ? null : `thumb-${uploadId}.png`
      };
   }

   const base = path.parse(inputFilename).name;
   return {
      mediaName: `pub-${base}${kind === 'clipboard' ? '.png' : '.mp4'}`,
      thumbnailName: kind === 'clipboard' ? null : `thumb-${base}.png`
   };
}

module.exports = {
   approvedFilenameForUpload,
   outputNamesForApproval,
   publicPathForUpload,
   publicUrlForUpload
};
