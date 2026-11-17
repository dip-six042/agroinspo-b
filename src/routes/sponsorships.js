// Event sponsorship (PRD §24, §30). The host publishes packages; a verified business requests one;
// the host accepts; the business pays; the host records each deliverable with evidence.
// The fee is the host's earning (less commission), available a set number of days after the event.
import { newId, now } from '../security.js';
import { COMMISSION, AD_IMAGE_TYPES } from '../config.js';
import { saveUpload } from '../uploads.js';

const HOUR = 3600000;
const SPONSOR_CANCEL_HOURS = 72; // business can cancel a paid sponsorship for a full refund up to this long before the event

export function registerSponsorships(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, parseJson, requireActive, fulfil, ledger } = kit;

  const getEvent = (id) => {
    const e = db.get('SELECT * FROM events WHERE id = ?', id);
    if (!e) throw new HttpError(404, 'not_found', 'Event not found.');
    return e;
  };
  const eventEnd = (e) => new Date(new Date(e.starts_at).getTime() + e.duration_min * 60000).toISOString();
  const pkgView = (p, taken) => ({
    id: p.id, eventId: p.event_id, name: p.name, priceNgn: p.price_ngn, benefits: p.benefits, deliverables: parseJson(p.deliverables, []),
    speakingSlot: !!p.speaking_slot, exclusive: !!p.exclusive, slots: p.slots, cancellation: p.cancellation, active: !!p.active,
    available: Math.max(0, p.slots - taken), hostNetNgn: p.price_ngn - Math.round(p.price_ngn * COMMISSION.sponsorship)
  });
  const takenFor = (pkgId) => db.get("SELECT COUNT(*) AS n FROM event_sponsorships WHERE package_id = ? AND status IN ('accepted','confirmed','completed')", pkgId).n;
  const spView = (s, viewer) => {
    const p = db.get('SELECT * FROM sponsorship_packages WHERE id = ?', s.package_id);
    const e = db.get('SELECT id, title, starts_at, host_id, status FROM events WHERE id = ?', s.event_id);
    return {
      id: s.id, status: s.status, displayName: s.display_name, link: s.link, message: s.message, declineNote: s.decline_note,
      logoUrl: s.logo_file_id ? `/api/media/${s.logo_file_id}` : '', deliverables: parseJson(s.deliverables, []), createdAt: s.created_at,
      package: { id: p.id, name: p.name, priceNgn: p.price_ngn, cancellation: p.cancellation },
      event: { id: e.id, title: e.title, startsAt: e.starts_at, status: e.status },
      business: { id: s.business_id, name: kit.advertiserName(s.business_id) },
      role: viewer?.id === e.host_id ? 'host' : viewer?.id === s.business_id ? 'sponsor' : 'admin',
      canCancelWithRefund: s.status === 'confirmed' && new Date(e.starts_at).getTime() - Date.now() >= SPONSOR_CANCEL_HOURS * HOUR
    };
  };
  // Sponsor-side access is by the business or its team (role with sponsorship rights); host-side by the host.
  const getSp = (ctx, id) => {
    const s = db.get('SELECT * FROM event_sponsorships WHERE id = ?', id);
    const e = s && db.get('SELECT host_id FROM events WHERE id = ?', s.event_id);
    const acting = kit.maybeActingBusiness(ctx, 'sponsorships');
    const isSponsor = !!s && acting?.biz.id === s.business_id;
    if (!s || (!isSponsor && ctx.user.id !== e.host_id && ctx.user.role !== 'admin')) throw new HttpError(404, 'not_found', 'Sponsorship not found.');
    return { s, hostId: e.host_id, isSponsor, sponsorBiz: isSponsor ? acting.biz : null };
  };

  /* ---------- packages (host) ---------- */
  route('GET', '/api/events/:id/sponsorship', (ctx) => {
    const e = getEvent(ctx.params.id);
    const isHost = ctx.user && (ctx.user.id === e.host_id || ctx.user.role === 'admin');
    const acting = kit.maybeActingBusiness(ctx, 'sponsorships');
    const packages = db.all(`SELECT * FROM sponsorship_packages WHERE event_id = ? ${isHost ? '' : 'AND active = 1'} ORDER BY price_ngn DESC`, e.id).map((p) => pkgView(p, takenFor(p.id)));
    return {
      packages,
      // Shown publicly and clearly labelled on the event page.
      sponsors: db.all("SELECT * FROM event_sponsorships WHERE event_id = ? AND status IN ('confirmed','completed') ORDER BY created_at", e.id)
        .map((s) => ({ id: s.id, name: s.display_name, link: s.link, logoUrl: s.logo_file_id ? `/api/media/${s.logo_file_id}` : '', businessId: s.business_id, package: db.get('SELECT name FROM sponsorship_packages WHERE id = ?', s.package_id)?.name })),
      requests: isHost ? db.all('SELECT * FROM event_sponsorships WHERE event_id = ? ORDER BY created_at DESC', e.id).map((s) => spView(s, ctx.user)) : [],
      mine: acting ? db.all("SELECT * FROM event_sponsorships WHERE event_id = ? AND business_id = ? AND status NOT IN ('declined','cancelled','refunded')", e.id, acting.biz.id).map((s) => spView(s, acting.biz)) : [],
      canSponsor: !!acting && kit.canAdvertise(acting.biz) && acting.biz.id !== e.host_id && e.status === 'scheduled',
      actingAs: acting && acting.biz.id !== ctx.user.id ? kit.advertiserName(acting.biz.id) : '',
      isHost: !!isHost,
      commissionPct: Math.round(COMMISSION.sponsorship * 100)
    };
  });

  const parsePkg = (b) => {
    const price = Number(b.priceNgn);
    if (!Number.isInteger(price) || price < 1000 || price > 50_000_000) throw bad('Price must be at least ₦1,000, in whole naira.');
    const deliverables = (Array.isArray(b.deliverables) ? b.deliverables : String(b.deliverables || '').split('\n'))
      .map((d) => String(d).trim()).filter(Boolean).slice(0, 10).map((d) => d.slice(0, 160));
    if (!deliverables.length) throw bad('List at least one deliverable, e.g. “Logo on the event page”.');
    const slots = Number(b.slots || 1);
    if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw bad('Sponsor places must be between 1 and 20.');
    return {
      name: str(b.name, 'Package name', { min: 3, max: 60 }), price, deliverables,
      benefits: str(b.benefits, 'What the sponsor gets', { min: 20, max: 1500 }),
      speaking: b.speakingSlot ? 1 : 0, exclusive: b.exclusive ? 1 : 0, slots: b.exclusive ? 1 : slots,
      cancellation: str(b.cancellation, 'Cancellation terms', { max: 500 }) ||
        `Full refund if the event is cancelled, or if you cancel at least ${SPONSOR_CANCEL_HOURS} hours before it starts. No refund after that.`
    };
  };

  route('POST', '/api/events/:id/packages', (ctx) => {
    requireActive(ctx);
    const e = getEvent(ctx.params.id);
    if (e.host_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the host can offer sponsorship.');
    if (e.status !== 'scheduled') throw bad('Sponsorship can only be offered before the event.');
    const f = parsePkg(ctx.body);
    const id = newId();
    db.run(
      `INSERT INTO sponsorship_packages (id, event_id, name, price_ngn, benefits, deliverables, speaking_slot, exclusive, slots, cancellation, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, e.id, f.name, f.price, f.benefits, JSON.stringify(f.deliverables), f.speaking, f.exclusive, f.slots, f.cancellation, now()
    );
    return { status: 201, body: { package: pkgView(db.get('SELECT * FROM sponsorship_packages WHERE id = ?', id), 0) } };
  }, { auth: true });

  route('PATCH', '/api/sponsorship-packages/:id', (ctx) => {
    const p = db.get('SELECT * FROM sponsorship_packages WHERE id = ?', ctx.params.id);
    const e = p && getEvent(p.event_id);
    if (!p || e.host_id !== ctx.user.id) throw new HttpError(404, 'not_found', 'Package not found.');
    if (Object.keys(ctx.body).length === 1 && 'active' in ctx.body) {
      db.run('UPDATE sponsorship_packages SET active = ? WHERE id = ?', ctx.body.active ? 1 : 0, p.id);
    } else {
      // Terms are fixed once anyone has requested the package, so nobody pays for something that changed.
      if (db.get("SELECT 1 FROM event_sponsorships WHERE package_id = ? AND status NOT IN ('declined','cancelled')", p.id)) throw bad('Someone has already requested this package, so its terms can’t change. Offer a new package instead.');
      const f = parsePkg(ctx.body);
      db.run('UPDATE sponsorship_packages SET name=?, price_ngn=?, benefits=?, deliverables=?, speaking_slot=?, exclusive=?, slots=?, cancellation=? WHERE id=?',
        f.name, f.price, f.benefits, JSON.stringify(f.deliverables), f.speaking, f.exclusive, f.slots, f.cancellation, p.id);
    }
    return { package: pkgView(db.get('SELECT * FROM sponsorship_packages WHERE id = ?', p.id), takenFor(p.id)) };
  }, { auth: true });

  /* ---------- requests (business) ---------- */
  route('POST', '/api/sponsorship-packages/:id/request', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'sponsorships');
    if (!kit.canAdvertise(biz)) throw new HttpError(403, 'not_verified', 'Verify your business before sponsoring events.');
    const p = db.get('SELECT * FROM sponsorship_packages WHERE id = ? AND active = 1', ctx.params.id);
    if (!p) throw new HttpError(404, 'not_found', 'Package not available.');
    const e = getEvent(p.event_id);
    if (e.status !== 'scheduled' || new Date(e.starts_at).getTime() < Date.now() + 24 * HOUR) throw bad('Sponsorship requests close 24 hours before the event.');
    if (e.host_id === biz.id) throw bad('You can’t sponsor your own event.');
    if (takenFor(p.id) >= p.slots) throw bad('This package is fully taken.');
    if (db.get("SELECT 1 FROM sponsorship_packages sp JOIN event_sponsorships s ON s.package_id = sp.id WHERE sp.event_id = ? AND sp.exclusive = 1 AND s.status IN ('accepted','confirmed')", e.id))
      throw bad('This event already has an exclusive sponsor.');
    if (db.get("SELECT 1 FROM event_sponsorships WHERE event_id = ? AND business_id = ? AND status IN ('requested','accepted','confirmed')", e.id, biz.id))
      throw bad('You already have a sponsorship request for this event.');
    const link = str(ctx.body.link, 'Link', { max: 300 });
    if (link && !/^https:\/\/[^\s]+\.[^\s]+$/i.test(link)) throw bad('The link must be a full https:// address.');
    const id = newId();
    db.run(
      `INSERT INTO event_sponsorships (id, package_id, event_id, business_id, message, display_name, link, deliverables, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, p.id, e.id, biz.id, str(ctx.body.message, 'Message', { max: 1000 }), str(ctx.body.displayName, 'Name to show', { min: 2, max: 80 }) , link,
      JSON.stringify(parseJson(p.deliverables, []).map((item) => ({ item, done: false, evidence: '', doneAt: null }))), now(), now()
    );
    notify(e.host_id, 'sponsorship', 'New sponsorship request', `${kit.advertiserName(biz.id)} wants the “${p.name}” package for ${e.title}.`, `event:${e.id}`);
    audit(ctx, 'sponsorship.requested', 'sponsorship', id, { business: biz.id });
    return { status: 201, body: { sponsorship: spView(db.get('SELECT * FROM event_sponsorships WHERE id = ?', id), biz) } };
  }, { auth: true });

  route('POST', '/api/sponsorships/:id/logo', (ctx) => {
    const { s, isSponsor } = getSp(ctx, ctx.params.id);
    if (!isSponsor) throw new HttpError(403, 'forbidden', 'Only the sponsor can change the logo.');
    if (!['requested', 'accepted', 'confirmed'].includes(s.status)) throw bad('This sponsorship is closed.');
    const file = saveUpload(kit, ctx, 'sponsor_logo', s.business_id);
    db.run('UPDATE event_sponsorships SET logo_file_id = ?, updated_at = ? WHERE id = ?', file.id, now(), s.id);
    return { status: 201, body: { logoUrl: `/api/media/${file.id}` } };
  }, { auth: true, raw: { types: Object.keys(AD_IMAGE_TYPES), maxBytes: 1024 * 1024 } });

  route('POST', '/api/sponsorships/:id/decide', (ctx) => {
    const { s, hostId } = getSp(ctx, ctx.params.id);
    if (ctx.user.id !== hostId) throw new HttpError(403, 'forbidden', 'Only the host decides.');
    if (s.status !== 'requested') throw bad('This request has already been answered.');
    const decision = oneOf(ctx.body.decision, ['accept', 'decline'], 'Decision');
    const note = decision === 'decline' ? str(ctx.body.note, 'Reason', { min: 5, max: 500 }) : '';
    if (decision === 'accept') {
      const p = db.get('SELECT * FROM sponsorship_packages WHERE id = ?', s.package_id);
      if (takenFor(p.id) >= p.slots) throw bad('This package is already fully taken.');
    }
    db.run('UPDATE event_sponsorships SET status = ?, decline_note = ?, updated_at = ? WHERE id = ?', decision === 'accept' ? 'accepted' : 'declined', note, now(), s.id);
    const e = getEvent(s.event_id);
    kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', decision === 'accept' ? 'Sponsorship accepted: complete payment' : 'Sponsorship request declined',
      decision === 'accept' ? `${e.title}. Pay to confirm your place.` : `${e.title}: ${note}`, 'business:sponsorships');
    audit(ctx, `sponsorship.${decision}ed`, 'sponsorship', s.id, { note });
    return { status: decision === 'accept' ? 'accepted' : 'declined' };
  }, { auth: true });

  route('POST', '/api/sponsorships/:id/checkout', async (ctx) => {
    requireActive(ctx);
    const { s, isSponsor, sponsorBiz } = getSp(ctx, ctx.params.id);
    if (!isSponsor) throw new HttpError(403, 'forbidden', 'Only the sponsor can pay.');
    if (s.status !== 'accepted') throw bad('The host needs to accept your request before you pay.');
    const e = getEvent(s.event_id);
    if (e.status !== 'scheduled') throw bad('This event is no longer scheduled.');
    const p = db.get('SELECT * FROM sponsorship_packages WHERE id = ?', s.package_id);
    const payment = await kit.createPayment({
      user: sponsorBiz, purpose: 'sponsorship', subjectId: s.id, amountNgn: p.price_ngn,
      description: `Sponsorship “${p.name}”: ${e.title}`, returnPath: 'business:sponsorships'
    });
    db.run('UPDATE event_sponsorships SET payment_id = ?, updated_at = ? WHERE id = ?', payment.id, now(), s.id);
    return { checkoutUrl: payment.checkout_url, reference: payment.reference, amountNgn: p.price_ngn };
  }, { auth: true });

  fulfil.sponsorship = (payment) => {
    const s = db.get('SELECT * FROM event_sponsorships WHERE id = ?', payment.subject_id);
    if (!s) return;
    const e = getEvent(s.event_id);
    // The host's earning becomes available a hold period after the event ends.
    ledger.recordSale({ sellerId: e.host_id, purpose: 'sponsorship', sourceId: s.id, payment, availableFrom: eventEnd(e) });
    db.run("UPDATE event_sponsorships SET status = 'confirmed', payment_id = ?, updated_at = ? WHERE id = ?", payment.id, now(), s.id);
    notify(e.host_id, 'sponsorship', 'Sponsorship confirmed', `${s.display_name} paid for ${e.title}. Record each deliverable as you complete it.`, `event:${e.id}`);
    kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', 'Sponsorship confirmed', `You’re a sponsor of ${e.title}.`, 'business:sponsorships');
  };

  route('POST', '/api/sponsorships/:id/deliverables', (ctx) => {
    const { s, hostId } = getSp(ctx, ctx.params.id);
    if (ctx.user.id !== hostId) throw new HttpError(403, 'forbidden', 'Only the host records deliverables.');
    if (!['confirmed', 'completed'].includes(s.status)) throw bad('Deliverables are recorded once the sponsorship is paid.');
    const list = parseJson(s.deliverables, []);
    const i = Number(ctx.body.index);
    if (!Number.isInteger(i) || !list[i]) throw bad('Unknown deliverable.');
    const done = ctx.body.done !== false;
    const evidence = str(ctx.body.evidence, 'Evidence', { min: done ? 5 : 0, max: 500 });
    list[i] = { ...list[i], done, evidence: done ? evidence : '', doneAt: done ? now() : null };
    db.run('UPDATE event_sponsorships SET deliverables = ?, updated_at = ? WHERE id = ?', JSON.stringify(list), now(), s.id);
    if (done) kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', 'Sponsorship deliverable completed', `${list[i].item}: ${evidence}`, 'business:sponsorships');
    return { deliverables: list };
  }, { auth: true });

  // Sponsor cancels. Unpaid: free. Paid: full refund until 72 h before the event, then via support only.
  route('POST', '/api/sponsorships/:id/cancel', async (ctx) => {
    const { s, hostId, isSponsor } = getSp(ctx, ctx.params.id);
    const e = getEvent(s.event_id);
    const reason = str(ctx.body.reason, 'Reason', { max: 500 });
    if (['requested', 'accepted'].includes(s.status)) {
      if (!isSponsor && ctx.user.id !== hostId) throw new HttpError(403, 'forbidden', 'Not allowed.');
      db.run("UPDATE event_sponsorships SET status = 'cancelled', decline_note = ?, updated_at = ? WHERE id = ?", reason, now(), s.id);
      return { status: 'cancelled', refundedNgn: 0 };
    }
    if (s.status !== 'confirmed') throw bad('This sponsorship can’t be cancelled.');
    const byHost = ctx.user.id === hostId;
    if (!byHost && new Date(e.starts_at).getTime() - Date.now() < SPONSOR_CANCEL_HOURS * HOUR)
      throw bad(`Paid sponsorships can be cancelled for a refund up to ${SPONSOR_CANCEL_HOURS} hours before the event. Contact support.`);
    const p = await kit.refundPayment(s.payment_id, undefined, `Sponsorship cancelled${byHost ? ' by the host' : ''}: ${e.title}`, ctx.user);
    db.run("UPDATE event_sponsorships SET status = 'refunded', decline_note = ?, updated_at = ? WHERE id = ?", reason, now(), s.id);
    if (byHost) kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', 'Sponsorship cancelled', `${e.title}${reason ? `: ${reason}` : ''}. You’ve been refunded in full.`, 'business:sponsorships');
    else notify(hostId, 'sponsorship', 'Sponsorship cancelled', `${e.title}${reason ? `: ${reason}` : ''}. The sponsor was refunded.`, `event:${e.id}`);
    audit(ctx, 'sponsorship.cancelled', 'sponsorship', s.id, { byHost, refundedNgn: p.refunded_ngn });
    return { status: 'refunded', refundedNgn: p.refunded_ngn };
  }, { auth: true });

  route('GET', '/api/me/sponsorships', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'sponsorships');
    return {
    sponsorships: db.all('SELECT * FROM event_sponsorships WHERE business_id = ? ORDER BY created_at DESC', biz.id).map((s) => spView(s, biz)),
    canSponsor: kit.canAdvertise(biz),
    // Upcoming events with open packages, so businesses can find something to sponsor.
    open: db.all(
      `SELECT e.id, e.title, e.topic, e.starts_at, MIN(p.price_ngn) AS from_price, COUNT(p.id) AS packages
       FROM events e JOIN sponsorship_packages p ON p.event_id = e.id AND p.active = 1
       WHERE e.status = 'scheduled' AND e.starts_at > ? AND e.host_id != ? GROUP BY e.id ORDER BY e.starts_at LIMIT 20`,
      new Date(Date.now() + 24 * HOUR).toISOString(), biz.id
    ).map((e) => ({ id: e.id, title: e.title, topic: e.topic, startsAt: e.starts_at, fromPriceNgn: e.from_price, packages: e.packages }))
    };
  }, { auth: true });

  route('GET', '/api/admin/sponsorships', () => ({
    sponsorships: db.all("SELECT * FROM event_sponsorships WHERE status NOT IN ('declined','cancelled') ORDER BY created_at DESC LIMIT 200").map((s) => spView(s, null))
  }), { roles: ['admin'] });

  /* ---------- event cancelled → sponsors refunded ---------- */
  kit.onEventCancelled.push(async (e, reason, actor) => {
    let failed = 0;
    for (const s of db.all("SELECT * FROM event_sponsorships WHERE event_id = ? AND status IN ('requested','accepted','confirmed')", e.id)) {
      if (s.status !== 'confirmed') {
        db.run("UPDATE event_sponsorships SET status = 'cancelled', decline_note = ?, updated_at = ? WHERE id = ?", 'Event cancelled', now(), s.id);
        continue;
      }
      try {
        await kit.refundPayment(s.payment_id, undefined, `Event cancelled: ${e.title}`, actor);
        db.run("UPDATE event_sponsorships SET status = 'refunded', decline_note = ?, updated_at = ? WHERE id = ?", `Event cancelled: ${reason}`, now(), s.id);
      } catch {
        failed++;
        db.run("UPDATE payments SET status = 'under_review', updated_at = ? WHERE id = ?", now(), s.payment_id);
      }
      kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', 'Event cancelled', `${e.title}: ${reason} Your sponsorship is being refunded in full.`, 'business:sponsorships');
    }
    return failed;
  });

  /* ---------- scheduled: close out sponsorships after the event ---------- */
  kit.ticks.push(() => {
    for (const s of db.all(`SELECT s.* FROM event_sponsorships s JOIN events e ON e.id = s.event_id
      WHERE s.status = 'confirmed' AND (e.status = 'ended' OR datetime(e.starts_at, '+' || e.duration_min || ' minutes') < datetime(?))`, now())) {
      db.run("UPDATE event_sponsorships SET status = 'completed', updated_at = ? WHERE id = ?", now(), s.id);
      const left = parseJson(s.deliverables, []).filter((d) => !d.done).length;
      kit.notifyBusiness(s.business_id, 'sponsorships', 'sponsorship', 'Sponsored event finished',
        left ? `${left} deliverable(s) haven’t been marked done yet. If something wasn’t delivered, contact support within 7 days.` : 'All deliverables were recorded as done.', 'business:sponsorships');
    }
  });
}
