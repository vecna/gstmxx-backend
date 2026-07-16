/**
 * UNIT TEST — src/services/cleanup.js (B6 stale-upload cleanup).
 *
 * WHAT WE TEST
 *   - staleDays() reads GSTMXX_STALE_DAYS and falls back to 14 on missing/invalid.
 *   - cleanupStaleUploads() selects stale 'pending' rows, flips them to
 *     'deleted', and removes their files (one removeUploadFiles call per row).
 *   - startStaleUploadCleanup() installs an hourly interval that runs the sweep.
 *
 * HOW / CAVEAT
 *   db and uploadFiles are fully MOCKED here, so this verifies the control flow
 *   and counts — NOT the actual SQL date comparison. The real datetime()
 *   cutoff logic (the thing most likely to be subtly wrong) is exercised
 *   against real SQLite in layer1.test.js ("cleanupStaleUploads marks old...").
 *   Fake timers let us advance an hour without waiting.
 */
const { cleanupStaleUploads, startStaleUploadCleanup, staleDays } = require('../../src/services/cleanup');
const db = require('../../src/db');
const { removeUploadFiles } = require('../../src/services/uploadFiles');

jest.mock('../../src/db', () => {
   const mockAll = jest.fn();
   const mockRun = jest.fn();
   const mockPrepare = jest.fn().mockReturnValue({
      all: mockAll,
      run: mockRun
   });
   const mockTransaction = jest.fn().mockImplementation((cb) => {
      return (...args) => cb(...args);
   });
   return {
      prepare: mockPrepare,
      transaction: mockTransaction
   };
});

jest.mock('../../src/services/uploadFiles', () => ({
   removeUploadFiles: jest.fn()
}));

describe('cleanup service', () => {
   let originalEnv;

   beforeEach(() => {
      originalEnv = { ...process.env };
      jest.clearAllMocks();
      jest.useFakeTimers();
   });

   afterEach(() => {
      process.env = originalEnv;
      jest.useRealTimers();
   });

   test('staleDays should return value from env or fallback to 14', () => {
      process.env.GSTMXX_STALE_DAYS = '5';
      expect(staleDays()).toBe(5);

      delete process.env.GSTMXX_STALE_DAYS;
      expect(staleDays()).toBe(14);

      process.env.GSTMXX_STALE_DAYS = 'invalid';
      expect(staleDays()).toBe(14);
   });

   test('cleanupStaleUploads should query stale records and update their status', () => {
      const mockStaleRows = [
         { id: '1', filename: 'v1.mp4', thumbnail_filename: 't1.png', status: 'pending' },
         { id: '2', filename: 'v2.mp4', thumbnail_filename: 't2.png', status: 'pending' }
      ];
      
      const mockPrepare = db.prepare;
      const mockAll = mockPrepare().all;
      const mockRun = mockPrepare().run;

      mockAll.mockReturnValue(mockStaleRows);
      mockRun.mockReturnValue({ changes: 1 });

      const result = cleanupStaleUploads(new Date('2026-07-16T23:00:00.000Z'));
      
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalledTimes(2);
      expect(removeUploadFiles).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ scanned: 2, deleted: 2 });
   });

   test('startStaleUploadCleanup should setup interval and run', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const mockPrepare = db.prepare;
      mockPrepare().all.mockReturnValue([]);

      const timer = startStaleUploadCleanup();
      expect(timer).toBeDefined();

      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(mockPrepare().all).toHaveBeenCalled();

      logSpy.mockRestore();
   });
});
