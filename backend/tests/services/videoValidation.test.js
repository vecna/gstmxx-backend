const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateUploadedPng, validateUploadedVideo } = require('../../src/services/videoValidation');

jest.mock('fluent-ffmpeg');

describe('videoValidation service', () => {
   let originalEnv;

   beforeEach(() => {
      originalEnv = { ...process.env };
      jest.clearAllMocks();
   });

   afterEach(() => {
      process.env = originalEnv;
   });

   test('should return true if mocked as video in test environment', async () => {
      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_MOCK_FFPROBE = 'video';
      const result = await validateUploadedVideo('dummy.mp4');
      expect(result).toBe(true);
   });

   test('should return false if mocked as non-video in test environment', async () => {
      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_MOCK_FFPROBE = 'invalid';
      const result = await validateUploadedVideo('dummy.mp4');
      expect(result).toBe(false);
   });

   test('should return true if ffprobe finds video streams', async () => {
      delete process.env.GSTMXX_MOCK_FFPROBE;
      ffmpeg.ffprobe.mockImplementation((filePath, callback) => {
         callback(null, {
            streams: [{ codec_type: 'audio' }, { codec_type: 'video' }]
         });
      });

      const result = await validateUploadedVideo('dummy.mp4');
      expect(result).toBe(true);
   });

   test('should return false if ffprobe fails or has no video streams', async () => {
      delete process.env.GSTMXX_MOCK_FFPROBE;
      ffmpeg.ffprobe.mockImplementation((filePath, callback) => {
         callback(new Error('ffprobe error'), null);
      });

      let result = await validateUploadedVideo('dummy.mp4');
      expect(result).toBe(false);

      ffmpeg.ffprobe.mockImplementation((filePath, callback) => {
         callback(null, { streams: [{ codec_type: 'audio' }] });
      });

      result = await validateUploadedVideo('dummy.mp4');
      expect(result).toBe(false);
   });

   test('should validate PNG signatures for clipboard uploads', () => {
      const pngPath = path.join(os.tmpdir(), `gstmxx-${Date.now()}.png`);
      const txtPath = path.join(os.tmpdir(), `gstmxx-${Date.now()}.txt`);
      fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      fs.writeFileSync(txtPath, 'not a png');

      expect(validateUploadedPng(pngPath)).toBe(true);
      expect(validateUploadedPng(txtPath)).toBe(false);

      fs.rmSync(pngPath, { force: true });
      fs.rmSync(txtPath, { force: true });
   });
});
