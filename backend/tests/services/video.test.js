/**
 * UNIT TEST — src/services/video.js (ffmpeg approval pipeline).
 *
 * WHAT WE TEST
 *   - Rejects when the source file is missing.
 *   - In the mock boundary (NODE_ENV=test + GSTMXX_MOCK_VIDEO_PROCESSING=1) it
 *     copies the file and returns { videoName: 'pub-<name>.mp4', thumbnailName: null }.
 *
 * WHAT WE DO NOT TEST (by design — and a real coverage gap to know about)
 *   The actual fluent-ffmpeg transcode + screenshot chain (libx264, -map_metadata -1
 *   privacy strip, poster frame) is NEVER run here because ffmpeg is mocked and
 *   the code short-circuits in test mode. That real path (video.js lines ~38-71)
 *   is only exercised in the Layer 2 online suite on a box that has ffmpeg.
 *   The '-map_metadata -1' privacy guarantee in particular has NO automated
 *   assertion anywhere — flagged in ASSESSMENT.md.
 */
const fs = require('fs');
const path = require('path');
const { processApprovedVideo } = require('../../src/services/video');

jest.mock('fs');
jest.mock('fluent-ffmpeg');

describe('video service', () => {
   let originalEnv;

   beforeEach(() => {
      originalEnv = { ...process.env };
      jest.clearAllMocks();
   });

   afterEach(() => {
      process.env = originalEnv;
   });

   test('should reject if input file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      await expect(processApprovedVideo('nonexistent.mp4')).rejects.toThrow('File sorgente non trovato');
   });

   test('should copy file and resolve with videoName if GSTMXX_MOCK_VIDEO_PROCESSING is 1', async () => {
      fs.existsSync.mockReturnValue(true);
      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_MOCK_VIDEO_PROCESSING = '1';

      const result = await processApprovedVideo('test.mp4');
      
      expect(fs.copyFileSync).toHaveBeenCalled();
      expect(result).toEqual({
         videoName: 'pub-test.mp4',
         thumbnailName: null
      });
   });
});
