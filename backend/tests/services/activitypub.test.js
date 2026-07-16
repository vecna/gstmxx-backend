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
