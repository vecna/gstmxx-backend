/**
 * UNIT TEST — src/services/activitypub.js (WIRING ONLY — read the caveat!).
 *
 * WHAT WE TEST
 *   - initActivityPub() wires the Fedify federation: setActorDispatcher +
 *     setKeyPairsDispatcher, setFollowersDispatcher, setInboxListeners, and two
 *     .on() handlers (Follow, Undo).
 *   - activityPubMiddleware() adapts Express requests to Fedify's real
 *     federation.fetch(Request) bridge and writes the returned Response.
 */
const mockInboxSetters = {
   on: jest.fn()
};
mockInboxSetters.on.mockReturnValue(mockInboxSetters);

const mockActorSetters = {
   setKeyPairsDispatcher: jest.fn(),
   mapHandle: jest.fn()
};
mockActorSetters.setKeyPairsDispatcher.mockReturnValue(mockActorSetters);
mockActorSetters.mapHandle.mockReturnValue(mockActorSetters);

const mockFederation = {
   setActorDispatcher: jest.fn().mockReturnValue(mockActorSetters),
   setFollowersDispatcher: jest.fn(),
   setInboxListeners: jest.fn().mockReturnValue(mockInboxSetters),
   createContext: jest.fn(),
   fetch: jest.fn().mockResolvedValue(new Response(null, { status: 204 }))
};

jest.mock('../../src/db', () => ({
   prepare: jest.fn().mockReturnValue({
      get: jest.fn(),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn()
   })
}));

jest.mock('../../src/services/fedifyWrapper', () => ({
      getFedify: jest.fn().mockResolvedValue({
      createFederation: jest.fn().mockReturnValue(mockFederation),
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
      mockActorSetters.setKeyPairsDispatcher.mockReturnValue(mockActorSetters);
      mockActorSetters.mapHandle.mockReturnValue(mockActorSetters);
      mockFederation.fetch.mockResolvedValue(new Response(null, { status: 204 }));
   });

   test('initActivityPub should build and return a federation instance', async () => {
      const fed = await initActivityPub();
      expect(fed).toBe(mockFederation);
      expect(mockFederation.setActorDispatcher).toHaveBeenCalled();
      expect(mockActorSetters.setKeyPairsDispatcher).toHaveBeenCalled();
      expect(mockActorSetters.mapHandle).toHaveBeenCalled();
      expect(mockFederation.setFollowersDispatcher).toHaveBeenCalled();
      expect(mockFederation.setInboxListeners).toHaveBeenCalled();
      expect(mockInboxSetters.on).toHaveBeenCalledTimes(2);
   });

   test('activityPubMiddleware should forward requests to Fedify', async () => {
      const req = {
         method: 'GET',
         url: '/federation/actors/video',
         originalUrl: '/federation/actors/video',
         headers: { accept: 'application/activity+json' },
         protocol: 'http',
         get: jest.fn((name) => name === 'host' ? '127.0.0.1:3000' : undefined)
      };
      const res = { setHeader: jest.fn(), status: jest.fn(), end: jest.fn() };
      const next = jest.fn();

      mockFederation.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await activityPubMiddleware(req, res, next);
      expect(mockFederation.fetch).toHaveBeenCalled();
      expect(mockFederation.fetch.mock.calls[0][0]).toBeInstanceOf(Request);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
   });
});
