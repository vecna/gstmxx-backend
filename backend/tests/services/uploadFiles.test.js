const fs = require('fs');
const path = require('path');
const {
   deriveThumbnailName,
   removeIfExists,
   removeUploadFiles,
   uploadFilePaths
} = require('../../src/services/uploadFiles');

const { STORAGE_INCOMING_DIR } = require('../../src/paths');

jest.mock('fs');

describe('uploadFiles service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   test('removeIfExists should return true and call fs.unlinkSync if file exists', () => {
      fs.existsSync.mockReturnValue(true);
      const result = removeIfExists('/path/to/file.mp4');
      expect(fs.existsSync).toHaveBeenCalledWith('/path/to/file.mp4');
      expect(fs.unlinkSync).toHaveBeenCalledWith('/path/to/file.mp4');
      expect(result).toBe(true);
   });

   test('removeIfExists should return false if file does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      const result = removeIfExists('/path/to/file.mp4');
      expect(fs.existsSync).toHaveBeenCalledWith('/path/to/file.mp4');
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(result).toBe(false);
   });

   test('deriveThumbnailName should derive thumbnail names properly', () => {
      expect(deriveThumbnailName(null)).toBeNull();
      expect(deriveThumbnailName('video.mp4')).toBe('thumb-video.png');
      expect(deriveThumbnailName('pub-video.mp4')).toBe('thumb-video.png');
   });

   test('uploadFilePaths should return incoming paths for pending status', () => {
      const record = { filename: 'test.mp4', status: 'pending' };
      const paths = uploadFilePaths(record);
      expect(paths[0]).toContain('incoming');
      expect(paths[0]).toContain('test.mp4');
   });

   test('uploadFilePaths should return approved and thumbnail paths for approved status', () => {
      const record = { filename: 'pub-test.mp4', status: 'approved' };
      const paths = uploadFilePaths(record);
      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain('approved');
      expect(paths[0]).toContain('pub-test.mp4');
      expect(paths[1]).toContain('thumbnails');
      expect(paths[1]).toContain('thumb-test.png');
   });

   test('uploadFilePaths should not derive thumbnails for approved clipboard uploads', () => {
      const record = { filename: 'pub-clipboard.png', kind: 'clipboard', status: 'approved' };
      const paths = uploadFilePaths(record);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain('approved');
      expect(paths[0]).toContain('pub-clipboard.png');
   });

   test('removeUploadFiles should filter and remove files', () => {
      const record = { filename: 'test.mp4', status: 'pending' };
      fs.existsSync.mockReturnValue(true);
      const removed = removeUploadFiles(record);
      expect(removed).toEqual([path.join(STORAGE_INCOMING_DIR, 'test.mp4')]);
   });
});
