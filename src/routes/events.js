// Live events, registration, tickets, the live room (chat & Q&A), replays and reminders (PRD §24).
import { newId, now } from '../security.js';

const HOST_ROLES = ['specialist', 'business', 'admin'];
const HOUR = 3600 * 1000;
const JOIN_EARLY_MIN = 15; // attendees may enter this many minutes before the start

export function registerEvents(kit) {
  const { db, route, audit, notify, mailer, video, HttpError, bad, str, oneOf, requireVerified, requireActive, fulfil, cfg } = kit;
  const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];

  const SELECT_EVENT = `
    SELECT e.*, u.name AS host_name, u.title AS host_title, u.role AS host_role,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS registered_count,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.joined_at IS NOT NULL) AS attended_count,
      (SELECT status FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = :viewer) AS my_status
    FROM events e JOIN users u ON u.id = e.host_id`;

  const view = (e, viewer) => {
    const isHost = viewer && (viewer.id === e.host_id || viewer.role === 'admin');
    const registered = e.my_status === 'registered';
    const endsAt = new Date(new Date(e.starts_at).getTime() + e.duration_min * 60_000).toISOString();
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      topic: e.topic,
      speakers: e.speakers,
      startsAt: e.starts_at,
      endsAt,
      durationMin: e.duration_min,
      capacity: e.capacity,
      priceNgn: e.price_ngn,
      recording: !!e.recording,
      replayAccess: e.replay_access,
      status: e.status,
      host: { id: e.host_id, name: e.host_name, title: e.host_title, role: e.host_role },
      registeredCount: e.registered_count,
      spotsLeft: e.capacity ? Math.max(0, e.capacity - e.registered_count) : null,
      myRegistration: e.my_status || null,
      isHost: !!isHost,
      replayAvailable: !!e.replay_published && !!e.replay_url,
      canJoin: e.status === 'live' || (e.status === 'scheduled' && Date.now() >= new Date(e.starts_at).getTime() - JOIN_EARLY_MIN * 60_000),
      ...(isHost ? { attendedCount: e.attended_count, replayUrl: e.replay_url, replayPublished: !!e.replay_published } : {}),
      ...(registered || isHost ? {} : {})
    };
  };

  function getEvent(id, viewer) {
    const e = db.get(`${SELECT_EVENT} WHERE e.id = :id`, { id, viewer: viewer?.id ?? '' });
    if (!e) throw new HttpError(404, 'not_found', 'This event could not be found.');
    return e;
  }
  function ownEvent(ctx, id) {
    const e = db.get('SELECT * FROM events WHERE id = ?', id);
    if (!e) throw new HttpError(404, 'not_found', 'Event not found.');
    if (e.host_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only the host can do that.');
    return e;
  }
  const isParticipant = (e, user) =>
    user.id === e.host_id || user.role === 'admin' ||
    !!db.get("SELECT 1 FROM event_registrations WHERE event_id = ? AND user_id = ? AND status = 'registered'", e.id, user.id);

  function parseEventInput(b, existing) {
    const d = {
      title: str(b.title, 'Title', { min: 5, max: 140 }),
      description: str(b.description, 'Description', { min: 20, max: 5000 }),
      topic: oneOf(b.topic, TOPICS, 'Topic'),
      speakers: str(b.speakers, 'Speakers', { max: 300 }),
      startsAt: String(b.startsAt || ''),
      durationMin: Number(b.durationMin),
      capacity: b.capacity === '' || b.capacity == null ? null : Number(b.capacity),
      priceNgn: Number(b.priceNgn || 0),
      recording: b.recording === true,
      replayAccess: oneOf(b.replayAccess || 'registrants', ['members', 'registrants'], 'Replay access')
    };
    const start = new Date(d.startsAt);
    if (Number.isNaN(start.getTime())) throw bad('Choose a valid start date and time.');
    if (!existing && start.getTime() < Date.now() + 10 * 60_000) throw bad('Events must start at least 10 minutes from now.');
    d.startsAt = start.toISOString();
    if (!Number.isInteger(d.durationMin) || d.durationMin < 15 || d.durationMin > 480) throw bad('Duration must be between 15 minutes and 8 hours.');
    if (d.capacity !== null && (!Number.isInteger(d.capacity) || d.capacity < 1 || d.capacity > 10000)) throw bad('Capacity must be between 1 and 10,000.');
    if (!Number.isInteger(d.priceNgn) || d.priceNgn < 0 || d.priceNgn > 1_000_000) throw bad('Ticket price must be between ₦0 and ₦1,000,000.');
    if (d.priceNgn > 0 && d.priceNgn < 100) throw bad('Paid tickets must cost at least ₦100.');
    return d;
  }

  /* ---------- browse ---------- */
  route('GET', '/api/events', (ctx) => {
    const when = oneOf(ctx.query.get('when') || 'upcoming', ['upcoming', 'past', 'replays', 'mine', 'hosting'], 'View');
    const where = [];
    const params = { viewer: ctx.user?.id ?? '' };
    if (when === 'upcoming') where.push("e.status IN ('scheduled','live')");
    if (when === 'past') where.push("e.status = 'ended'");
    if (when === 'replays') where.push("e.status = 'ended' AND e.replay_published = 1 AND e.replay_url != ''");
    if (when === 'mine') {
      if (!ctx.user) throw new HttpError(401, 'login_required', 'Log in to see your events.');
      where.push("e.id IN (SELECT event_id FROM event_registrations WHERE user_id = :viewer AND status != 'cancelled')");
    }
    if (when === 'hosting') {
      if (!ctx.user) throw new HttpError(401, 'login_required', 'Log in to see your events.');
      where.push('e.host_id = :viewer');
    }
    if (ctx.query.get('topic')) (where.push('e.topic = :topic'), (params.topic = oneOf(ctx.query.get('topic'), TOPICS, 'Topic')));
    if (ctx.query.get('q')) (where.push('(e.title LIKE :q OR e.description LIKE :q OR e.speakers LIKE :q OR u.name LIKE :q)'), (params.q = `%${ctx.query.get('q').slice(0, 80).replace(/[%_]/g, '')}%`));
    const order = when === 'upcoming' ? "(e.status = 'live') DESC, e.starts_at ASC" : 'e.starts_at DESC';
    const rows = db.all(`${SELECT_EVENT} WHERE ${where.join(' AND ') || '1=1'} ORDER BY ${order} LIMIT 100`, params);
    return { events: rows.map((e) => view(e, ctx.user)) };
  });

  route('GET', '/api/events/:id', (ctx) => ({ event: view(getEvent(ctx.params.id, ctx.user), ctx.user) }));

  /* ---------- host ---------- */
  route('POST', '/api/events', (ctx) => {
    requireVerified(ctx);
    if (!HOST_ROLES.includes(ctx.user.role)) throw new HttpError(403, 'forbidden', 'Specialist, business and admin accounts can host events.');
    const d = parseEventInput(ctx.body);
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO events (id, host_id, title, description, topic, speakers, starts_at, duration_min, capacity, price_ngn, recording, replay_access, room_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.user.id, d.title, d.description, d.topic, d.speakers, d.startsAt, d.durationMin, d.capacity, d.priceNgn,
      d.recording ? 1 : 0, d.replayAccess, video.createRoom(id), t, t
    );
    audit(ctx, 'event.created', 'event', id, { priceNgn: d.priceNgn });
    // Let topic followers know.
    for (const f of db.all("SELECT user_id FROM follows WHERE target_type='topic' AND target=? AND user_id != ? LIMIT 1000", d.topic, ctx.user.id))
      notify(f.user_id, 'event', 'New event on a topic you follow', `${d.title} · ${new Date(d.startsAt).toUTCString().slice(0, 22)} UTC`, `event:${id}`);
    return { status: 201, body: { event: view(getEvent(id, ctx.user), ctx.user) } };
  }, { auth: true });

  route('PATCH', '/api/events/:id', (ctx) => {
    requireActive(ctx);
    const e = ownEvent(ctx, ctx.params.id);
    if (e.status !== 'scheduled') throw bad('Only scheduled events can be edited.');
    const d = parseEventInput(ctx.body, e);
    const paidRegs = db.get("SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND payment_id IS NOT NULL AND status='registered'", e.id).n;
    if (paidRegs && d.priceNgn !== e.price_ngn) throw bad('You can’t change the ticket price after tickets have been sold.');
    db.run(
      `UPDATE events SET title=?, description=?, topic=?, speakers=?, starts_at=?, duration_min=?, capacity=?, price_ngn=?, recording=?, replay_access=?, updated_at=? WHERE id=?`,
      d.title, d.description, d.topic, d.speakers, d.startsAt, d.durationMin, d.capacity, d.priceNgn, d.recording ? 1 : 0, d.replayAccess, now(), e.id
    );
    if (d.startsAt !== e.starts_at) {
      db.run('UPDATE event_registrations SET reminded_24h = 0, reminded_1h = 0 WHERE event_id = ?', e.id);
      for (const r of db.all("SELECT user_id FROM event_registrations WHERE event_id = ? AND status = 'registered'", e.id))
        notify(r.user_id, 'event', 'Event time changed', `${d.title} now starts ${new Date(d.startsAt).toUTCString().slice(0, 22)} UTC.`, `event:${e.id}`);
    }
    return { event: view(getEvent(e.id, ctx.user), ctx.user) };
  }, { auth: true });

  route('POST', '/api/events/:id/cancel', async (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    if (!['scheduled', 'live'].includes(e.status)) throw bad('This event can’t be cancelled.');
    const reason = str(ctx.body.reason, 'Reason', { min: 5, max: 500 });
    db.tx(() => {
      db.run("UPDATE events SET status='cancelled', updated_at=? WHERE id=?", now(), e.id);
      for (const r of db.all("SELECT user_id, payment_id FROM event_registrations WHERE event_id = ? AND status = 'registered'", e.id)) {
        notify(r.user_id, 'event', 'Event cancelled', `${e.title}: ${reason}${r.payment_id ? ' Your ticket is being refunded in full.' : ''}`, `event:${e.id}`);
      }
      audit(ctx, 'event.cancelled', 'event', e.id, { reason });
    });
    // Paid tickets are refunded in full straight away.
    let failed = 0;
    for (const r of db.all("SELECT payment_id FROM event_registrations WHERE event_id = ? AND payment_id IS NOT NULL AND status = 'registered'", e.id)) {
      const pay = db.get('SELECT * FROM payments WHERE id = ?', r.payment_id);
      if (!pay || !['successful', 'partially_refunded'].includes(pay.status)) continue;
      try {
        await kit.refundPayment(pay.id, undefined, `Event cancelled: ${e.title}`, ctx.user);
      } catch {
        failed++;
        db.run("UPDATE payments SET status='under_review', updated_at=? WHERE id=?", now(), pay.id);
      }
    }
    for (const hook of kit.onEventCancelled) failed += (await hook(e, reason, ctx.user)) || 0;
    return { ok: true, refundFailures: failed };
  }, { auth: true });

  route('POST', '/api/events/:id/start', (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    if (e.status !== 'scheduled') throw bad('This event has already started or finished.');
    if (Date.now() < new Date(e.starts_at).getTime() - 30 * 60_000) throw bad('You can start the event up to 30 minutes early.');
    db.run("UPDATE events SET status='live', started_at=?, updated_at=? WHERE id=?", now(), now(), e.id);
    for (const r of db.all("SELECT user_id FROM event_registrations WHERE event_id = ? AND status='registered' AND notified_live = 0", e.id)) {
      notify(r.user_id, 'event_live', 'Live now', e.title, `event:${e.id}`);
      db.run('UPDATE event_registrations SET notified_live = 1 WHERE event_id = ? AND user_id = ?', e.id, r.user_id);
    }
    return { status: 'live' };
  }, { auth: true });

  route('POST', '/api/events/:id/end', (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    if (e.status !== 'live') throw bad('This event isn’t live.');
    db.run("UPDATE events SET status='ended', ended_at=?, updated_at=? WHERE id=?", now(), now(), e.id);
    return { status: 'ended' };
  }, { auth: true });

  route('POST', '/api/events/:id/replay', (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    if (e.status !== 'ended') throw bad('Add a replay after the event has ended.');
    if (!e.recording) throw bad('This event wasn’t marked for recording, so attendees didn’t consent to a replay.');
    const url = str(ctx.body.replayUrl, 'Replay link', { min: 10, max: 500 });
    if (!/^https:\/\/\S+$/.test(url)) throw bad('Replay link must start with https://');
    const publish = ctx.body.publish === true;
    db.run('UPDATE events SET replay_url=?, replay_published=?, updated_at=? WHERE id=?', url, publish ? 1 : 0, now(), e.id);
    if (publish && !e.replay_published)
      for (const r of db.all("SELECT user_id FROM event_registrations WHERE event_id = ? AND status='registered'", e.id))
        notify(r.user_id, 'event', 'Replay available', e.title, `event:${e.id}`);
    audit(ctx, publish ? 'event.replay_published' : 'event.replay_saved', 'event', e.id);
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/events/:id/replay', (ctx) => {
    const e = db.get('SELECT * FROM events WHERE id = ?', ctx.params.id);
    if (!e || !e.replay_published || !e.replay_url) throw new HttpError(404, 'not_found', 'No replay for this event.');
    const allowed = e.replay_access === 'members' ? true : isParticipant(e, ctx.user);
    if (!allowed) throw new HttpError(403, 'forbidden', e.price_ngn ? 'The replay is for ticket holders.' : 'Register for this event to watch the replay.');
    return { replayUrl: e.replay_url };
  }, { auth: true });

  route('GET', '/api/events/:id/attendees', (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    return {
      attendees: db.all(
        `SELECT u.id, u.name, u.title, r.status, r.joined_at AS joinedAt, r.created_at AS registeredAt, r.payment_id IS NOT NULL AS paid
         FROM event_registrations r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status != 'cancelled' ORDER BY r.created_at`,
        e.id
      )
    };
  }, { auth: true });

  /* ---------- attendees ---------- */
  route('POST', '/api/events/:id/register', async (ctx) => {
    requireActive(ctx);
    const e = getEvent(ctx.params.id, ctx.user);
    if (!['scheduled', 'live'].includes(e.status)) throw bad('Registration for this event is closed.');
    if (e.host_id === ctx.user.id) throw bad('You’re hosting this event.');
    if (e.my_status === 'registered') return { status: 'registered' };
    if (e.capacity && e.registered_count >= e.capacity) throw new HttpError(409, 'full', 'This event is full.');
    if (!e.price_ngn) {
      db.run(
        `INSERT INTO event_registrations (event_id, user_id, status, created_at) VALUES (?,?, 'registered', ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET status='registered'`,
        e.id, ctx.user.id, now()
      );
      notify(ctx.user.id, 'event', 'You’re registered', `${e.title}. We’ll remind you a day and an hour before.`, `event:${e.id}`);
      return { status: 'registered' };
    }
    requireVerified(ctx);
    const payment = await kit.createPayment({
      user: ctx.user, purpose: 'event_ticket', subjectId: e.id, amountNgn: e.price_ngn,
      description: `Ticket: ${e.title}`, returnPath: `events:${e.id}`
    });
    db.run(
      `INSERT INTO event_registrations (event_id, user_id, status, payment_id, created_at) VALUES (?,?, 'pending_payment', ?, ?)
       ON CONFLICT(event_id, user_id) DO UPDATE SET status='pending_payment', payment_id=excluded.payment_id`,
      e.id, ctx.user.id, payment.id, now()
    );
    return { status: 'pending_payment', checkoutUrl: payment.checkout_url, reference: payment.reference };
  }, { auth: true });

  fulfil.event_ticket = (payment) => {
    db.run("UPDATE event_registrations SET status='registered' WHERE event_id=? AND user_id=?", payment.subject_id, payment.user_id);
    const e = db.get('SELECT title, host_id, starts_at, duration_min FROM events WHERE id = ?', payment.subject_id);
    // Host earns the ticket price less commission, available a few days after the event ends.
    if (e) kit.ledger.recordSale({ sellerId: e.host_id, purpose: 'event_ticket', sourceId: payment.subject_id, payment,
      availableFrom: new Date(new Date(e.starts_at).getTime() + e.duration_min * 60000).toISOString() });
    notify(payment.user_id, 'event', 'Ticket confirmed', `${e?.title ?? 'Event'}. We’ll remind you before it starts.`, `event:${payment.subject_id}`);
  };
  fulfil['event_ticket:failed'] = (payment) => {
    db.run("DELETE FROM event_registrations WHERE event_id=? AND user_id=? AND status='pending_payment'", payment.subject_id, payment.user_id);
  };

  route('POST', '/api/events/:id/unregister', (ctx) => {
    const r = db.get('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    if (!r) return { status: null };
    if (r.payment_id && r.status === 'registered') throw bad('Paid tickets can’t be cancelled here. Contact support for a refund.');
    db.run('DELETE FROM event_registrations WHERE event_id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    return { status: null };
  }, { auth: true });

  // Enter the live room. Recording consent is asked before joining a recorded event (PRD §24, §34).
  route('POST', '/api/events/:id/join', async (ctx) => {
    requireActive(ctx);
    const e = db.get('SELECT * FROM events WHERE id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'not_found', 'Event not found.');
    const host = e.host_id === ctx.user.id || ctx.user.role === 'admin';
    if (!isParticipant(e, ctx.user)) throw new HttpError(403, 'not_registered', 'Register for this event to join.');
    if (e.status === 'ended' || e.status === 'cancelled') throw bad('This event is over.');
    const opensAt = new Date(e.starts_at).getTime() - (host ? 30 : JOIN_EARLY_MIN) * 60_000;
    if (e.status !== 'live' && Date.now() < opensAt) throw bad(`The room opens ${host ? 30 : JOIN_EARLY_MIN} minutes before the start.`);
    if (e.recording && !host && ctx.body.recordingConsent !== true)
      throw new HttpError(428, 'consent_required', 'This event is recorded. Agree to the recording to join.');
    if (!host)
      db.run(
        'UPDATE event_registrations SET joined_at = COALESCE(joined_at, ?), recording_consent_at = COALESCE(recording_consent_at, ?) WHERE event_id = ? AND user_id = ?',
        now(), e.recording ? now() : null, e.id, ctx.user.id
      );
    const token = await video.joinToken({ roomId: e.room_id, userId: ctx.user.id, role: host ? 'host' : 'audience' });
    return { video: token, role: host ? 'host' : 'audience' };
  }, { auth: true });

  route('GET', '/api/events/:id/messages', (ctx) => {
    const e = db.get('SELECT * FROM events WHERE id = ?', ctx.params.id);
    if (!e || !isParticipant(e, ctx.user)) throw new HttpError(404, 'not_found', 'Event not found.');
    const after = ctx.query.get('after') || '';
    const rows = db.all(
      `SELECT m.*, u.name FROM event_messages m JOIN users u ON u.id = m.user_id
       WHERE m.event_id = ? AND m.created_at > ? ORDER BY m.created_at ASC LIMIT 200`,
      e.id, after
    );
    return {
      status: e.status,
      messages: rows.map((m) => ({ id: m.id, kind: m.kind, body: m.body, answered: !!m.answered, createdAt: m.created_at, user: { id: m.user_id, name: m.name }, fromHost: m.user_id === e.host_id }))
    };
  }, { auth: true });

  route('POST', '/api/events/:id/messages', (ctx) => {
    requireActive(ctx);
    const e = db.get('SELECT * FROM events WHERE id = ?', ctx.params.id);
    if (!e || !isParticipant(e, ctx.user)) throw new HttpError(404, 'not_found', 'Event not found.');
    if (e.status !== 'live') throw bad('Chat opens when the event goes live.');
    if (!kit.limit(`evmsg:${ctx.user.id}`, 20, 60_000)) throw new HttpError(429, 'rate_limited', 'Slow down a little.');
    const kind = oneOf(ctx.body.kind || 'chat', ['chat', 'question'], 'Kind');
    const body = str(ctx.body.body, 'Message', { min: 1, max: 500 });
    const id = newId();
    db.run('INSERT INTO event_messages (id, event_id, user_id, kind, body, created_at) VALUES (?,?,?,?,?,?)', id, e.id, ctx.user.id, kind, body, now());
    return { status: 201, body: { id } };
  }, { auth: true });

  route('POST', '/api/events/:id/messages/:mid/answer', (ctx) => {
    const e = ownEvent(ctx, ctx.params.id);
    db.run("UPDATE event_messages SET answered = 1 WHERE id = ? AND event_id = ? AND kind = 'question'", ctx.params.mid, e.id);
    return { ok: true };
  }, { auth: true });

  /* ---------- scheduled: reminders ---------- */
  kit.ticks.push(async () => {
    const soon = db.all(
      `SELECT r.event_id, r.user_id, r.reminded_24h, r.reminded_1h, e.title, e.starts_at, u.email, u.name, u.notif_prefs
       FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id
       WHERE r.status = 'registered' AND e.status = 'scheduled' AND e.starts_at > ? AND e.starts_at <= ?
         AND (r.reminded_24h = 0 OR r.reminded_1h = 0)`,
      now(), new Date(Date.now() + 24 * HOUR).toISOString()
    );
    for (const r of soon) {
      const within1h = new Date(r.starts_at).getTime() - Date.now() <= HOUR;
      if (within1h && !r.reminded_1h) {
        db.run('UPDATE event_registrations SET reminded_1h = 1, reminded_24h = 1 WHERE event_id = ? AND user_id = ?', r.event_id, r.user_id);
        notify(r.user_id, 'event_reminder', 'Starting within the hour', r.title, `event:${r.event_id}`);
      } else if (!within1h && !r.reminded_24h) {
        db.run('UPDATE event_registrations SET reminded_24h = 1 WHERE event_id = ? AND user_id = ?', r.event_id, r.user_id);
        notify(r.user_id, 'event_reminder', 'Tomorrow: ' + r.title, `Starts ${new Date(r.starts_at).toUTCString().slice(0, 22)} UTC.`, `event:${r.event_id}`);
        const prefs = JSON.parse(r.notif_prefs || '{}');
        if (prefs.email !== false)
          await mailer.send({
            to: r.email,
            subject: `Reminder: ${r.title}`,
            text: `Hi ${r.name},\n\n“${r.title}” starts ${new Date(r.starts_at).toUTCString()}.\nJoin from ${cfg.appUrl} → Events.`
          });
      }
    }
  });
}
