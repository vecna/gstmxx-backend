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
