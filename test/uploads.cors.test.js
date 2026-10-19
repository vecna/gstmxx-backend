"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicUploadCors } = require('../lib/publicUploadCors.js');
test('mirror preflight exposes only public intake and token-deletion methods', () => {
  const headers = {};
  let code, ended = false;
  const res = { setHeader(k,v) { headers[k] = v; }, status(n) { code=n; return this; }, end() { ended=true; } };
  publicUploadCors({method:'OPTIONS'}, res, () => assert.fail('Preflight must end before upload middleware'));
  assert.equal(code,204); assert.equal(ended,true);
  assert.equal(headers['Access-Control-Allow-Origin'],'*');
  assert.equal(headers['Access-Control-Allow-Methods'],'POST, DELETE, OPTIONS');
  assert.match(headers['Access-Control-Allow-Headers'], /X-Delete-Token/);
  assert.equal(headers['Access-Control-Allow-Credentials'],undefined);
});
test('actual submissions and deletion continue to existing validation and token checks', () => {
  for (const method of ['POST','DELETE']) {
    let next = false;
    const headers = {};
    publicUploadCors({method}, {setHeader(k,v) {headers[k]=v;}}, () => {next=true;});
    assert.equal(next,true); assert.equal(headers['Access-Control-Allow-Origin'],'*');
  }
});
