// Integration tests for the Phase 1 API.  Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { hashPassword, newId, now } from '../src/security.js';

let server, base, db;

before(async () => {
  db = openDatabase(':memory:');
  const app = createApp({
    db,
    mailer: createMailer(db, { log: false }),
    config: { appUrl: 'http://app.test', allowedOrigins: ['http://app.test'], exposeDevLinks: true, ipRateLimits: false }
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  // An admin can only be created by an operator, never through sign-up.
  const t = now();
  db.run(
    `INSERT INTO users (id,email,password_hash,name,role,email_verified,onboarded,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    newId(), 'admin@test.ng', hashPassword('admin-password-1'), 'Admin', 'admin', t, t
  );
});
after(() => server.close());

/** A tiny client that keeps its own session cookie. */
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    const json = await res.json();
    return { status: res.status, ...json };
  };
}
const tokenFrom = (link) => new URL(link).searchParams.get('verify') || new URL(link).searchParams.get('reset');

async function signupVerified(name, emailAddr, role = 'farmer') {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { name, email: emailAddr, password: 'correct-horse-9', role, acceptTerms: true });
  assert.equal(r.status, 201, JSON.stringify(r));
  const v = await c('POST', '/api/auth/verify-email', { token: tokenFrom(r.devVerifyLink) });
  assert.equal(v.user.emailVerified, true);
  return { c, user: v.user };
}

test('sign-up validates input and refuses admin role', async () => {
  const c = client();
  let r = await c('POST', '/api/auth/signup', { name: 'A', email: 'bad', password: 'x', role: 'farmer', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c('POST', '/api/auth/signup', { name: 'Ada', email: 'ada@test.ng', password: 'long-enough-pw', role: 'admin', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c('POST', '/api/auth/signup', { name: 'Ada', email: 'ada@test.ng', password: 'long-enough-pw', role: 'farmer' });
  assert.equal(r.error.code, 'terms_required');
});

test('sign-up, session, logout and login', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { name: 'Bisi Ola', email: 'Bisi@Test.ng', password: 'correct-horse-9', role: 'enthusiast', acceptTerms: true });
  assert.equal(r.status, 201);
  assert.equal(r.user.email, 'bisi@test.ng');
  assert.equal(r.user.emailVerified, false);
  assert.equal((await c('GET', '/api/auth/me')).user.name, 'Bisi Ola');
  const dup = await c('POST', '/api/auth/signup', { name: 'Bisi', email: 'bisi@test.ng', password: 'correct-horse-9', role: 'farmer', acceptTerms: true });
  assert.equal(dup.status, 409);
  await c('POST', '/api/auth/logout', {});
  assert.equal((await c('GET', '/api/auth/me')).user, null);
  assert.equal((await c('POST', '/api/auth/login', { email: 'bisi@test.ng', password: 'wrong-password' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'bisi@test.ng', password: 'correct-horse-9' })).user.role, 'enthusiast');
});

test('unverified users cannot post; verified users can', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { name: 'Chidi', email: 'chidi@test.ng', password: 'correct-horse-9', role: 'farmer', acceptTerms: true });
  const blocked = await c('POST', '/api/posts', { topic: 'crops', body: 'Hello farmers' });
  assert.equal(blocked.error.code, 'email_unverified');
  await c('POST', '/api/auth/verify-email', { token: tokenFrom(r.devVerifyLink) });
  const ok = await c('POST', '/api/posts', { topic: 'crops', body: 'Hello farmers' });
  assert.equal(ok.status, 201);
  assert.equal(ok.post.author.name, 'Chidi');
  // A verification link works once.
  assert.equal((await c('POST', '/api/auth/verify-email', { token: tokenFrom(r.devVerifyLink) })).status, 400);
});

test('a typed city or state places the profile in a country; ambiguous places are left for the member to pick', async () => {
  const { c } = await signupVerified('Amaka', 'amaka@test.ng', 'farmer');
  assert.equal((await c('PATCH', '/api/me', { location: 'Victoria Island, Lagos' })).user.country, 'Nigeria');
  assert.equal((await c('PATCH', '/api/me', { location: 'Nakuru' })).user.country, 'Kenya');
  // Punjab is in India and Pakistan: the country stays as it was until the member picks one.
  assert.equal((await c('PATCH', '/api/me', { location: 'Punjab' })).user.country, 'Kenya');
  assert.equal((await c('PATCH', '/api/me', { location: 'Punjab', country: 'Pakistan' })).user.country, 'Pakistan');
  assert.equal((await c('PATCH', '/api/me', { country: 'Atlantis' })).status, 400);
  // Country personalises discovery, never restricts it.
  const all = await c('GET', '/api/specialists');
  assert.equal(all.status, 200);
  assert.ok((await c('GET', '/api/meta')).countries.includes('Brazil'));
});

test('onboarding saves interests and follows them; feed "following" view uses them', async () => {
  const { c } = await signupVerified('Dayo', 'dayo@test.ng', 'enthusiast');
  const bad = await c('PATCH', '/api/me', { interests: ['not-a-topic'] });
  assert.equal(bad.status, 400);
  const r = await c('PATCH', '/api/me', { interests: ['poultry'], goals: ['find-a-job'], location: 'Kaduna', completeOnboarding: true });
  assert.equal(r.user.onboarded, true);
  const follows = await c('GET', '/api/me/follows');
  assert.deepEqual(follows.topics, ['poultry']);
  const { c: author } = await signupVerified('Poultry Pro', 'pp@test.ng', 'specialist');
  await author('POST', '/api/posts', { topic: 'poultry', body: 'Biosecurity checklist for broiler houses' });
  await author('POST', '/api/posts', { topic: 'aquaculture', body: 'Catfish pond pH notes' });
  const feed = await c('GET', '/api/posts?view=following');
  assert.ok(feed.posts.some((p) => p.topic === 'poultry'));
  assert.ok(!feed.posts.some((p) => p.topic === 'aquaculture'));
});

test('comments, threaded replies, likes and notifications', async () => {
  const { c: a, user: ua } = await signupVerified('Author A', 'a@test.ng');
  const { c: b } = await signupVerified('Reader B', 'b@test.ng');
  const { c: d } = await signupVerified('Reader D', 'd@test.ng');
  const post = (await a('POST', '/api/posts', { topic: 'crops', body: 'Maize spacing question' })).post;
  const top = (await b('POST', `/api/posts/${post.id}/comments`, { body: 'Use 75cm x 25cm' })).comment;
  const reply = (await d('POST', `/api/posts/${post.id}/comments`, { body: 'Agreed', parentId: top.id })).comment;
  assert.equal(reply.parentId, top.id);
  const deep = (await a('POST', `/api/posts/${post.id}/comments`, { body: 'Thanks both', parentId: reply.id })).comment;
  assert.equal(deep.parentId, top.id, 'threads stay one level deep');
  const like = await b('POST', `/api/posts/${post.id}/like`, {});
  assert.deepEqual([like.liked, like.likeCount], [true, 1]);
  const unlike = await b('POST', `/api/posts/${post.id}/like`, {});
  assert.equal(unlike.liked, false);
  const na = await a('GET', '/api/notifications');
  assert.ok(na.notifications.some((n) => n.kind === 'comment'));
  assert.ok(na.notifications.some((n) => n.kind === 'like'));
  const nb = await b('GET', '/api/notifications');
  assert.ok(nb.notifications.some((n) => n.kind === 'reply'));
  await a('POST', '/api/notifications/read-all', {});
  assert.equal((await a('GET', '/api/notifications')).unread, 0);
  // Turning off like notifications is respected.
  await a('PATCH', '/api/me', { notificationPrefs: { likes: false } });
  await d('POST', `/api/posts/${post.id}/like`, {});
  assert.equal((await a('GET', '/api/notifications')).unread, 0);
  const thread = await b('GET', `/api/posts/${post.id}/comments`);
  assert.equal(thread.comments.length, 3);
  assert.equal(ua.role, 'farmer');
});

test('saving posts and the saved view', async () => {
  const { c } = await signupVerified('Saver', 'saver@test.ng');
  const p = (await c('POST', '/api/posts', { topic: 'irrigation', body: 'Drip line flushing tips' })).post;
  assert.equal((await c('POST', `/api/posts/${p.id}/save`, {})).saved, true);
  const saved = await c('GET', '/api/posts?view=saved');
  assert.deepEqual(saved.posts.map((x) => x.id), [p.id]);
});

test('block hides content both ways and stops replies; mute hides one way', async () => {
  const { c: a, user: ua } = await signupVerified('Blocker', 'blocker@test.ng');
  const { c: b, user: ub } = await signupVerified('Blocked', 'blocked@test.ng');
  const pa = (await a('POST', '/api/posts', { topic: 'livestock', body: 'Post by blocker' })).post;
  const pb = (await b('POST', '/api/posts', { topic: 'livestock', body: 'Post by blocked' })).post;
  await a('POST', '/api/blocks', { userId: ub.id, kind: 'block' });
  assert.ok(!(await a('GET', '/api/posts?topic=livestock')).posts.some((p) => p.id === pb.id));
  assert.ok(!(await b('GET', '/api/posts?topic=livestock')).posts.some((p) => p.id === pa.id));
  assert.equal((await b('POST', `/api/posts/${pa.id}/comments`, { body: 'hi' })).status, 403);
  assert.equal((await b('GET', `/api/users/${ua.id}`)).status, 404);
  await a('POST', '/api/blocks', { userId: ub.id, kind: 'block' }); // toggle off
  await a('POST', '/api/blocks', { userId: ub.id, kind: 'mute' });
  assert.ok(!(await a('GET', '/api/posts?topic=livestock')).posts.some((p) => p.id === pb.id));
  assert.ok((await b('GET', '/api/posts?topic=livestock')).posts.some((p) => p.id === pa.id));
});

test('report → admin removal → appeal → overturn restores content, all audited', async () => {
  const { c: author } = await signupVerified('Seller', 'seller@test.ng', 'business');
  const { c: reporter } = await signupVerified('Watcher', 'watcher@test.ng');
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@test.ng', password: 'admin-password-1' });

  const post = (await author('POST', '/api/posts', { topic: 'agribusiness', body: 'Send N50,000 to get a guaranteed job' })).post;
  const rep = await reporter('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'scam', details: 'Asks for payment' });
  assert.equal(rep.status, 201);
  assert.equal((await reporter('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'scam' })).duplicate, true);

  // Non-admins cannot see the queue.
  assert.equal((await reporter('GET', '/api/admin/reports')).status, 403);
  const queue = await admin('GET', '/api/admin/reports');
  const item = queue.reports.find((r) => r.targetId === post.id);
  assert.ok(item);
  const res = await admin('POST', `/api/admin/reports/${item.id}/resolve`, { action: 'remove_content', note: 'Payment request for a job breaches the anti-scam policy.' });
  assert.equal(res.ok, true);
  assert.ok(!(await reporter('GET', '/api/posts?topic=agribusiness')).posts.some((p) => p.id === post.id));

  const decisions = await author('GET', '/api/me/moderation');
  assert.equal(decisions.decisions[0].action, 'remove_content');
  const appeal = await author('POST', '/api/appeals', { reportId: item.id, message: 'This was a training fee notice, not a job offer.' });
  assert.equal(appeal.status, 201);
  assert.equal((await author('POST', '/api/appeals', { reportId: item.id, message: 'Second try at appealing' })).status, 409);
  const appeals = await admin('GET', '/api/admin/appeals');
  await admin('POST', `/api/admin/appeals/${appeals.appeals[0].id}/decide`, { decision: 'overturned', note: 'Context accepted; please clarify wording.' });
  assert.ok((await reporter('GET', '/api/posts?topic=agribusiness')).posts.some((p) => p.id === post.id));

  const auditLog = await admin('GET', '/api/admin/audit');
  const actions = auditLog.entries.map((e) => e.action);
  for (const a of ['report.remove_content', 'appeal.submitted', 'appeal.overturned']) assert.ok(actions.includes(a), a);
});

test('admin suspends and reinstates a user; suspended users are read-only', async () => {
  const { c, user } = await signupVerified('Rulebreaker', 'rb@test.ng');
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@test.ng', password: 'admin-password-1' });
  assert.equal((await admin('PATCH', `/api/admin/users/${user.id}`, { status: 'suspended' })).status, 400, 'reason required');
  await admin('PATCH', `/api/admin/users/${user.id}`, { status: 'suspended', reason: 'Repeated spam' });
  assert.equal((await c('POST', '/api/posts', { topic: 'crops', body: 'more spam' })).error.code, 'suspended');
  assert.ok((await c('GET', '/api/posts')).posts, 'can still read');
  await admin('PATCH', `/api/admin/users/${user.id}`, { status: 'active', reason: 'Appeal accepted' });
  assert.equal((await c('POST', '/api/posts', { topic: 'crops', body: 'back again' })).status, 201);
  const users = await admin('GET', '/api/admin/users?q=Rulebreaker');
  assert.equal(users.users[0].status, 'active');
  // A non-admin cannot promote themselves.
  assert.equal((await c('PATCH', `/api/admin/users/${user.id}`, { role: 'admin', reason: 'please' })).status, 403);
});

test('password reset signs out other sessions; tokens are single-use', async () => {
  const { c } = await signupVerified('Forgetful', 'forget@test.ng');
  const anon = client();
  const r = await anon('POST', '/api/auth/request-reset', { email: 'forget@test.ng' });
  const unknown = await anon('POST', '/api/auth/request-reset', { email: 'nobody@test.ng' });
  assert.equal(unknown.ok, true, 'no account enumeration');
  const token = tokenFrom(r.devResetLink);
  assert.equal((await anon('POST', '/api/auth/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/reset-password', { token, password: 'a-brand-new-password' })).ok, true);
  assert.equal((await anon('POST', '/api/auth/reset-password', { token, password: 'another-new-password' })).status, 400);
  assert.equal((await c('GET', '/api/auth/me')).user, null, 'old session revoked');
  assert.ok((await anon('POST', '/api/auth/login', { email: 'forget@test.ng', password: 'a-brand-new-password' })).user);
});

test('privacy: members-only profiles and hidden location', async () => {
  const { c, user } = await signupVerified('Private Person', 'private@test.ng');
  await c('PATCH', '/api/me', { location: 'Jos', privacy: { showLocation: false } });
  assert.equal((await client()('GET', `/api/users/${user.id}`)).status, 401);
  const { c: other } = await signupVerified('Other', 'other@test.ng');
  const view = await other('GET', `/api/users/${user.id}`);
  assert.equal(view.user.location, '');
  assert.equal((await c('GET', `/api/users/${user.id}`)).user.location, 'Jos', 'owner sees own location');
});

test('CSRF guards: foreign origin and non-JSON bodies are rejected', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'a@b.cd', password: 'x' })
  });
  assert.equal(res.status, 403);
  const res2 = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=a@b.cd&password=x'
  });
  assert.equal(res2.status, 415);
});

test('login is rate limited per account', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 10; i++) last = await c('POST', '/api/auth/login', { email: 'victim@test.ng', password: 'guess-' + i });
  assert.equal(last.status, 429);
});
