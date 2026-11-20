// Investment portal waiting list. Registrations are expressions of interest only.
// Nothing in this module accepts money, and the portal cannot open itself when two years pass.
import { newId, now } from '../security.js';

const SECTORS = [
  'crops', 'livestock', 'poultry', 'aquaculture', 'processing',
  'agribusiness', 'technology', 'farm-management'
];
const DEFAULT_ANNOUNCEMENT =
  'Interested in future agricultural investment opportunities across Nigeria and Africa? Agro Inspo is preparing an ecosystem intended to connect investors with agricultural businesses and opportunities. Join the waiting list to receive updates about the portal’s development and launch.';

export function registerInvestment(kit) {
  const { db, route, audit, mailer, HttpError, bad, str, oneOf, cfg } = kit;

  const setting = (key) => db.get('SELECT value FROM platform_settings WHERE key = ?', key)?.value ?? '';
  const saveSetting = (ctx, key, value) => {
    db.run(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      key, value, ctx.user.id, now()
    );
  };

  function portal() {
    const launch = setting('official_launch_at');
    let plannedOpenAt = null;
    if (launch) {
      const start = new Date(launch);
      if (!Number.isNaN(start.getTime())) {
        const open = new Date(start);
        open.setUTCFullYear(open.getUTCFullYear() + 2);
        plannedOpenAt = open.toISOString();
      }
    }
    return {
      phase: 'waiting_list',
      acceptingFunds: false,
      readyForReview: setting('investment_enabled') === '1',
      officialLaunchAt: launch || null,
      plannedOpenAt,
      announcement: setting('portal_announcement') || DEFAULT_ANNOUNCEMENT
    };
  }

  const emailOf = (v) => {
    const s = str(v, 'Email', { min: 3, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Enter a valid email address.');
    return s;
  };

  route('GET', '/api/investment/portal', () => portal());

  route('POST', '/api/investment/waitlist', async (ctx) => {
    if (ctx.body.consent !== true) throw bad('Confirm that you understand this is not an investment or a reservation.');
    const fullName = str(ctx.body.fullName, 'Full name', { min: 2, max: 120 });
    const email = emailOf(ctx.body.email);
    const phone = str(ctx.body.phone, 'Phone number', { min: 7, max: 32 });
    const sector = oneOf(ctx.body.sector, SECTORS, 'Sector');
    const country = str(ctx.body.country, 'Country', { min: 2, max: 80 });
    const location = str(ctx.body.location, 'State or location', { min: 2, max: 120 });
    let capacity = null;
    if (ctx.body.capacityNgn !== '' && ctx.body.capacityNgn != null) {
      capacity = Number(ctx.body.capacityNgn);
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1_000_000_000_000) throw bad('Estimated capacity must be a whole amount in naira.');
    }
    const updates = ctx.body.updatesOptIn !== false;
    const id = newId();
    const t = now();
    try {
      db.run(
        `INSERT INTO investment_waitlist (id, full_name, email, phone, sector, capacity_ngn, country, location, updates_opt_in, consent_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, fullName, email, phone, sector, capacity, country, location, updates ? 1 : 0, t, t
      );
    } catch (err) {
      if (String(err.message || err).includes('UNIQUE')) throw new HttpError(409, 'duplicate', 'This email is already on the waiting list.');
      throw err;
    }
    await mailer.send({
      to: email,
      subject: 'You’re on the Agro Inspo investment waiting list',
      text:
        `Hello ${fullName},\n\n` +
        `We have registered your interest in the Agro Inspo Investment Portal.\n\n` +
        `Joining this list is not an investment, a reservation, an offer, or a guarantee of access to any opportunity. ` +
        `The portal cannot take funds during the waiting-list phase, and it will not start taking funds automatically.\n\n` +
        `We will only email you about the portal if you asked for updates.\n\n` +
        `${cfg.appUrl || ''}\n`
    });
    return { status: 201, body: { ok: true, id } };
  }, { rate: [8, 3600] });

  const viewRow = (r) => ({
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    sector: r.sector,
    capacityNgn: r.capacity_ngn,
    country: r.country,
    location: r.location,
    updatesOptIn: !!r.updates_opt_in,
    consentAt: r.consent_at,
    createdAt: r.created_at
  });

  function filtered(ctx) {
    const where = [];
    const params = {};
    const q = ctx.query.get('q');
    if (q) {
      where.push('(full_name LIKE :q OR email LIKE :q OR phone LIKE :q OR location LIKE :q OR country LIKE :q)');
      params.q = `%${q.slice(0, 80).replace(/[%_]/g, '')}%`;
    }
    if (ctx.query.get('sector')) {
      where.push('sector = :sector');
      params.sector = oneOf(ctx.query.get('sector'), SECTORS, 'Sector');
    }
    if (ctx.query.get('from')) {
      where.push('created_at >= :from');
      params.from = str(ctx.query.get('from'), 'From', { min: 8, max: 40 });
    }
    if (ctx.query.get('to')) {
      where.push('created_at < :to');
      params.to = str(ctx.query.get('to'), 'To', { min: 8, max: 40 });
    }
    return db.all(
      `SELECT * FROM investment_waitlist ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 1000`,
      params
    );
  }

  route('GET', '/api/admin/investment', (ctx) => ({
    portal: portal(),
    registrations: filtered(ctx).map(viewRow)
  }), { roles: ['admin'] });

  route('GET', '/api/admin/investment/export', (ctx) => {
    const rows = filtered(ctx);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Registered', 'Name', 'Email', 'Phone', 'Sector', 'Capacity NGN', 'Country', 'Location', 'Updates', 'Consent at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.created_at, r.full_name, r.email, r.phone, r.sector, r.capacity_ngn ?? '', r.country, r.location, r.updates_opt_in ? 'yes' : 'no', r.consent_at].map(esc).join(','));
    }
    audit(ctx, 'investment.exported', 'investment_waitlist', '', { count: rows.length });
    return {
      file: {
        mime: 'text/csv; charset=utf-8',
        buffer: Buffer.from(lines.join('\n'), 'utf8'),
        filename: 'agro-inspo-investment-waitlist.csv'
      }
    };
  }, { roles: ['admin'] });

  route('PATCH', '/api/admin/investment/settings', (ctx) => {
    if (ctx.body.officialLaunchAt !== undefined) {
      const raw = str(ctx.body.officialLaunchAt, 'Launch date', { required: false, max: 40 });
      if (raw) {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw bad('Enter a valid official launch date.');
        saveSetting(ctx, 'official_launch_at', d.toISOString());
      } else saveSetting(ctx, 'official_launch_at', '');
    }
    if (ctx.body.announcement !== undefined) {
      saveSetting(ctx, 'portal_announcement', str(ctx.body.announcement, 'Announcement', { min: 20, max: 2000 }));
    }
    if (ctx.body.readyForReview === true) {
      if (ctx.body.readinessConfirmed !== true) throw bad('Confirm that the legal, regulatory and operational checks are complete.');
      if (!setting('official_launch_at')) throw bad('Set the official public launch date before marking the portal ready.');
      saveSetting(ctx, 'investment_enabled', '1');
    } else if (ctx.body.readyForReview === false) {
      saveSetting(ctx, 'investment_enabled', '0');
    }
    audit(ctx, 'investment.settings_updated', 'platform_settings', 'investment', {
      officialLaunchAt: setting('official_launch_at') || null,
      readyForReview: setting('investment_enabled') === '1'
    });
    return { portal: portal() };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/investment/updates', async (ctx) => {
    const subject = str(ctx.body.subject, 'Subject', { min: 5, max: 140 });
    const message = str(ctx.body.message, 'Message', { min: 20, max: 5000 });
    const people = db.all('SELECT email, full_name FROM investment_waitlist WHERE updates_opt_in = 1');
    for (const p of people) {
      await mailer.send({
        to: p.email,
        subject,
        text: `Hello ${p.full_name},\n\n${message}\n\nThis is an update about the Agro Inspo Investment Portal. It is not an offer to invest.\n`
      });
    }
    audit(ctx, 'investment.update_sent', 'investment_waitlist', '', { recipients: people.length, subject });
    return { sent: people.length };
  }, { roles: ['admin'] });
}
