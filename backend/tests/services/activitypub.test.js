/**
 * UNIT TEST — src/services/activitypub.js (WIRING ONLY — read the caveat!).
 *
 * WHAT WE TEST
 *   - initActivityPub() wires the Fedify federation: setActorDispatcher +
 *     setKeyPairsDispatcher, setFollowersDispatcher, setInboxListeners, and two
 *     .on() handlers (Follow, Undo).
 *   - activityPubMiddleware() forwards to the federation object and calls next()
 *     when the federation returns nothing.
 *
 * ⚠️  CRITICAL CAVEAT — WHY THIS SUITE IS A FALSE-GREEN FOR B7  ⚠️
 *   getFedify is fully MOCKED below. The mock's federation object has a
 *   `.handle()` method, so the middleware's `fed.handle(req)` call "works" here.
 *   But the REAL @fedify/fedify 1.x object has NO `.handle()` — its HTTP
 *   entrypoint is `.fetch(request)`. So this test passes while the real
 *   integration is broken (every federation request 400s in production).
 *
 *   This suite therefore verifies only that the dispatchers are *registered*,
 *   not that the HTTP bridge is correct. The correct-API assertion lives in
 *   tests/ap_runtime.test.js (real library, pins `.fetch`), and the true
 *   end-to-end proof (WebFinger + actor JSON resolve) lives in the Layer 2
 *   online suite. Do NOT treat a green run here as "B7 done".
 */
const mockInboxSetters = {
   on: jest.fn()
};
mockInboxSetters.on.mockReturnValue(mockInboxSetters);

const mockActorSetters = {
   setKeyPairsDispatcher: jest.fn()
};

const mockFederation = {
   setActorDispatcher: jest.fn().mockReturnValue(mockActorSetters),
   setFollowersDispatcher: jest.fn(),
   setInboxListeners: jest.fn().mockReturnValue(mockInboxSetters),
   createContext: jest.fn(),
   handle: jest.fn().mockResolvedValue(null)
};

jest.mock('../../src/db', () => ({
   prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      run: jest.fn()
   })
}));

jest.mock('../../src/services/fedifyWrapper', () => ({
   getFedify: jest.fn().mockResolvedValue({
      createFederation: jest.fn().mockReturnValue(mockFederation),
      MemoryKvStore: jest.fn(),
      Accept: jest.fn(),
      Create: jest.fn(),
      Delete: jest.fn(),
      Endpoints: jest.fn(),
      Follow: jest.fn(),
      Image: jest.fn(),
      Person: jest.fn(),
      Note: jest.fn(),
      PUBLIC_COLLECTION: new URL('https://www.w3.org/ns/activitystreams#Public'),
      Tombstone: jest.fn(),
      Undo: jest.fn()
   })
}));

const { initActivityPub, activityPubMiddleware } = require('../../src/services/activitypub');

describe('activitypub service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockInboxSetters.on.mockReturnValue(mockInboxSetters);
      mockFederation.handle.mockResolvedValue(null);
   });

   test('initActivityPub should build and return a federation instance', async () => {
      const fed = await initActivityPub();
      expect(fed).toBe(mockFederation);
      expect(mockFederation.setActorDispatcher).toHaveBeenCalled();
      expect(mockActorSetters.setKeyPairsDispatcher).toHaveBeenCalled();
      expect(mockFederation.setFollowersDispatcher).toHaveBeenCalled();
      expect(mockFederation.setInboxListeners).toHaveBeenCalled();
      expect(mockInboxSetters.on).toHaveBeenCalledTimes(2);
   });

   test('activityPubMiddleware should forward requests to Fedify', async () => {
      const req = { url: '/federation/actors/video' };
      const res = { setHeader: jest.fn(), status: jest.fn(), send: jest.fn() };
      const next = jest.fn();

      mockFederation.handle.mockResolvedValueOnce(null);

      await activityPubMiddleware(req, res, next);
      expect(mockFederation.handle).toHaveBeenCalledWith(req);
      expect(next).toHaveBeenCalled();
   });
});
