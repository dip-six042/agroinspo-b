// Advert campaigns (PRD §30): priced packages, checkout, human review with restricted-content
// flags, labelled serving, and measured (never estimated) impressions, clicks and enquiries.
import { createHash } from 'node:crypto';
import { newId, now } from '../security.js';
import { AD_PLACEMENTS, AD_PACKAGES, AD_RESTRICTED_PATTERNS, AD_IMAGE_TYPES } from '../config.js';
import { saveUpload } from '../uploads.js';

const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];
const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

export function registerAds(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, parseJson, requireActive, fulfil, cfg } = kit;
  const admins = () => db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  const flagsFor = (text) => AD_RESTRICTED_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.flag);

  // What the advertiser and admins see. "live"/"scheduled"/"ended" are derived from approval and dates.
  const displayStatus = (a) => {
    if (a.status !== 'approved') return a.status;
    const t = today();
    return t < a.starts_on ? 'scheduled' : t > a.ends_on ? 'ended' : 'live';
  };
  const metrics = (a) => {
    const counts = Object.fromEntries(db.all('SELECT kind, COUNT(*) AS n FROM ad_events WHERE ad_id = ? GROUP BY kind', a.id).map((r) => [r.kind, r.n]));
    const enquiries = db.get('SELECT COUNT(*) AS n FROM enquiries WHERE ad_id = ?', a.id).n;
    const pay = a.payment_id ? db.get('SELECT amount_ngn, refunded_ngn, status FROM payments WHERE id = ?', a.payment_id) : null;
    const impressions = counts.impression ?? 0;
    const clicks = counts.click ?? 0;
    return {
      impressions, clicks, enquiries,
      ctrPct: impressions ? Math.round((clicks / impressions) * 1000) / 10 : null,
      spendNgn: pay && ['successful', 'partially_refunded', 'refunded'].includes(pay.status) ? pay.amount_ngn - pay.refunded_ngn : 0,
      daily: db.all(
        `SELECT day, SUM(kind = 'impression') AS impressions, SUM(kind = 'click') AS clicks FROM ad_events WHERE ad_id = ? GROUP BY day ORDER BY day`, a.id
      )
    };
  };
  const adView = (a, { withMetrics = false, admin = false } = {}) => ({
    id: a.id, placement: a.placement, package: a.package, days: a.days, headline: a.headline, body: a.body,
    imageUrl: a.image_file_id ? `/api/media/${a.image_file_id}` : '', cta: a.cta, url: a.url, listingId: a.listing_id,
    targetTopic: a.target_topic, targetRegion: a.target_region, startsOn: a.starts_on, endsOn: a.ends_on, priceNgn: a.price_ngn,
    status: displayStatus(a), reviewNote: a.review_note, createdAt: a.created_at,
    advertiser: { id: a.business_id, name: kit.advertiserName(a.business_id), role: db.get('SELECT role FROM users WHERE id = ?', a.business_id)?.role ?? 'business' },
    ...(admin || withMetrics ? { flags: parseJson(a.flags, []) } : {}),
    ...(withMetrics ? { metrics: metrics(a) } : {})
  });
  const ownAd = (ctx, id) => {
    const { biz } = kit.actingBusiness(ctx, 'ads');
    const a = db.get('SELECT * FROM ad_campaigns WHERE id = ?', id);
    if (!a || a.business_id !== biz.id) throw new HttpError(404, 'not_found', 'Advert not found.');
    return a;
  };

  const parseAd = (ctx, bizId) => {
    const b = ctx.body;
    const placement = oneOf(b.placement, Object.keys(AD_PLACEMENTS), 'Placement');
    const pkg = oneOf(b.package, Object.keys(AD_PACKAGES), 'Package');
    const cta = oneOf(b.cta || 'enquire', ['enquire', 'website'], 'Button');
    const url = str(b.url, 'Website link', { max: 300 });
    if (cta === 'website' && !/^https:\/\/[^\s]+\.[^\s]+$/i.test(url)) throw bad('Add the full https:// link the button should open.');
    const listingId = b.listingId ? String(b.listingId) : null;
    if (listingId && !db.get("SELECT 1 FROM business_listings WHERE id = ? AND business_id = ? AND status = 'published'", listingId, bizId)) throw bad('Choose one of your published products or services.');
    const startsOn = String(b.startsOn || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || startsOn < today()) throw bad('Choose a start date from today onwards.');
    if (startsOn > addDays(today(), 90)) throw bad('Campaigns can start at most 90 days ahead.');
    const headline = str(b.headline, 'Headline', { min: 5, max: 80 });
    const body = str(b.body, 'Advert text', { min: 20, max: 300 });
    return {
      placement, package: pkg, days: AD_PACKAGES[pkg].days, price: AD_PACKAGES[pkg].prices[placement], cta, url: cta === 'website' ? url : '', listingId,
      startsOn, endsOn: addDays(startsOn, AD_PACKAGES[pkg].days - 1), headline, body,
      targetTopic: b.targetTopic ? oneOf(b.targetTopic, TOPICS, 'Target topic') : '',
      targetRegion: str(b.targetRegion, 'Target region', { max: 80 }),
      flags: JSON.stringify(flagsFor(`${headline} ${body}`))
    };
  };

  /* ---------- advertiser ---------- */
  route('GET', '/api/ads/packages', (ctx) => ({
    placements: AD_PLACEMENTS,
    packages: Object.fromEntries(Object.entries(AD_PACKAGES).map(([k, p]) => [k, { label: p.label, days: p.days, prices: p.prices }])),
    canAdvertise: kit.canAdvertise(kit.maybeActingBusiness(ctx, 'ads')?.biz),
    rules: [
      'Adverts are labelled “Sponsored” and checked by a person before they run, usually within one working day.',
      'Not allowed: investment or return promises, banned or unregistered agrochemicals and drugs, antibiotics for growth, financial schemes, and guaranteed-result claims.',
      'If we don’t approve an advert, you get a full refund. Cancel before it starts for a full refund; once it has started, it isn’t refundable.',
      'Reports show measured impressions, clicks and enquiries only. We don’t estimate reach or promise results.'
    ]
  }));

  route('POST', '/api/me/ads', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'ads');
    if (!kit.canAdvertise(biz)) throw new HttpError(403, 'not_verified', 'Verify your business (or your specialist credentials) before creating adverts.');
    const f = parseAd(ctx, biz.id);
    const id = newId();
    db.run(
      `INSERT INTO ad_campaigns (id, business_id, placement, package, days, headline, body, cta, listing_id, url, target_topic, target_region, starts_on, ends_on, price_ngn, flags, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, biz.id, f.placement, f.package, f.days, f.headline, f.body, f.cta, f.listingId, f.url, f.targetTopic, f.targetRegion, f.startsOn, f.endsOn, f.price, f.flags, now(), now()
    );
    return { status: 201, body: { ad: adView(db.get('SELECT * FROM ad_campaigns WHERE id = ?', id), { withMetrics: true }) } };
  }, { auth: true });

  route('PATCH', '/api/me/ads/:id', (ctx) => {
    const a = ownAd(ctx, ctx.params.id);
    if (!['draft', 'rejected'].includes(a.status)) throw bad('Only drafts and adverts that need changes can be edited.');
    const f = parseAd(ctx, a.business_id);
    db.run(
      `UPDATE ad_campaigns SET placement=?, package=?, days=?, headline=?, body=?, cta=?, listing_id=?, url=?, target_topic=?, target_region=?, starts_on=?, ends_on=?,
         price_ngn=?, flags=?, status='draft', updated_at=? WHERE id=?`,
      f.placement, f.package, f.days, f.headline, f.body, f.cta, f.listingId, f.url, f.targetTopic, f.targetRegion, f.startsOn, f.endsOn, f.price, f.flags, now(), a.id
    );
    return { ad: adView(db.get('SELECT * FROM ad_campaigns WHERE id = ?', a.id), { withMetrics: true }) };
  }, { auth: true });

  route('POST', '/api/me/ads/:id/image', (ctx) => {
    const a = ownAd(ctx, ctx.params.id);
    if (!['draft', 'rejected'].includes(a.status)) throw bad('The image can only be changed before checkout.');
    const file = saveUpload(kit, ctx, 'ad_image', a.business_id);
    db.run('UPDATE ad_campaigns SET image_file_id = ?, updated_at = ? WHERE id = ?', file.id, now(), a.id);
    return { status: 201, body: { imageUrl: `/api/media/${file.id}` } };
  }, { auth: true, raw: { types: Object.keys(AD_IMAGE_TYPES), maxBytes: 2 * 1024 * 1024 } });

  route('POST', '/api/me/ads/:id/duplicate', (ctx) => {
    const a = ownAd(ctx, ctx.params.id);
    const id = newId();
    const start = today() > a.starts_on ? addDays(today(), 1) : a.starts_on;
    db.run(
      `INSERT INTO ad_campaigns (id, business_id, placement, package, days, headline, body, image_file_id, cta, listing_id, url, target_topic, target_region, starts_on, ends_on, price_ngn, flags, created_at, updated_at)
       SELECT ?, business_id, placement, package, days, headline, body, image_file_id, cta, listing_id, url, target_topic, target_region, ?, ?, price_ngn, flags, ?, ? FROM ad_campaigns WHERE id = ?`,
      id, start, addDays(start, a.days - 1), now(), now(), a.id
    );
    // Prices may have changed since the original was bought.
    db.run('UPDATE ad_campaigns SET price_ngn = ? WHERE id = ?', AD_PACKAGES[a.package]?.prices[a.placement] ?? a.price_ngn, id);
    return { status: 201, body: { ad: adView(db.get('SELECT * FROM ad_campaigns WHERE id = ?', id), { withMetrics: true }) } };
  }, { auth: true });

  route('POST', '/api/me/ads/:id/checkout', async (ctx) => {
    const a = ownAd(ctx, ctx.params.id);
    const biz = db.get('SELECT * FROM users WHERE id = ?', a.business_id);
    if (!kit.canAdvertise(biz)) throw new HttpError(403, 'not_verified', 'Your business needs to be verified to advertise.');
    if (!['draft', 'rejected', 'payment_pending'].includes(a.status)) throw bad('This advert has already been paid for.');
    if (a.starts_on < today()) throw bad('The start date has passed. Choose a new one first.');
    const price = AD_PACKAGES[a.package].prices[a.placement];
    if (price !== a.price_ngn) db.run('UPDATE ad_campaigns SET price_ngn = ? WHERE id = ?', price, a.id);
    const payment = await kit.createPayment({
      user: biz, purpose: 'advert', subjectId: a.id, amountNgn: price,
      description: `Advert, ${AD_PLACEMENTS[a.placement].label} · ${AD_PACKAGES[a.package].label}: ${a.headline}`, returnPath: 'business:ads'
    });
    db.run("UPDATE ad_campaigns SET status = 'payment_pending', payment_id = ?, updated_at = ? WHERE id = ?", payment.id, now(), a.id);
    audit(ctx, 'ad.checkout_started', 'ad', a.id, { business: a.business_id, reference: payment.reference });
    return { checkoutUrl: payment.checkout_url, reference: payment.reference, amountNgn: price };
  }, { auth: true });

  fulfil.advert = (payment) => {
    kit.ledger.recordPlatformIncome({ purpose: 'advert', sourceId: payment.subject_id, payment });
    const a = db.get('SELECT * FROM ad_campaigns WHERE id = ?', payment.subject_id);
    if (!a) return;
    db.run("UPDATE ad_campaigns SET status = 'in_review', payment_id = ?, review_note = '', updated_at = ? WHERE id = ?", payment.id, now(), a.id);
    kit.notifyBusiness(a.business_id, 'ads', 'ad', 'Advert sent for review', `We’ll check “${a.headline}”, usually within one working day.`, 'business:ads');
    for (const ad of admins()) notify(ad.id, 'review', 'Advert waiting for review', a.headline, 'admin:ads');
  };
  fulfil['advert:failed'] = (payment) => {
    db.run("UPDATE ad_campaigns SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'payment_pending'", now(), payment.subject_id);
  };

  route('POST', '/api/me/ads/:id/status', async (ctx) => {
    const a = ownAd(ctx, ctx.params.id);
    const action = oneOf(ctx.body.action, ['pause', 'resume', 'cancel'], 'Action');
    if (action === 'pause') {
      if (a.status !== 'approved') throw bad('Only approved adverts can be paused.');
      db.run("UPDATE ad_campaigns SET status = 'paused', updated_at = ? WHERE id = ?", now(), a.id);
      return { status: 'paused', note: 'Paused. The end date doesn’t move, so paused days aren’t added back.' };
    }
    if (action === 'resume') {
      if (a.status !== 'paused') throw bad('This advert isn’t paused.');
      db.run("UPDATE ad_campaigns SET status = 'approved', updated_at = ? WHERE id = ?", now(), a.id);
      return { status: displayStatus({ ...a, status: 'approved' }) };
    }
    // Cancel: full refund until the campaign starts; none once it has run.
    if (['draft', 'payment_pending'].includes(a.status)) {
      db.run("UPDATE ad_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), a.id);
      return { status: 'cancelled', refundedNgn: 0 };
    }
    if (!['in_review', 'approved', 'paused'].includes(a.status)) throw bad('This advert can’t be cancelled.');
    const started = a.status !== 'in_review' && today() >= a.starts_on;
    if (started && ctx.body.acceptNoRefund !== true) throw new HttpError(409, 'no_refund', 'This advert has started running, so cancelling it isn’t refunded. Confirm to cancel anyway.');
    let refunded = 0;
    if (!started && a.payment_id) {
      const p = await kit.refundPayment(a.payment_id, undefined, `Advert cancelled before it ran: ${a.headline}`, ctx.user);
      refunded = p.refunded_ngn;
    }
    db.run("UPDATE ad_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), a.id);
    audit(ctx, 'ad.cancelled', 'ad', a.id, { refundedNgn: refunded });
    return { status: 'cancelled', refundedNgn: refunded };
  }, { auth: true });

  route('GET', '/api/me/ads', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'ads');
    return {
      ads: db.all("SELECT * FROM ad_campaigns WHERE business_id = ? AND status != 'cancelled' ORDER BY created_at DESC", biz.id).map((a) => adView(a, { withMetrics: true })),
      canAdvertise: kit.canAdvertise(biz)
    };
  }, { auth: true });

  /* ---------- serving & measurement ---------- */
  const LIVE = `a.status = 'approved' AND a.starts_on <= :today AND a.ends_on >= :today AND u.status = 'active'`;
  route('GET', '/api/ads/serve', (ctx) => {
    const placement = oneOf(ctx.query.get('placement') || 'feed', Object.keys(AD_PLACEMENTS), 'Placement');
    const topic = ctx.query.get('topic') || '';
    const n = Math.min(3, Math.max(1, Number(ctx.query.get('limit')) || 1));
    // Topic-matched adverts first, then untargeted ones; rotation is random within each group.
    const rows = db.all(
      `SELECT a.* FROM ad_campaigns a JOIN users u ON u.id = a.business_id
       WHERE ${LIVE} AND a.placement = :placement AND (a.target_topic = '' OR :topic = '' OR a.target_topic = :topic)
       ORDER BY (a.target_topic != '' AND a.target_topic = :topic) DESC, RANDOM() LIMIT :n`,
      { today: today(), placement, topic, n }
    );
    return { ads: rows.map((a) => ({ ...adView(a), label: 'Sponsored' })) };
  });

  const viewerKey = (ctx) => ctx.user ? ctx.user.id
    : 'anon:' + createHash('sha256').update(`${ctx.req.socket.remoteAddress}|${ctx.req.headers['user-agent'] || ''}|${cfg.sessionSecret || 'agro'}`).digest('hex').slice(0, 24);
  const record = (ctx, adId, kind) => {
    const live = db.get(`SELECT a.id FROM ad_campaigns a JOIN users u ON u.id = a.business_id WHERE a.id = :id AND ${LIVE}`, { id: adId, today: today() });
    if (!live) return false;
    db.run('INSERT OR IGNORE INTO ad_events (ad_id, kind, viewer_key, day, created_at) VALUES (?,?,?,?,?)', adId, kind, viewerKey(ctx), today(), now());
    return true;
  };

  // Called by the page when an advert is actually on screen.
  route('POST', '/api/ads/impressions', (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 5).map(String) : [];
    if (!kit.limit(`adimp:${viewerKey(ctx)}`, 300, 60 * 60_000)) return { ok: true };
    for (const id of ids) record(ctx, id, 'impression');
    return { ok: true };
  });

  route('POST', '/api/ads/:id/click', (ctx) => {
    const a = db.get('SELECT * FROM ad_campaigns WHERE id = ?', ctx.params.id);
    if (!a) throw new HttpError(404, 'not_found', 'Advert not found.');
    record(ctx, a.id, 'click');
    return { cta: a.cta, url: a.cta === 'website' ? a.url : '', businessId: a.business_id, listingId: a.listing_id };
  });

  /* ---------- admin ---------- */
  route('GET', '/api/admin/ads', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'in_review', ['in_review', 'approved', 'paused', 'rejected', 'suspended', 'ended'], 'Status');
    return {
      ads: db.all('SELECT * FROM ad_campaigns WHERE status = ? ORDER BY updated_at', status).map((a) => ({
        ...adView(a, { withMetrics: true, admin: true }),
        advertiserVerification: db.get('SELECT verification_scope FROM business_profiles WHERE user_id = ?', a.business_id)?.verification_scope ?? 'Specialist with checked credentials'
      }))
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/ads/:id/review', async (ctx) => {
    const a = db.get('SELECT * FROM ad_campaigns WHERE id = ?', ctx.params.id);
    if (!a) throw new HttpError(404, 'not_found', 'Advert not found.');
    const decision = oneOf(ctx.body.decision, ['approve', 'reject', 'suspend'], 'Decision');
    const note = str(ctx.body.note, 'Note', { min: decision === 'approve' ? 0 : 10, max: 1000 });
    if (decision !== 'suspend' && a.status !== 'in_review') throw bad('This advert isn’t waiting for review.');
    if (decision === 'suspend' && !['approved', 'paused'].includes(a.status)) throw bad('Only running or paused adverts can be suspended.');
    let refunded = 0;
    // A rejected advert never ran, so it's refunded in full. A suspension refunds what the reviewer decides.
    if (decision === 'reject' && a.payment_id) refunded = (await kit.refundPayment(a.payment_id, undefined, `Advert not approved: ${a.headline}`, ctx.user)).refunded_ngn;
    if (decision === 'suspend' && Number(ctx.body.refundNgn) > 0 && a.payment_id) {
      await kit.refundPayment(a.payment_id, Number(ctx.body.refundNgn), `Advert suspended: ${a.headline}`, ctx.user);
      refunded = Number(ctx.body.refundNgn);
    }
    const status = { approve: 'approved', reject: 'rejected', suspend: 'suspended' }[decision];
    db.run('UPDATE ad_campaigns SET status = ?, review_note = ?, updated_at = ? WHERE id = ?', status, note, now(), a.id);
    audit(ctx, `ad.${status}`, 'ad', a.id, { note, refundedNgn: refunded });
    const msg = {
      approve: ['Your advert is approved', today() >= a.starts_on ? `“${a.headline}” is now live.` : `“${a.headline}” goes live on ${a.starts_on}.`],
      reject: ['Your advert needs changes', `${note} You’ve been refunded in full. Edit the advert and check out again when it’s ready.`],
      suspend: ['Your advert was suspended', `${note}${refunded ? ` We’ve refunded ₦${refunded.toLocaleString('en-NG')}.` : ''} Contact support to appeal.`]
    }[decision];
    kit.notifyBusiness(a.business_id, 'ads', 'ad', msg[0], msg[1], 'business:ads');
    return { status };
  }, { roles: ['admin'] });

  /* ---------- scheduled ---------- */
  kit.ticks.push(() => {
    for (const a of db.all("SELECT * FROM ad_campaigns WHERE status IN ('approved','paused') AND ends_on < ?", today())) {
      db.run("UPDATE ad_campaigns SET status = 'ended', updated_at = ? WHERE id = ?", now(), a.id);
      const m = metrics(a);
      kit.notifyBusiness(a.business_id, 'ads', 'ad', 'Your advert has ended',
        `“${a.headline}”: ${m.impressions.toLocaleString('en-NG')} impressions, ${m.clicks} clicks, ${m.enquiries} enquiries. Run it again from Adverts.`, 'business:ads');
    }
  });
}
