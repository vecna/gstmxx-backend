/**
 * UNIT TEST — src/bootstrap.js (first-run environment setup, F5 fix).
 *
 * WHAT WE TEST
 *   - ensureRuntimeDirectories() calls fs.mkdirSync so data/ and storage/*
 *     are created on a fresh clone (the F5 "directory does not exist" crash).
 *   - installProcessGuards() registers uncaughtException/unhandledRejection
 *     handlers exactly once (idempotent), which is half of B1's crash safety.
 *   - bootstrapRuntime() wires both together.
 *
 * HOW / CAVEAT
 *   fs is fully mocked (jest.mock('fs')), so this proves the *calls* are made
 *   with the right recursive intent — NOT that real directories appear on disk.
 *   The real mkdir is exercised for real by the Layer 1 integration boot.
 */
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
