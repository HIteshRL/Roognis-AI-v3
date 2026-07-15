// App-level tests: routing and request validation that reject before any
// database call, so they run without Postgres (same pattern as analytics).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../server');

let server;
let base;

test.before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('classroom app', async (t) => {
  await t.test('GET /health returns 200', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'classroom');
  });

  await t.test('GET /api/classroom/students serves the demo roster', async () => {
    const res = await request('GET', '/api/classroom/students');
    assert.equal(res.status, 200);
    assert.equal(res.body.students.length, 3);
    assert.equal(res.body.students[0].name, 'Arjun Sharma');
  });

  await t.test('POST /classes rejects a missing name', async () => {
    const res = await request('POST', '/api/classroom/classes', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /name is required/);
  });

  await t.test('POST /classes rejects an off-palette color', async () => {
    const res = await request('POST', '/api/classroom/classes', { name: 'X', color: '#123456' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /color must be one of/);
  });

  await t.test('malformed classroom ids 404 without hitting the DB', async () => {
    for (const path of [
      '/api/classroom/classes/not-a-uuid',
      '/api/classroom/classes/not-a-uuid/coursework',
      '/api/classroom/classes/not-a-uuid/announcements',
    ]) {
      const res = await request('GET', path);
      assert.equal(res.status, 404, path);
    }
  });

  await t.test('POST /join requires a code', async () => {
    const res = await request('POST', '/api/classroom/join', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /join code/);
  });

  await t.test('POST /join rejects a student outside the demo roster', async () => {
    const res = await request('POST', '/api/classroom/join', {
      code: 'ABCDEF',
      studentId: '99999999-9999-4999-8999-999999999999',
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /demo roster/);
  });

  await t.test('guardian invite validates email before touching the roster row', async () => {
    const res = await request(
      'POST',
      '/api/classroom/students/00000000-0000-0000-0000-000000000002/guardians',
      { email: 'not-an-email' },
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /valid guardian email/);
  });

  await t.test('guardian endpoints 404 for unknown students', async () => {
    const res = await request(
      'GET',
      '/api/classroom/students/99999999-9999-4999-8999-999999999999/guardians',
    );
    assert.equal(res.status, 404);
  });

  await t.test('calendar rejects end before start', async () => {
    const res = await request(
      'GET',
      '/api/classroom/calendar?start=2026-07-15T00:00:00Z&end=2026-07-01T00:00:00Z',
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /end must be after start/);
  });

  await t.test('unknown routes 404', async () => {
    const res = await request('GET', '/api/classroom/nope');
    assert.equal(res.status, 404);
  });
});
