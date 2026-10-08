import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { UpstreamError } from '../src/data/openmeteo.js';

const quiet = { info() {}, warn() {}, error() {} };
let server;
let base;
const calls = [];

const service = {
  async geocode(q) {
    return [{ name: q, latitude: 1, longitude: 2 }];
  },
  async forecast(loc) {
    calls.push(loc);
    if (loc.latitude === 66) throw new UpstreamError('down');
    return { ok: true };
  },
};

before(async () => {
  server = createApp({ service, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test('geocode returns results and ignores short queries', async () => {
  const short = await (await fetch(`${base}/api/geocode?q=a`)).json();
  assert.deepEqual(short.results, []);
  const res = await (await fetch(`${base}/api/geocode?q=Brno`)).json();
  assert.equal(res.results[0].name, 'Brno');
});

test('forecast validates coordinates', async () => {
  for (const qs of ['', 'lat=abc&lon=1', 'lat=91&lon=0', 'lat=0&lon=181', 'lat=&lon=']) {
    const res = await fetch(`${base}/api/forecast?${qs}`);
    assert.equal(res.status, 400, qs);
  }
  const ok = await fetch(`${base}/api/forecast?lat=49.19&lon=16.61`);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.at(-1), { latitude: 49.19, longitude: 16.61 });
});

test('upstream failures become 502', async () => {
  const res = await fetch(`${base}/api/forecast?lat=66&lon=0`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unavailable/);
});

test('serves the site and 404s unknown API routes', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Weather Prediction/);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
