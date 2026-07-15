const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';

const app = require('../server');

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : null,
            });
          });
        }
      );
      req.on('error', err => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('analytics app', () => {
  it('GET /health returns 200', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', service: 'analytics' });
  });

  it('POST /api/analytics/event rejects missing token', async () => {
    const res = await request('POST', '/api/analytics/event', {}, {
      type: 'chat_message',
      schoolId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/analytics/event rejects wrong token', async () => {
    const res = await request('POST', '/api/analytics/event', {
      'x-internal-service-token': 'wrong',
    }, {
      type: 'chat_message',
      schoolId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/analytics/event rejects invalid payload', async () => {
    const res = await request('POST', '/api/analytics/event', {
      'x-internal-service-token': process.env.INTERNAL_SERVICE_TOKEN,
    }, {
      type: 'chat_message',
      schoolId: 'not-a-uuid',
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/analytics/event rejects unknown event types', async () => {
    const res = await request('POST', '/api/analytics/event', {
      'x-internal-service-token': process.env.INTERNAL_SERVICE_TOKEN,
    }, {
      type: 'made_up_event',
      schoolId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /type must be one of/);
  });

  // Auth removed: /attendance no longer rejects unauthenticated callers — there
  // is no caller identity at all. The only rejection left is a data-validity
  // check that the studentId exists in the demo roster.
  it('POST /api/analytics/attendance rejects a student outside the demo roster', async () => {
    const res = await request('POST', '/api/analytics/attendance', {}, {
      studentId: '550e8400-e29b-41d4-a716-446655440000',
      date: '2026-07-09',
      status: 'present',
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /demo roster/);
  });

  it('POST /api/analytics/attendance rejects a malformed studentId', async () => {
    const res = await request('POST', '/api/analytics/attendance', {}, {
      studentId: 'not-a-uuid',
      date: '2026-07-09',
      status: 'present',
    });
    assert.equal(res.status, 400);
  });
});
