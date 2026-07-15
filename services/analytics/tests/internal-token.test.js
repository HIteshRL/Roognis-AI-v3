const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const requireInternalToken = require('../middleware/internal-token');

function runMiddleware(headers = {}) {
  const req = { headers };
  let statusCode = 200;
  let body = null;
  let nextCalled = false;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      body = payload;
      return res;
    },
  };

  requireInternalToken(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe('requireInternalToken', () => {
  let originalToken;

  beforeEach(() => {
    originalToken = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = originalToken;
  });

  it('rejects missing token with 401', () => {
    const result = runMiddleware();
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects wrong token with 401', () => {
    const result = runMiddleware({ 'x-internal-service-token': 'wrong' });
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('accepts correct token', () => {
    const result = runMiddleware({ 'x-internal-service-token': 'secret-token' });
    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, 200);
  });
});
