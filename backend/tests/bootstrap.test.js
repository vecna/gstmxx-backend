const fs = require('fs');
const path = require('path');
const { ensureRuntimeDirectories, installProcessGuards, bootstrapRuntime } = require('../src/bootstrap');

jest.mock('fs');

describe('bootstrap module', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      delete process.__gstmxxProcessGuardsInstalled;
   });

   test('ensureRuntimeDirectories should call fs.mkdirSync for each runtime directory', () => {
      ensureRuntimeDirectories();
      expect(fs.mkdirSync).toHaveBeenCalled();
   });

   test('installProcessGuards should only register process handlers once', () => {
      const processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => {});
      installProcessGuards();
      expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));

      processOnSpy.mockClear();
      installProcessGuards();
      expect(processOnSpy).not.toHaveBeenCalled();

      processOnSpy.mockRestore();
   });

   test('bootstrapRuntime should invoke ensureRuntimeDirectories and installProcessGuards', () => {
      const processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => {});
      bootstrapRuntime();
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      processOnSpy.mockRestore();
   });
});
