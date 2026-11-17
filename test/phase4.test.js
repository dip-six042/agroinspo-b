// Integration tests for Phase 4: business verification, listings & leads, adverts, sponsorship.  Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { hashPassword, newId, now } from '../src/security.js';

let server, base, db, app;
let admin, biz, biz2, host, farmer, anon;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body)
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type };
    return { status: res.status, ...(await res.json()) };
  };
}
async function member(role, name) {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${newId().slice(0, 6)}@test.ng`;
  const id = newId();
  db.run(`INSERT INTO users (id,email,password_hash,name,role,email_verified,onboarded,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, email, hashPassword('a-good-password'), name, role, now(), now());
  const c = client();
  await c('POST', '/api/auth/login', { email, password: 'a-good-password' });
  return { c, id };
}
async function pay(checkoutUrl) {
  const r = await fetch(base + new URL(checkoutUrl).pathname + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'success' }) });
  assert.equal(r.status, 200);
}
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
const profile = {
  legalName: 'Green Valley Agro Inputs Ltd', tradingName: 'Green Valley Inputs', category: 'inputs', rcNumber: 'rc1234567',
  address: '14 Ring Road, Ibadan', region: 'Oyo', serviceArea: 'South-West', contactName: 'Kemi Adebayo', contactRole: 'Sales manager',
  phone: '+234 803 000 0000', website: 'https://greenvalley.example', about: 'Certified seed and fertiliser dealer.'
};

async function verify(b) {
  assert.equal((await b.c('PUT', '/api/me/business', profile)).status, 200);
  assert.equal((await b.c('POST', '/api/me/business/evidence?label=CAC%20certificate', pdf, { 'Content-Type': 'application/pdf', 'X-Filename': 'cac.pdf' })).status, 201);
  assert.equal((await b.c('POST', '/api/me/business/submit', { authorised: true })).status, 'pending');
  assert.equal((await admin('POST', `/api/admin/businesses/${b.id}/verify`, { decision: 'verified', scope: 'CAC registration RC1234567 confirmed on the CAC portal; director’s ID matched.' })).ok, true);
}

before(async () => {
  db = openDatabase(':memory:');
  app = createApp({
    db, mailer: createMailer(db, { log: false }),
    config: { appUrl: 'http://app.test', allowedOrigins: ['http://app.test'], exposeDevLinks: true, ipRateLimits: false, uploadDir: mkdtempSync(join(tmpdir(), 'agro-p4-')) }
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await member('admin', 'Admin One')).c;
  biz = await member('business', 'Green Valley');
  biz2 = await member('business', 'Agro Two');
  host = await member('specialist', 'Dr. Host');
  farmer = await member('farmer', 'Farmer Musa');
  anon = client();
});
after(() => server.close());

test('business verification: required details, evidence privacy, scope shown publicly, re-verify on identity change', async () => {
  assert.equal((await farmer.c('GET', '/api/me/business')).status, 403);
  assert.equal((await biz.c('POST', '/api/me/business/submit', { authorised: true })).status, 400, 'details missing');
  assert.equal((await biz.c('GET', `/api/businesses/${biz.id}`)).status, 200, 'owner can preview');
  assert.equal((await anon('GET', `/api/businesses/${biz.id}`)).status, 404, 'unverified businesses are not public');
  await verify(biz);
  const me = await biz.c('GET', '/api/me/business');
  assert.equal(me.canAdvertise, true);
  const evidenceId = me.profile.evidence[0].fileId;
  assert.equal((await farmer.c('GET', `/api/files/${evidenceId}`)).status, 404, 'evidence is private');
  assert.equal((await admin('GET', `/api/files/${evidenceId}`)).status, 200);
  const pub = await anon('GET', `/api/businesses/${biz.id}`);
  assert.match(pub.business.verification.scope, /CAC registration/);
  assert.equal(pub.business.phone, undefined, 'phone stays private');
  assert.equal(pub.business.rcNumber, undefined);
  // Changing the legal name withdraws verification.
  const r = await biz.c('PUT', '/api/me/business', { ...profile, legalName: 'Green Valley Holdings Ltd' });
  assert.equal(r.reverify, true);
  assert.equal(r.profile.verification.status, 'unverified');
  await biz.c('PUT', '/api/me/business', profile);
  await biz.c('POST', '/api/me/business/submit', { authorised: true });
  await admin('POST', `/api/admin/businesses/${biz.id}/verify`, { decision: 'verified', scope: 'CAC registration RC1234567 confirmed again after a name check.' });
});

test('listings and enquiries: only verified businesses list publicly; an enquiry becomes a lead and a conversation', async () => {
  const l = (await biz.c('POST', '/api/me/listings', { kind: 'product', title: 'Hybrid maize seed (SAMMAZ 52)', description: 'NASC-certified hybrid maize seed, 20 kg bags, early maturing.', topic: 'crops', priceType: 'from', priceNgn: 42000, unit: 'per 20 kg bag' })).listing;
  assert.ok(l.id);
  assert.equal((await biz.c('POST', `/api/me/listings/${l.id}/image`, png, { 'Content-Type': 'image/png' })).status, 201);
  const market = await anon('GET', '/api/listings?topic=crops');
  assert.ok(market.listings.some((x) => x.id === l.id && x.business.verified));
  // biz2 isn't verified, so its listing stays out of the marketplace.
  const l2 = (await biz2.c('POST', '/api/me/listings', { kind: 'service', title: 'Tractor hire', description: 'Ploughing and harrowing with operator, per hectare.', topic: 'mechanisation' })).listing;
  assert.ok(!(await anon('GET', '/api/listings')).listings.some((x) => x.id === l2.id));

  assert.equal((await anon('POST', '/api/enquiries', { businessId: biz.id, message: 'Do you deliver to Ogbomoso?' })).status, 401);
  const e = await farmer.c('POST', '/api/enquiries', { businessId: biz.id, listingId: l.id, message: 'Do you deliver 30 bags to Ogbomoso next week?', sharePhone: '0803 111 2222' });
  assert.equal(e.status, 201);
  const leads = await biz.c('GET', '/api/me/leads');
  assert.equal(leads.leads[0].source.label, 'Hybrid maize seed (SAMMAZ 52)');
  assert.equal(leads.leads[0].phone, '0803 111 2222');
  const thread = await biz.c('GET', `/api/conversations/${e.enquiry.conversationId}/messages`);
  assert.match(thread.messages[0].body, /Enquiry about/);
  assert.equal((await biz.c('PATCH', `/api/me/leads/${leads.leads[0].id}`, { status: 'contacted' })).ok, true);
  assert.equal((await biz2.c('PATCH', `/api/me/leads/${leads.leads[0].id}`, { status: 'won' })).status, 404, 'only the business sees its leads');
});

test('adverts: price shown up front, unverified can’t advertise, flags, review, live serving with measured metrics', async () => {
  const pk = await biz.c('GET', '/api/ads/packages');
  assert.ok(pk.packages.week.prices.feed > 0);
  assert.equal((await biz2.c('POST', '/api/me/ads', {})).status, 403, 'unverified business');
  const draft = {
    placement: 'feed', package: 'week', headline: 'Certified hybrid maize seed', body: 'NASC-certified SAMMAZ 52 seed. Order before planting season; delivery across Oyo and Ogun.',
    cta: 'enquire', targetTopic: 'crops', startsOn: today()
  };
  const ad = (await biz.c('POST', '/api/me/ads', draft)).ad;
  assert.equal(ad.priceNgn, pk.packages.week.prices.feed);
  assert.equal(ad.endsOn, inDays(6));
  const flagged = (await biz.c('POST', '/api/me/ads', { ...draft, headline: 'Guaranteed returns of 40% ROI', body: 'Invest in our maize farm and double your money in six months, no risk.' })).ad;
  assert.ok(flagged.flags.length >= 2, 'restricted claims flagged for the reviewer');

  const co = await biz.c('POST', `/api/me/ads/${ad.id}/checkout`);
  await pay(co.checkoutUrl);
  assert.equal((await biz.c('GET', '/api/me/ads')).ads.find((a) => a.id === ad.id).status, 'in_review');
  assert.equal((await anon('GET', '/api/ads/serve?placement=feed')).ads.length, 0, 'not served before approval');

  // A rejected advert is refunded in full automatically.
  const co2 = await biz.c('POST', `/api/me/ads/${flagged.id}/checkout`);
  await pay(co2.checkoutUrl);
  assert.equal((await admin('POST', `/api/admin/ads/${flagged.id}/review`, { decision: 'reject', note: 'Investment return claims aren’t allowed.' })).status, 'rejected');
  assert.equal(db.get("SELECT status FROM payments WHERE purpose='advert' AND subject_id=?", flagged.id).status, 'refunded');

  await admin('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'approve' });
  const served = await anon('GET', '/api/ads/serve?placement=feed&topic=crops');
  assert.equal(served.ads[0].id, ad.id);
  assert.equal(served.ads[0].label, 'Sponsored');
  // Impressions and clicks count once per viewer per day.
  await anon('POST', '/api/ads/impressions', { ids: [ad.id] });
  await anon('POST', '/api/ads/impressions', { ids: [ad.id] });
  await farmer.c('POST', '/api/ads/impressions', { ids: [ad.id] });
  await farmer.c('POST', `/api/ads/${ad.id}/click`);
  await farmer.c('POST', `/api/ads/${ad.id}/click`);
  await farmer.c('POST', '/api/enquiries', { businessId: biz.id, adId: ad.id, message: 'Price for 10 bags, delivered?' });
  const m = (await biz.c('GET', '/api/me/ads')).ads.find((a) => a.id === ad.id).metrics;
  assert.deepEqual([m.impressions, m.clicks, m.enquiries], [2, 1, 1]);
  assert.equal(m.ctrPct, 50);
  assert.equal(m.spendNgn, ad.priceNgn);

  // Once it has started, cancelling needs confirmation and isn't refunded.
  assert.equal((await biz.c('POST', `/api/me/ads/${ad.id}/status`, { action: 'cancel' })).status, 409);
  // Pause stops serving.
  await biz.c('POST', `/api/me/ads/${ad.id}/status`, { action: 'pause' });
  assert.equal((await anon('GET', '/api/ads/serve?placement=feed')).ads.length, 0);
  await biz.c('POST', `/api/me/ads/${ad.id}/status`, { action: 'resume' });
  // Reported → removed by moderators → suspended.
  const rep = await farmer.c('POST', '/api/reports', { targetType: 'ad', targetId: ad.id, reason: 'misinformation', details: 'Seed is not certified.' });
  const item = (await admin('GET', '/api/admin/reports')).reports.find((r) => r.id === rep.report.id);
  assert.match(item.targetPreview, /Advert:/);
  await admin('POST', `/api/admin/reports/${item.id}/resolve`, { action: 'remove_content', note: 'Certification claim not supported by evidence.' });
  assert.equal((await anon('GET', '/api/ads/serve?placement=feed')).ads.length, 0);
});

test('adverts cancelled before they start are refunded in full; ended campaigns are closed by the scheduler', async () => {
  const ad = (await biz.c('POST', '/api/me/ads', { placement: 'events', package: 'week', headline: 'Drip kits for dry season', body: 'Gravity drip kits for quarter-hectare plots, installed and tested.', cta: 'website', url: 'https://greenvalley.example/drip', startsOn: inDays(5) })).ad;
  await pay((await biz.c('POST', `/api/me/ads/${ad.id}/checkout`)).checkoutUrl);
  await admin('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'approve' });
  const r = await biz.c('POST', `/api/me/ads/${ad.id}/status`, { action: 'cancel' });
  assert.equal(r.refundedNgn, ad.priceNgn);
  const platform = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS n FROM ledger_entries WHERE source_type='advert' AND source_id=? AND account_id IS NULL AND entry_type IN ('sale','refund')", ad.id).n;
  assert.equal(platform, 0, 'platform income reversed');

  const old = (await biz.c('POST', '/api/me/ads', { placement: 'jobs', package: 'week', headline: 'Farm hands wanted?', body: 'We supply trained seasonal farm workers across Oyo State.', cta: 'enquire', startsOn: today() })).ad;
  db.run("UPDATE ad_campaigns SET status = 'approved', starts_on = ?, ends_on = ? WHERE id = ?", inDays(-10), inDays(-3), old.id);
  await app.tick();
  assert.equal(db.get('SELECT status FROM ad_campaigns WHERE id = ?', old.id).status, 'ended');
  assert.ok(db.get("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Your advert has ended'", biz.id));
});

test('event sponsorship: packages, request, host accepts, sponsor pays, host earns after the event, deliverables, cancellation refunds', async () => {
  const ev = (await host.c('POST', '/api/events', {
    title: 'Maize field day: seed and fertiliser choices', description: 'Hands-on session on seed selection and fertiliser timing for savanna maize.', topic: 'crops',
    durationMin: 90, startsAt: new Date(Date.now() + 10 * 86400000).toISOString()
  })).event;
  assert.equal((await biz.c('POST', `/api/events/${ev.id}/packages`, { name: 'Gold', priceNgn: 100000 })).status, 403, 'only the host');
  const pkg = (await host.c('POST', `/api/events/${ev.id}/packages`, {
    name: 'Gold sponsor', priceNgn: 100000, benefits: 'Logo on the event page and stage, two verbal mentions, a 5-minute product talk.',
    deliverables: ['Logo on event page', 'Two verbal mentions', '5-minute product talk'], speakingSlot: true, exclusive: true
  })).package;
  assert.equal(pkg.hostNetNgn, 85000);
  assert.equal((await biz2.c('POST', `/api/sponsorship-packages/${pkg.id}/request`, { displayName: 'Agro Two' })).status, 403, 'unverified business');
  const req = (await biz.c('POST', `/api/sponsorship-packages/${pkg.id}/request`, { displayName: 'Green Valley Inputs', link: 'https://greenvalley.example', message: 'We’d like to show our seed range.' })).sponsorship;
  assert.equal((await biz.c('POST', `/api/sponsorships/${req.id}/checkout`)).status, 400, 'must be accepted first');
  assert.equal((await biz.c('POST', `/api/sponsorships/${req.id}/logo`, png, { 'Content-Type': 'image/png' })).status, 201);
  await host.c('POST', `/api/sponsorships/${req.id}/decide`, { decision: 'accept' });
  await pay((await biz.c('POST', `/api/sponsorships/${req.id}/checkout`)).checkoutUrl);

  const pub = await anon('GET', `/api/events/${ev.id}/sponsorship`);
  assert.equal(pub.sponsors[0].name, 'Green Valley Inputs');
  assert.equal(pub.requests.length, 0, 'requests are host-only');
  assert.equal(pub.packages[0].available, 0, 'exclusive package taken');
  // Host earning: pending until the hold period after the event ends.
  const entries = db.all("SELECT * FROM ledger_entries WHERE source_type='sponsorship' AND source_id=? AND account_id=?", req.id, host.id);
  assert.equal(entries.reduce((s, e) => s + e.amount_ngn, 0), 85000);
  assert.ok(entries.every((e) => e.available_at > new Date(Date.now() + 10 * 86400000).toISOString()));

  const d = await host.c('POST', `/api/sponsorships/${req.id}/deliverables`, { index: 0, evidence: 'Logo live on the event page since 3 Nov.' });
  assert.equal(d.deliverables[0].done, true);
  assert.equal((await biz.c('POST', `/api/sponsorships/${req.id}/deliverables`, { index: 1, evidence: 'x' })).status, 403);

  // Cancelling the event refunds the sponsor and reverses the host's earning.
  await host.c('POST', `/api/events/${ev.id}/cancel`, { reason: 'Venue flooded after heavy rain.' });
  assert.equal(db.get('SELECT status FROM event_sponsorships WHERE id = ?', req.id).status, 'refunded');
  const net = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS n FROM ledger_entries WHERE source_type='sponsorship' AND source_id=? AND account_id=?", req.id, host.id).n;
  assert.equal(net, 0);
});

test('business teams: invite by verified email, role permissions, acting for the business, staff replies, removal', async () => {
  const kemi = await member('enthusiast', 'Kemi Sales');
  const tayo = await member('farmer', 'Tayo Marketing');
  const outsider = await member('farmer', 'Not On Team');
  const kemiEmail = db.get('SELECT email FROM users WHERE id = ?', kemi.id).email;
  const tayoEmail = db.get('SELECT email FROM users WHERE id = ?', tayo.id).email;
  const as = (id) => ({ 'X-Business-Id': id });

  // Only the owner/admins manage the team.
  assert.equal((await kemi.c('POST', '/api/business/team/invites', { email: 'x@y.ng', role: 'sales' }, as(biz.id))).status, 403);
  let team = await biz.c('POST', '/api/business/team/invites', { email: kemiEmail.toUpperCase(), role: 'sales' });
  assert.equal(team.invites.length, 1);
  await biz.c('POST', '/api/business/team/invites', { email: tayoEmail, role: 'marketing' });
  assert.ok(db.get("SELECT 1 FROM email_outbox WHERE to_email = ? AND subject LIKE '%invited you%'", kemiEmail.toLowerCase()), 'invite emailed');

  // The invite is visible only to the matching verified email.
  const mine = await kemi.c('GET', '/api/me/businesses');
  assert.equal(mine.invites.length, 1);
  assert.equal((await outsider.c('POST', `/api/business-invites/${mine.invites[0].id}/accept`)).status, 404);
  assert.equal((await kemi.c('POST', `/api/business-invites/${mine.invites[0].id}/accept`)).ok, true);
  const tInv = (await tayo.c('GET', '/api/me/businesses')).invites[0];
  await tayo.c('POST', `/api/business-invites/${tInv.id}/accept`);
  assert.deepEqual((await kemi.c('GET', '/api/me/businesses')).businesses.map((b) => [b.id, b.role]), [[biz.id, 'sales']]);

  // Without the header, staff act as themselves (and aren't businesses).
  assert.equal((await kemi.c('GET', '/api/me/leads')).status, 403);
  // Sales: leads yes; adverts, listings, profile and team no.
  const leads = await kemi.c('GET', '/api/me/leads', undefined, as(biz.id));
  assert.ok(leads.leads.length >= 1);
  assert.equal((await kemi.c('GET', '/api/me/ads', undefined, as(biz.id))).status, 403);
  assert.equal((await kemi.c('POST', '/api/me/listings', { title: 'x' }, as(biz.id))).status, 403);
  assert.equal((await kemi.c('PUT', '/api/me/business', {}, as(biz.id))).status, 403);
  const view = await kemi.c('GET', '/api/me/business', undefined, as(biz.id));
  assert.equal(view.profile.phone, undefined, 'private profile fields hidden from sales');
  assert.deepEqual(view.permissions, ['view', 'leads']);
  // An outsider can't act for the business at all.
  assert.equal((await outsider.c('GET', '/api/me/leads', undefined, as(biz.id))).status, 403);

  // Staff reply to a lead as the business; the enquirer sees the business, the owner sees who wrote it.
  const lead = leads.leads[0];
  assert.equal((await kemi.c('POST', `/api/me/leads/${lead.id}/reply`, { body: 'Yes, we deliver to Ogbomoso on Tuesdays.' }, as(biz.id))).status, 201);
  const thread = await kemi.c('GET', `/api/me/leads/${lead.id}/thread`, undefined, as(biz.id));
  assert.equal(thread.messages.at(-1).sentBy, 'Kemi Sales');
  const ownerView = await biz.c('GET', `/api/conversations/${lead.conversationId}/messages`);
  assert.equal(ownerView.messages.at(-1).sentBy, 'Kemi Sales');
  const enquirerView = await farmer.c('GET', `/api/conversations/${lead.conversationId}/messages`);
  assert.equal(enquirerView.messages.at(-1).sentBy, undefined);
  assert.equal(db.get('SELECT status FROM enquiries WHERE id = ?', lead.id).status === 'new', false);

  // Marketing creates an advert for the business; it belongs to the business and the audit log names Tayo.
  const ad = await tayo.c('POST', '/api/me/ads', { placement: 'feed', package: 'week', headline: 'Team-made advert test', body: 'Certified seed at all our depots, delivery across the South-West.', cta: 'enquire', startsOn: today() }, as(biz.id));
  assert.equal(ad.status, 201);
  assert.equal(db.get('SELECT business_id FROM ad_campaigns WHERE id = ?', ad.ad.id).business_id, biz.id);
  const co = await tayo.c('POST', `/api/me/ads/${ad.ad.id}/checkout`, undefined, as(biz.id));
  assert.equal(db.get("SELECT user_id FROM payments WHERE purpose = 'advert' AND subject_id = ?", ad.ad.id).user_id, biz.id, 'the payment is the business’s');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'ad.checkout_started' AND actor_id = ? AND target_id = ?", tayo.id, ad.ad.id));
  assert.ok(co.checkoutUrl);
  assert.equal((await tayo.c('GET', '/api/me/leads', undefined, as(biz.id))).status, 403, 'marketing can’t see leads');

  // Marketing can't add admins; nobody but the owner can.
  assert.equal((await tayo.c('POST', '/api/business/team/invites', { email: 'a@b.ng', role: 'admin' }, as(biz.id))).status, 403);
  // Owner promotes Tayo to admin; admin can manage sales but not remove the other admin... or themselves change roles.
  await biz.c('PATCH', `/api/business/team/${tayo.id}`, { role: 'admin' });
  const changed = await tayo.c('PATCH', `/api/business/team/${kemi.id}`, { role: 'marketing' }, as(biz.id));
  assert.equal(changed.members.find((m) => m.id === kemi.id).role, 'marketing', 'admins can change non-admin roles');
  assert.equal((await tayo.c('PATCH', `/api/business/team/${tayo.id}`, { role: 'sales' }, as(biz.id))).status, 403, 'admins can’t change admins, including themselves');
  assert.equal((await tayo.c('POST', '/api/business/team/invites', { email: 'c@d.ng', role: 'admin' }, as(biz.id))).status, 403, 'admins can’t add admins');
  // Removing a member ends their access immediately.
  team = await biz.c('DELETE', `/api/business/team/${kemi.id}`);
  assert.ok(!team.members.some((m) => m.id === kemi.id));
  assert.equal((await kemi.c('GET', '/api/me/business', undefined, as(biz.id))).status, 403);
  // Team actions are audited.
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'business_team.removed' AND target_id = ?", biz.id));
});
