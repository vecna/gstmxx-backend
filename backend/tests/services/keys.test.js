const { ensureActorKeyPairs, getActorKeyPairs, publicKeyToPem, ACTOR_HANDLES } = require('../../src/services/keys');
const db = require('../../src/db');

// Mock db
jest.mock('../../src/db', () => {
   const mockGet = jest.fn();
   const mockRun = jest.fn();
   const mockAll = jest.fn();
   const mockPrepare = jest.fn().mockReturnValue({
      get: mockGet,
      run: mockRun,
      all: mockAll
   });
   return {
      prepare: mockPrepare
   };
});

// Mock fedifyWrapper
jest.mock('../../src/services/fedifyWrapper', () => ({
   getFedify: jest.fn().mockResolvedValue({
      generateCryptoKeyPair: jest.fn().mockResolvedValue({
         publicKey: { type: 'public' },
         privateKey: { type: 'private' }
      }),
      exportJwk: jest.fn().mockResolvedValue({ kty: 'RSA' }),
      importJwk: jest.fn().mockResolvedValue({ type: 'CryptoKey' })
   })
}));

describe('keys service', () => {
   let originalEnv;

   beforeEach(() => {
      originalEnv = { ...process.env };
      jest.clearAllMocks();
   });

   afterEach(() => {
      process.env = originalEnv;
   });

   test('ensureActorKeyPairs should throw for invalid actor', async () => {
      await expect(ensureActorKeyPairs('invalid-actor')).rejects.toThrow('Unknown ActivityPub actor');
   });

   test('ensureActorKeyPairs should generate key pairs if not existing', async () => {
      db.prepare().get.mockReturnValue(null); // not existing
      db.prepare().all.mockReturnValue([
         { algorithm: 'RSASSA-PKCS1-v1_5', public_jwk: '{}', private_jwk: '{}' },
         { algorithm: 'Ed25519', public_jwk: '{}', private_jwk: '{}' }
      ]);

      const keys = await ensureActorKeyPairs('video');
      expect(db.prepare().run).toHaveBeenCalledTimes(2); // RSA and Ed25519
      expect(keys).toHaveLength(2);
   });

   test('publicKeyToPem should convert public key to pem format', async () => {
      global.crypto = {
         subtle: {
            exportKey: jest.fn().mockResolvedValue(Buffer.from('mock-spki-data'))
         }
      };

      const pem = await publicKeyToPem({ type: 'public' });
      expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
      expect(pem).toContain('-----END PUBLIC KEY-----');
   });
});
