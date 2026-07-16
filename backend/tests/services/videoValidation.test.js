const ffmpeg = require('fluent-ffmpeg');
const { validateUploadedVideo } = require('../../src/services/videoValidation');

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
});
