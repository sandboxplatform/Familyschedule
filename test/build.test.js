import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp, frontEndBuild } from '../server/app.js';
import { Store } from '../server/store.js';
import { openDatabase } from '../server/db.js';
import { buildWatcher } from '../public/js/api.js';

async function tempPublic() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-public-'));
  await fs.mkdir(path.join(dir, 'js'));
  await fs.writeFile(path.join(dir, 'index.html'), '<p>tv</p>');
  await fs.writeFile(path.join(dir, 'js', 'tv.js'), 'console.log(1);');
  return dir;
}

test('the build changes exactly when what the browser loads changes', async () => {
  const dir = await tempPublic();
  const first = frontEndBuild(dir);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(frontEndBuild(dir), first, 'a restart with nothing new is the same build');

  await fs.writeFile(path.join(dir, 'js', 'tv.js'), 'console.log(2);');
  const edited = frontEndBuild(dir);
  assert.notEqual(edited, first, 'an edited script is a new build');

  await fs.writeFile(path.join(dir, 'js', 'speech.js'), '');
  assert.notEqual(frontEndBuild(dir), edited, 'an added file is a new build');
});

test('the real front end has a build', () => {
  const publicDir = path.join(process.cwd(), 'public');
  assert.match(frontEndBuild(publicDir), /^[0-9a-f]{12}$/);
});

test('the stream greeting and the health check both carry the build', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-build-'));
  const publicDir = await tempPublic();
  const store = new Store(openDatabase(path.join(dir, 'calendar.db')));
  await store.load();
  const server = createApp(store, { weather: { get: async () => null }, publicDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const build = frontEndBuild(publicDir);

  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.build, build);

    const created = await fetch(`${base}/api/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tv@example.com', password: 'a-good-password' }),
    });
    const cookie = created.headers.get('set-cookie').split(';')[0];

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = stream.body.getReader();
    let seen = '';
    while (!seen.includes('event: hello\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    while (!/event: hello\ndata: .*\n/.test(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    controller.abort();
    const hello = JSON.parse(seen.match(/event: hello\ndata: (.*)\n/)[1]);
    assert.equal(hello.build, build);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});

test('a screen reloads once, and only for a build it did not start with', () => {
  const reloads = [];
  const notice = buildWatcher((build) => reloads.push(build));

  assert.equal(notice('aaa'), false, 'the first build is the one the page was loaded with');
  assert.equal(notice('aaa'), false, 'a reconnect to the same build changes nothing');
  assert.equal(notice(undefined), false, 'an old server reports no build; ignore it');
  assert.equal(notice('bbb'), true, 'a new build means reload');
  assert.equal(notice('ccc'), false, 'and only once, however many follow');
  assert.deepEqual(reloads, ['bbb']);
});

test('a greeting without a build never sets the baseline', () => {
  const reloads = [];
  const notice = buildWatcher((build) => reloads.push(build));
  notice(undefined);
  notice('');
  assert.equal(notice('aaa'), false);
  assert.equal(notice('aaa'), false);
  assert.deepEqual(reloads, []);
});
