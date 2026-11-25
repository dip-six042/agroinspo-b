// Specialist directory, services, availability, consultation bookings, calls and reviews (PRD §22.4, §27).
import { newId, now } from '../security.js';
import { CLIENT_FREE_CANCEL_HOURS, COMMISSION, SLOT_HOLD_MINUTES } from '../config.js';
import { COUNTRIES } from '../places.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];

export function registerConsultations(kit) {
  const { db, route, audit, notify, video, HttpError, bad, str, oneOf, parseJson, requireVerified, requireActive, fulfil, ledger } = kit;
  const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
  const when = (iso) => new Date(iso).toUTCString().slice(0, 22) + ' UTC';

  const requireSpecialist = (ctx) => {
    if (ctx.user.role !== 'specialist' && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only specialist accounts can offer consultations.');
  };

  /* ---------- directory ---------- */
  const SELECT_SPECIALIST = `
    SELECT u.id, u.name, u.title, u.location, u.country, u.bio, u.avatar_url, p.*,
      (SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.specialist_id = u.id AND r.status = 'published') AS rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.specialist_id = u.id AND r.status = 'published') AS review_count,
      (SELECT MIN(price_ngn) FROM consultation_services s WHERE s.specialist_id = u.id AND s.active = 1) AS from_price,
      (SELECT MIN(starts_at) FROM availability_slots a WHERE a.specialist_id = u.id AND a.status = 'open' AND a.starts_at > :soon) AS next_slot,
      (SELECT COUNT(*) FROM bookings b WHERE b.specialist_id = u.id AND b.status IN ('completed','no_show')) AS sessions
    FROM users u JOIN specialist_profiles p ON p.user_id = u.id
    WHERE u.role = 'specialist' AND u.status = 'active'`;

  const specialistView = (r) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    headline: r.headline,
    location: r.location,
    country: r.country || '',
    bio: r.bio,
    avatarUrl: r.avatar_url,
    specialties: parseJson(r.specialties, []),
    languages: parseJson(r.languages, []),
    serviceArea: r.service_area,
    experienceYears: r.experience_years,
    credentials: parseJson(r.credentials, []),
    credentialStatus: r.credential_status,
    credentialNote: r.credential_status === 'verified' ? r.credential_note : '',
    accepting: !!r.accepting,
    rating: r.rating,
    reviewCount: r.review_count,
    fromPriceNgn: r.from_price,
    nextSlot: r.next_slot,
    sessions: r.sessions
  });
  const soon = () => new Date(Date.now() + HOUR).toISOString();

  route('GET', '/api/specialists', (ctx) => {
    const where = [];
    const params = { soon: soon() };
    const q = ctx.query.get('q');
    if (q) (where.push('(u.name LIKE :q OR p.headline LIKE :q OR p.specialties LIKE :q OR u.location LIKE :q OR u.country LIKE :q OR p.service_area LIKE :q)'), (params.q = `%${q.slice(0, 60).replace(/[%_]/g, '')}%`));
    if (ctx.query.get('country')) {
      const country = oneOf(ctx.query.get('country'), COUNTRIES, 'Country');
      where.push('(u.country = :country OR u.location LIKE :countryLike)');
      params.country = country;
      params.countryLike = `%${country}%`;
    }
    if (ctx.query.get('topic'))
      (where.push('EXISTS (SELECT 1 FROM consultation_services s WHERE s.specialist_id = u.id AND s.active = 1 AND s.topic = :topic)'), (params.topic = oneOf(ctx.query.get('topic'), TOPICS, 'Topic')));
    if (ctx.query.get('verified') === '1') where.push("p.credential_status = 'verified'");
    const rows = db.all(`${SELECT_SPECIALIST} ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY (next_slot IS NULL), (p.credential_status = 'verified') DESC, rating DESC LIMIT 100`, params);
    return { specialists: rows.map(specialistView) };
  });

  const serviceView = (s) => ({ id: s.id, title: s.title, description: s.description, topic: s.topic, mode: s.mode, durationMin: s.duration_min, priceNgn: s.price_ngn, active: !!s.active });

  route('GET', '/api/specialists/:id', (ctx) => {
    const r = db.get(`${SELECT_SPECIALIST} AND u.id = :id`, { soon: soon(), id: ctx.params.id });
    if (!r) throw new HttpError(404, 'not_found', 'This specialist could not be found.');
    const services = db.all('SELECT * FROM consultation_services WHERE specialist_id = ? AND active = 1 ORDER BY price_ngn', r.id).map(serviceView);
    const slots = db.all(
      "SELECT id, starts_at, duration_min FROM availability_slots WHERE specialist_id = ? AND status = 'open' AND starts_at > ? AND starts_at < ? ORDER BY starts_at LIMIT 60",
      r.id, soon(), new Date(Date.now() + 30 * 24 * HOUR).toISOString()
    ).map((s) => ({ id: s.id, startsAt: s.starts_at, durationMin: s.duration_min }));
    const reviews = db.all(
      `SELECT rv.rating, rv.comment, rv.created_at, u.name FROM reviews rv JOIN users u ON u.id = rv.client_id
       WHERE rv.specialist_id = ? AND rv.status = 'published' ORDER BY rv.created_at DESC LIMIT 20`, r.id
    ).map((x) => ({ rating: x.rating, comment: x.comment, createdAt: x.created_at, by: x.name.split(' ')[0] }));
    return { specialist: specialistView(r), services, slots, reviews, commissionPct: Math.round(COMMISSION.consultation * 100) };
  });

  /* ---------- specialist self-service ---------- */
  route('GET', '/api/me/specialist', (ctx) => {
    requireSpecialist(ctx);
    const p = db.get('SELECT * FROM specialist_profiles WHERE user_id = ?', ctx.user.id);
    return {
      profile: p ? {
        headline: p.headline, specialties: parseJson(p.specialties, []), languages: parseJson(p.languages, []), serviceArea: p.service_area,
        experienceYears: p.experience_years, credentials: parseJson(p.credentials, []), credentialStatus: p.credential_status,
        credentialNote: p.credential_note, accepting: !!p.accepting
      } : null,
      services: db.all('SELECT * FROM consultation_services WHERE specialist_id = ? ORDER BY created_at', ctx.user.id).map(serviceView),
      slots: db.all("SELECT * FROM availability_slots WHERE specialist_id = ? AND starts_at > ? AND status != 'removed' ORDER BY starts_at LIMIT 200", ctx.user.id, now())
        .map((s) => ({ id: s.id, startsAt: s.starts_at, durationMin: s.duration_min, status: s.status === 'held' && s.held_until < now() ? 'open' : s.status }))
    };
  }, { auth: true });

  const strList = (v, name, max = 15, len = 80) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw bad(`${name}: up to ${max} items.`);
    return v.map((x) => str(String(x), name, { max: len })).filter(Boolean);
  };

  route('PUT', '/api/me/specialist', (ctx) => {
    requireSpecialist(ctx);
    requireActive(ctx);
    const b = ctx.body;
    const d = {
      headline: str(b.headline, 'Headline', { min: 5, max: 140 }),
      specialties: strList(b.specialties, 'Specialties', 12, 60),
      languages: strList(b.languages, 'Languages', 8, 30),
      area: str(b.serviceArea, 'Service area', { max: 160 }),
      years: Number(b.experienceYears || 0),
      credentials: strList(b.credentials, 'Credentials', 10, 160),
      accepting: b.accepting === false ? 0 : 1
    };
    if (!Number.isInteger(d.years) || d.years < 0 || d.years > 60) throw bad('Years of experience must be between 0 and 60.');
    const prev = db.get('SELECT * FROM specialist_profiles WHERE user_id = ?', ctx.user.id);
    // Changing the credential list means it has to be checked again.
    const credsChanged = prev && JSON.stringify(parseJson(prev.credentials, [])) !== JSON.stringify(d.credentials);
    const status = !prev ? 'unverified' : credsChanged && prev.credential_status === 'verified' ? 'unverified' : prev.credential_status;
    db.run(
      `INSERT INTO specialist_profiles (user_id, headline, specialties, languages, service_area, experience_years, credentials, credential_status, accepting, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline, specialties=excluded.specialties, languages=excluded.languages,
         service_area=excluded.service_area, experience_years=excluded.experience_years, credentials=excluded.credentials,
         credential_status=excluded.credential_status, accepting=excluded.accepting, updated_at=excluded.updated_at`,
      ctx.user.id, d.headline, JSON.stringify(d.specialties), JSON.stringify(d.languages.length ? d.languages : ['English']), d.area, d.years,
      JSON.stringify(d.credentials), status, d.accepting, now()
    );
    return { ok: true, credentialStatus: status };
  }, { auth: true });

  route('POST', '/api/me/specialist/request-verification', (ctx) => {
    requireSpecialist(ctx);
    const p = db.get('SELECT * FROM specialist_profiles WHERE user_id = ?', ctx.user.id);
    if (!p || !parseJson(p.credentials, []).length) throw bad('List at least one credential first.');
    if (p.credential_status === 'verified') return { credentialStatus: 'verified' };
    db.run("UPDATE specialist_profiles SET credential_status = 'pending', updated_at = ? WHERE user_id = ?", now(), ctx.user.id);
    for (const a of db.all("SELECT id FROM users WHERE role='admin' AND status='active'"))
      notify(a.id, 'review', 'Credentials to verify', ctx.user.name, 'admin:specialists');
    return { credentialStatus: 'pending' };
  }, { auth: true });

  const parseService = (b) => {
    const d = {
      title: str(b.title, 'Service title', { min: 4, max: 100 }),
      description: str(b.description, 'What’s included', { min: 20, max: 1500 }),
      topic: oneOf(b.topic, TOPICS, 'Topic'),
      mode: oneOf(b.mode || 'video', ['video', 'audio'], 'Call type'),
      duration: Number(b.durationMin),
      price: Number(b.priceNgn)
    };
    if (![15, 30, 45, 60, 90, 120].includes(d.duration)) throw bad('Duration must be 15, 30, 45, 60, 90 or 120 minutes.');
    if (!Number.isInteger(d.price) || d.price < 1000 || d.price > 2_000_000) throw bad('Price must be between ₦1,000 and ₦2,000,000.');
    return d;
  };

  route('POST', '/api/me/services', (ctx) => {
    requireSpecialist(ctx);
    requireVerified(ctx);
    if (!db.get('SELECT 1 FROM specialist_profiles WHERE user_id = ?', ctx.user.id)) throw bad('Complete your specialist profile first.');
    const d = parseService(ctx.body);
    const id = newId();
    db.run(
      'INSERT INTO consultation_services (id, specialist_id, title, description, topic, mode, duration_min, price_ngn, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, ctx.user.id, d.title, d.description, d.topic, d.mode, d.duration, d.price, now(), now()
    );
    return { status: 201, body: { service: serviceView(db.get('SELECT * FROM consultation_services WHERE id = ?', id)) } };
  }, { auth: true });

  route('PATCH', '/api/me/services/:id', (ctx) => {
    requireSpecialist(ctx);
    const s = db.get('SELECT * FROM consultation_services WHERE id = ? AND specialist_id = ?', ctx.params.id, ctx.user.id);
    if (!s) throw new HttpError(404, 'not_found', 'Service not found.');
    if (ctx.body.active !== undefined && Object.keys(ctx.body).length === 1) {
      db.run('UPDATE consultation_services SET active = ?, updated_at = ? WHERE id = ?', ctx.body.active ? 1 : 0, now(), s.id);
    } else {
      const d = parseService(ctx.body);
      // Price changes never affect bookings already paid for: bookings keep their own price.
      db.run('UPDATE consultation_services SET title=?, description=?, topic=?, mode=?, duration_min=?, price_ngn=?, updated_at=? WHERE id=?',
        d.title, d.description, d.topic, d.mode, d.duration, d.price, now(), s.id);
    }
    return { service: serviceView(db.get('SELECT * FROM consultation_services WHERE id = ?', s.id)) };
  }, { auth: true });

  // Add many slots at once: one date, several start times.
  route('POST', '/api/me/slots', (ctx) => {
    requireSpecialist(ctx);
    requireActive(ctx);
    const starts = Array.isArray(ctx.body.startsAt) ? ctx.body.startsAt : [];
    const duration = Number(ctx.body.durationMin || 60);
    if (![30, 45, 60, 90, 120].includes(duration)) throw bad('Slot length must be 30, 45, 60, 90 or 120 minutes.');
    if (!starts.length || starts.length > 40) throw bad('Add between 1 and 40 slots at a time.');
    let added = 0;
    for (const raw of starts) {
      const t = new Date(String(raw));
      if (Number.isNaN(t.getTime())) throw bad('One of the times is invalid.');
      if (t.getTime() < Date.now() + HOUR) continue; // skip times too soon to book
      if (t.getTime() > Date.now() + 90 * 24 * HOUR) throw bad('Slots can be at most 90 days ahead.');
      const iso = t.toISOString();
      const overlap = db.get(
        `SELECT 1 FROM availability_slots WHERE specialist_id = ? AND status != 'removed'
         AND starts_at < ? AND datetime(starts_at, '+' || duration_min || ' minutes') > datetime(?)`,
        ctx.user.id, new Date(t.getTime() + duration * MIN).toISOString(), iso
      );
      if (overlap) continue;
      db.run('INSERT OR IGNORE INTO availability_slots (id, specialist_id, starts_at, duration_min, created_at) VALUES (?,?,?,?,?)', newId(), ctx.user.id, iso, duration, now());
      added++;
    }
    return { added };
  }, { auth: true });

  route('DELETE', '/api/me/slots/:id', (ctx) => {
    const s = db.get('SELECT * FROM availability_slots WHERE id = ? AND specialist_id = ?', ctx.params.id, ctx.user.id);
    if (!s) throw new HttpError(404, 'not_found', 'Slot not found.');
    if (s.status === 'booked' || (s.status === 'held' && s.held_until > now())) throw bad('This slot has a booking. Decline or reschedule the booking instead.');
    db.run("UPDATE availability_slots SET status = 'removed' WHERE id = ?", s.id);
    return { ok: true };
  }, { auth: true });

  /* ---------- bookings ---------- */
  const SELECT_BOOKING = `
    SELECT b.*, s.title AS service_title, sp.name AS specialist_name, sp.title AS specialist_title, c.name AS client_name, c.title AS client_title,
      p.reference AS payment_reference, p.status AS payment_status, p.refunded_ngn,
      (SELECT id FROM reviews r WHERE r.booking_id = b.id) AS review_id
    FROM bookings b JOIN consultation_services s ON s.id = b.service_id
    JOIN users sp ON sp.id = b.specialist_id JOIN users c ON c.id = b.client_id
    LEFT JOIN payments p ON p.id = b.payment_id`;

  const bookingView = (b, viewer) => {
    const start = new Date(b.starts_at).getTime();
    const end = start + b.duration_min * MIN;
    const isSpecialist = viewer.id === b.specialist_id;
    const hoursAhead = (start - Date.now()) / HOUR;
    return {
      id: b.id,
      serviceTitle: b.service_title,
      startsAt: b.starts_at,
      endsAt: new Date(end).toISOString(),
      durationMin: b.duration_min,
      mode: b.mode,
      objective: b.objective,
      status: b.status,
      priceNgn: b.price_ngn,
      ...(isSpecialist || viewer.role === 'admin' ? { commissionNgn: b.commission_ngn, netNgn: b.price_ngn - b.commission_ngn } : {}),
      specialist: { id: b.specialist_id, name: b.specialist_name, title: b.specialist_title },
      client: { id: b.client_id, name: b.client_name, title: b.client_title },
      notes: b.specialist_notes,
      payment: b.payment_reference ? { reference: b.payment_reference, status: b.payment_status, refundedNgn: b.refunded_ngn } : null,
      rescheduled: !!b.rescheduled,
      reviewed: !!b.review_id,
      cancelReason: b.cancel_reason,
      cancelledBy: b.cancelled_by ? (b.cancelled_by === b.specialist_id ? 'specialist' : b.cancelled_by === b.client_id ? 'client' : 'admin') : null,
      role: isSpecialist ? 'specialist' : 'client',
      canJoin: ['confirmed', 'in_progress'].includes(b.status) && Date.now() >= start - 10 * MIN && Date.now() <= end + 30 * MIN,
      freeCancel: !isSpecialist && (!!b.rescheduled || hoursAhead >= CLIENT_FREE_CANCEL_HOURS),
      canReview: !isSpecialist && ['completed', 'no_show'].includes(b.status) && !b.review_id && b.status === 'completed',
      canDispute: !isSpecialist && ['completed', 'no_show'].includes(b.status) && Date.now() - (b.completed_at ? new Date(b.completed_at).getTime() : end) < 3 * 24 * HOUR
    };
  };

  function getBooking(ctx, id) {
    const b = db.get(`${SELECT_BOOKING} WHERE b.id = ?`, id);
    if (!b || (b.client_id !== ctx.user.id && b.specialist_id !== ctx.user.id && ctx.user.role !== 'admin'))
      throw new HttpError(404, 'not_found', 'Booking not found.');
    return b;
  }

  route('POST', '/api/bookings', async (ctx) => {
    requireVerified(ctx);
    const service = db.get('SELECT * FROM consultation_services WHERE id = ? AND active = 1', String(ctx.body.serviceId || ''));
    if (!service) throw bad('This service isn’t available any more.');
    if (service.specialist_id === ctx.user.id) throw bad('You can’t book yourself.');
    const profile = db.get("SELECT p.accepting FROM specialist_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.status = 'active'", service.specialist_id);
    if (!profile?.accepting) throw bad('This specialist isn’t taking bookings right now.');
    const objective = str(ctx.body.objective, 'What you need help with', { min: 20, max: 2000 });
    const blocked = db.get("SELECT 1 FROM user_blocks WHERE ((user_id = ? AND target_user_id = ?) OR (user_id = ? AND target_user_id = ?)) AND kind = 'block'",
      service.specialist_id, ctx.user.id, ctx.user.id, service.specialist_id);
    if (blocked) throw new HttpError(403, 'forbidden', 'You can’t book this specialist.');

    // Claim the slot atomically: open, or held by an expired checkout.
    const id = newId();
    const slot = db.tx(() => {
      const s = db.get('SELECT * FROM availability_slots WHERE id = ? AND specialist_id = ?', String(ctx.body.slotId || ''), service.specialist_id);
      const free = s && (s.status === 'open' || (s.status === 'held' && s.held_until < now()));
      if (!free) throw new HttpError(409, 'slot_taken', 'That time has just been taken. Choose another.');
      if (new Date(s.starts_at).getTime() < Date.now() + HOUR) throw bad('Choose a time at least an hour from now.');
      if (s.duration_min < service.duration_min) throw bad(`This service needs a ${service.duration_min}-minute slot.`);
      db.run("UPDATE availability_slots SET status = 'held', held_until = ? WHERE id = ?", new Date(Date.now() + SLOT_HOLD_MINUTES * MIN).toISOString(), s.id);
      const commission = Math.round(service.price_ngn * COMMISSION.consultation);
      db.run(
        `INSERT INTO bookings (id, service_id, specialist_id, client_id, slot_id, starts_at, duration_min, mode, objective, price_ngn, commission_ngn, room_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, service.id, service.specialist_id, ctx.user.id, s.id, s.starts_at, service.duration_min, service.mode, objective,
        service.price_ngn, commission, `bk_${id.replace(/-/g, '').slice(0, 20)}`, now(), now()
      );
      return s;
    });
    const sp = db.get('SELECT name FROM users WHERE id = ?', service.specialist_id);
    let payment;
    try {
      payment = await kit.createPayment({
        user: ctx.user, purpose: 'consultation', subjectId: id, amountNgn: service.price_ngn,
        description: `${service.title} with ${sp.name}, ${when(slot.starts_at)}`, returnPath: `consultations:${id}`
      });
    } catch (err) {
      db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = 'Payment could not start', updated_at = ? WHERE id = ?", now(), id);
      db.run("UPDATE availability_slots SET status = 'open', held_until = NULL WHERE id = ?", slot.id);
      throw err;
    }
    db.run('UPDATE bookings SET payment_id = ? WHERE id = ?', payment.id, id);
    return { status: 201, body: { bookingId: id, checkoutUrl: payment.checkout_url, reference: payment.reference } };
  }, { auth: true });

  fulfil.consultation = (payment) => {
    const b = db.get('SELECT * FROM bookings WHERE id = ?', payment.subject_id);
    if (!b) return;
    if (b.status !== 'payment_pending') {
      // Paid after the hold lapsed and the booking was released: refund automatically.
      kit.ticksLater = kit.ticksLater || [];
      kit.ticksLater.push(() => kit.refundPayment(payment.id, undefined, 'Booking time no longer available', null).catch(() => {}));
      return;
    }
    db.run("UPDATE bookings SET status = 'confirmed', updated_at = ? WHERE id = ?", now(), b.id);
    db.run("UPDATE availability_slots SET status = 'booked', held_until = NULL WHERE id = ?", b.slot_id);
    ledger.recordSale({ sellerId: b.specialist_id, purpose: 'consultation', sourceId: b.id, payment,
      availableFrom: new Date(new Date(b.starts_at).getTime() + b.duration_min * MIN).toISOString() });
    const client = db.get('SELECT name FROM users WHERE id = ?', b.client_id);
    notify(b.specialist_id, 'booking', 'New consultation booked', `${client.name} · ${when(b.starts_at)}`, `booking:${b.id}`);
    notify(b.client_id, 'booking', 'Consultation confirmed', `${when(b.starts_at)}. Join from My consultations 10 minutes before.`, `booking:${b.id}`);
  };
  fulfil['consultation:failed'] = (payment) => {
    const b = db.get('SELECT * FROM bookings WHERE id = ?', payment.subject_id);
    if (b?.status !== 'payment_pending') return;
    db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = 'Payment failed', updated_at = ? WHERE id = ?", now(), b.id);
    db.run("UPDATE availability_slots SET status = 'open', held_until = NULL WHERE id = ? AND status = 'held'", b.slot_id);
  };

  route('GET', '/api/me/bookings', (ctx) => {
    const as = ctx.query.get('as') === 'specialist' ? 'specialist' : 'client';
    const rows = db.all(
      `${SELECT_BOOKING} WHERE b.${as === 'specialist' ? 'specialist_id' : 'client_id'} = ? AND NOT (b.status = 'cancelled' AND b.payment_id IS NULL)
       ORDER BY b.starts_at DESC LIMIT 200`,
      ctx.user.id
    );
    return { bookings: rows.filter((b) => !(b.status === 'payment_pending' && as === 'specialist')).map((b) => bookingView(b, ctx.user)) };
  }, { auth: true });

  route('GET', '/api/bookings/:id', (ctx) => ({ booking: bookingView(getBooking(ctx, ctx.params.id), ctx.user) }), { auth: true });

  /** Cancels a booking and applies the refund rules. Specialist or admin cancellations always refund in full. */
  async function cancelBooking(ctx, b, reason, by) {
    const isClient = by === 'client';
    const hoursAhead = (new Date(b.starts_at).getTime() - Date.now()) / HOUR;
    const refund = !isClient || b.rescheduled || hoursAhead >= CLIENT_FREE_CANCEL_HOURS;
    db.tx(() => {
      db.run("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?", ctx.user.id, reason, now(), b.id);
      if (new Date(b.starts_at).getTime() > Date.now() + HOUR) db.run("UPDATE availability_slots SET status = 'open', held_until = NULL WHERE id = ?", b.slot_id);
      else db.run("UPDATE availability_slots SET status = 'removed' WHERE id = ?", b.slot_id);
      audit(ctx, 'booking.cancelled', 'booking', b.id, { by, reason, refund });
    });
    let refunded = 0;
    if (b.payment_id && refund) {
      const p = await kit.refundPayment(b.payment_id, undefined, `Consultation cancelled by ${by}`, ctx.user);
      refunded = p.refunded_ngn;
      db.run("UPDATE bookings SET status = 'refunded', updated_at = ? WHERE id = ?", now(), b.id);
    }
    const other = isClient ? b.specialist_id : b.client_id;
    notify(other, 'booking', 'Consultation cancelled', `${when(b.starts_at)}${reason ? ` · ${reason}` : ''}${!isClient && b.payment_id ? ' You’ve been refunded in full.' : ''}`, `booking:${b.id}`);
    return { refundedNgn: refunded };
  }

  route('POST', '/api/bookings/:id/cancel', async (ctx) => {
    const b = getBooking(ctx, ctx.params.id);
    if (!['payment_pending', 'confirmed'].includes(b.status)) throw bad('This booking can’t be cancelled.');
    if (new Date(b.starts_at).getTime() < Date.now()) throw bad('This consultation has already started. Raise a dispute from the booking instead.');
    const by = ctx.user.id === b.specialist_id ? 'specialist' : ctx.user.id === b.client_id ? 'client' : 'admin';
    const reason = str(ctx.body.reason, 'Reason', { min: by === 'client' ? 0 : 5, max: 500 });
    if (b.status === 'payment_pending') {
      db.run("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, updated_at = ? WHERE id = ?", ctx.user.id, now(), b.id);
      db.run("UPDATE availability_slots SET status = 'open', held_until = NULL WHERE id = ?", b.slot_id);
      return { refundedNgn: 0 };
    }
    if (by === 'client' && !b.rescheduled && (new Date(b.starts_at).getTime() - Date.now()) / HOUR < CLIENT_FREE_CANCEL_HOURS && ctx.body.acceptNoRefund !== true)
      throw new HttpError(409, 'no_refund', `Cancelling less than ${CLIENT_FREE_CANCEL_HOURS} hours before the session isn’t refunded. Confirm to cancel anyway.`);
    return cancelBooking(ctx, b, reason, by);
  }, { auth: true });

  route('POST', '/api/bookings/:id/reschedule', (ctx) => {
    const b = getBooking(ctx, ctx.params.id);
    if (b.specialist_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the specialist can move a booking.');
    if (b.status !== 'confirmed') throw bad('Only confirmed bookings can be moved.');
    const reason = str(ctx.body.reason, 'Reason', { min: 5, max: 300 });
    db.tx(() => {
      const s = db.get("SELECT * FROM availability_slots WHERE id = ? AND specialist_id = ? AND (status = 'open' OR (status = 'held' AND held_until < ?))", String(ctx.body.slotId || ''), ctx.user.id, now());
      if (!s) throw new HttpError(409, 'slot_taken', 'Choose one of your open slots.');
      if (s.duration_min < b.duration_min) throw bad(`This booking needs a ${b.duration_min}-minute slot.`);
      if (new Date(s.starts_at).getTime() < Date.now() + HOUR) throw bad('Choose a time at least an hour from now.');
      db.run("UPDATE availability_slots SET status = 'open' WHERE id = ?", b.slot_id);
      db.run("UPDATE availability_slots SET status = 'booked', held_until = NULL WHERE id = ?", s.id);
      db.run('UPDATE bookings SET slot_id = ?, starts_at = ?, rescheduled = 1, reminded = 0, updated_at = ? WHERE id = ?', s.id, s.starts_at, now(), b.id);
      notify(b.client_id, 'booking', 'Your consultation was moved', `New time: ${when(s.starts_at)}. ${reason} If it doesn’t suit you, cancel for a full refund.`, `booking:${b.id}`);
      audit(ctx, 'booking.rescheduled', 'booking', b.id, { from: b.starts_at, to: s.starts_at, reason });
    });
    return { booking: bookingView(getBooking(ctx, b.id), ctx.user) };
  }, { auth: true });

  route('POST', '/api/bookings/:id/join', async (ctx) => {
    requireActive(ctx);
    const b = getBooking(ctx, ctx.params.id);
    if (ctx.user.id !== b.client_id && ctx.user.id !== b.specialist_id) throw new HttpError(403, 'forbidden', 'Only the two participants can join.');
    const v = bookingView(b, ctx.user);
    if (!v.canJoin) throw bad('The room opens 10 minutes before the start time.');
    const col = ctx.user.id === b.specialist_id ? 'specialist_joined_at' : 'client_joined_at';
    db.run(`UPDATE bookings SET ${col} = COALESCE(${col}, ?), status = CASE WHEN status = 'confirmed' THEN 'in_progress' ELSE status END,
      started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`, now(), now(), now(), b.id);
    const token = await video.joinToken({ roomId: b.room_id, userId: ctx.user.id, role: 'host' });
    return { video: token, booking: bookingView(getBooking(ctx, b.id), ctx.user) };
  }, { auth: true });

  route('PATCH', '/api/bookings/:id/notes', (ctx) => {
    const b = getBooking(ctx, ctx.params.id);
    if (b.specialist_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the specialist writes session notes.');
    const notes = str(ctx.body.notes, 'Notes', { max: 5000 });
    db.run('UPDATE bookings SET specialist_notes = ?, updated_at = ? WHERE id = ?', notes, now(), b.id);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/bookings/:id/complete', (ctx) => {
    const b = getBooking(ctx, ctx.params.id);
    if (b.specialist_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only the specialist can complete a session.');
    if (!['confirmed', 'in_progress'].includes(b.status)) throw bad('This booking can’t be completed.');
    if (Date.now() < new Date(b.starts_at).getTime()) throw bad('You can mark the session complete once it has started.');
    const noShow = ctx.body.clientNoShow === true;
    if (noShow && Date.now() < new Date(b.starts_at).getTime() + 15 * MIN) throw bad('Wait at least 15 minutes before marking a no-show.');
    if (noShow && b.client_joined_at) throw bad('The client joined this session, so it can’t be a no-show.');
    db.run('UPDATE bookings SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', noShow ? 'no_show' : 'completed', now(), now(), b.id);
    notify(b.client_id, 'booking', noShow ? 'Marked as missed' : 'How was your consultation?',
      noShow ? `The specialist recorded that you didn’t join. If that’s wrong, raise a dispute within 3 days.` : 'Leave a rating to help other farmers choose.', `booking:${b.id}`);
    audit(ctx, noShow ? 'booking.no_show' : 'booking.completed', 'booking', b.id);
    return { status: noShow ? 'no_show' : 'completed' };
  }, { auth: true });

  route('POST', '/api/bookings/:id/review', (ctx) => {
    const b = getBooking(ctx, ctx.params.id);
    if (b.client_id !== ctx.user.id) throw new HttpError(403, 'forbidden', 'Only the client can review a session.');
    if (b.status !== 'completed') throw bad('You can review a consultation once it’s complete.');
    if (b.review_id) throw new HttpError(409, 'already_reviewed', 'You’ve already reviewed this consultation.');
    const rating = Number(ctx.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Rating must be 1 to 5 stars.');
    const comment = str(ctx.body.comment, 'Comment', { max: 1000 });
    db.run('INSERT INTO reviews (id, booking_id, client_id, specialist_id, rating, comment, created_at) VALUES (?,?,?,?,?,?,?)',
      newId(), b.id, ctx.user.id, b.specialist_id, rating, comment, now());
    notify(b.specialist_id, 'review', `New ${rating}-star review`, comment.slice(0, 120), `user:${b.specialist_id}`);
    return { status: 201, body: { ok: true } };
  }, { auth: true });

  /* ---------- admin ---------- */
  route('GET', '/api/admin/specialists', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'pending', ['pending', 'verified', 'unverified'], 'Status');
    return {
      specialists: db.all(`${SELECT_SPECIALIST} AND p.credential_status = :status ORDER BY p.updated_at`, { soon: soon(), status }).map(specialistView)
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/specialists/:id/credentials', (ctx) => {
    const decision = oneOf(ctx.body.decision, ['verified', 'unverified'], 'Decision');
    const note = str(ctx.body.note, 'What was checked', { min: 10, max: 500 });
    const p = db.get('SELECT * FROM specialist_profiles WHERE user_id = ?', ctx.params.id);
    if (!p) throw new HttpError(404, 'not_found', 'Specialist not found.');
    const stamped = decision === 'verified' ? `${note} Checked by Agro Inspo on ${new Date().toISOString().slice(0, 10)}.` : note;
    db.run('UPDATE specialist_profiles SET credential_status = ?, credential_note = ?, updated_at = ? WHERE user_id = ?', decision, stamped, now(), p.user_id);
    notify(p.user_id, 'review', decision === 'verified' ? 'Credentials verified' : 'Credentials not verified', note, 'consultations:profile');
    audit(ctx, `specialist.credentials_${decision}`, 'user', p.user_id, { note });
    return { ok: true };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/reviews/:id/hide', (ctx) => {
    const reason = str(ctx.body.reason, 'Reason', { min: 5, max: 300 });
    db.run("UPDATE reviews SET status = 'hidden' WHERE id = ?", ctx.params.id);
    audit(ctx, 'review.hidden', 'review', ctx.params.id, { reason });
    return { ok: true };
  }, { roles: ['admin'] });

  /* ---------- scheduled ---------- */
  kit.ticks.push(async () => {
    // Release slots whose checkout was abandoned.
    for (const b of db.all("SELECT b.* FROM bookings b JOIN availability_slots s ON s.id = b.slot_id WHERE b.status = 'payment_pending' AND s.status = 'held' AND s.held_until < ?", now())) {
      db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = 'Checkout not completed in time', updated_at = ? WHERE id = ?", now(), b.id);
      db.run("UPDATE availability_slots SET status = 'open', held_until = NULL WHERE id = ?", b.slot_id);
    }
    // Reminders an hour before.
    for (const b of db.all("SELECT * FROM bookings WHERE status = 'confirmed' AND reminded = 0 AND starts_at > ? AND starts_at <= ?", now(), new Date(Date.now() + HOUR).toISOString())) {
      db.run('UPDATE bookings SET reminded = 1 WHERE id = ?', b.id);
      for (const u of [b.client_id, b.specialist_id]) notify(u, 'booking_reminder', 'Consultation within the hour', when(b.starts_at), `booking:${b.id}`);
    }
    // Sessions that ran but weren't closed: complete them two hours after the end.
    const due = db.all("SELECT * FROM bookings WHERE status IN ('confirmed','in_progress') AND datetime(starts_at, '+' || duration_min || ' minutes', '+2 hours') < datetime(?)", now());
    for (const b of due) {
      if (!b.specialist_joined_at) {
        // The specialist never joined: the client gets their money back.
        db.run("UPDATE bookings SET status = 'refunded', cancel_reason = 'Specialist did not join', completed_at = ?, updated_at = ? WHERE id = ?", now(), now(), b.id);
        if (b.payment_id) await kit.refundPayment(b.payment_id, undefined, 'Specialist did not join the consultation', null).catch(() =>
          db.run("UPDATE payments SET status = 'under_review', updated_at = ? WHERE id = ?", now(), b.payment_id));
        notify(b.client_id, 'booking', 'Your consultation didn’t take place', 'The specialist didn’t join, so you’ve been refunded in full.', `booking:${b.id}`);
        notify(b.specialist_id, 'booking', 'Missed consultation', `You didn’t join the session at ${when(b.starts_at)}. The client was refunded.`, `booking:${b.id}`);
        continue;
      }
      const status = b.client_joined_at ? 'completed' : 'no_show';
      db.run('UPDATE bookings SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', status, now(), now(), b.id);
      if (status === 'completed') notify(b.client_id, 'booking', 'How was your consultation?', 'Leave a rating to help other farmers choose.', `booking:${b.id}`);
    }
    // Late payments for released bookings are refunded here (outside the payment transaction).
    while (kit.ticksLater?.length) await kit.ticksLater.shift()();
  });
}
