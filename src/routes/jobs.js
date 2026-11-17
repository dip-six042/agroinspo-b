// Agricultural jobs marketplace (PRD §25): listings, paid publication, review, applications, CVs.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, now } from '../security.js';
import { JOB_PLANS, JOB_CATEGORIES, SCAM_PATTERNS, MAX_CV_BYTES, CV_TYPES } from '../config.js';

const EMPLOYER_ROLES = ['farmer', 'business', 'admin'];
const TYPES = ['full-time', 'part-time', 'contract', 'seasonal', 'internship'];
const MODES = ['onsite', 'remote', 'hybrid'];
const PERIODS = ['month', 'year', 'project', 'day'];
const APP_STATUSES = ['submitted', 'reviewing', 'shortlisted', 'interview', 'offered', 'hired', 'rejected'];
const DAY = 24 * 3600 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

export function screenJobText(text) {
  return [...new Set(SCAM_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.flag))];
}

export function registerJobs(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, parseJson, requireVerified, requireActive, cfg, fulfil } = kit;

  const jobView = (j, viewerId) => {
    const out = {
      id: j.id,
      title: j.title,
      description: j.description,
      responsibilities: parseJson(j.responsibilities, []),
      qualifications: parseJson(j.qualifications, []),
      category: j.category,
      employmentType: j.employment_type,
      workMode: j.work_mode,
      location: j.location,
      payMin: j.pay_min,
      payMax: j.pay_max,
      payPeriod: j.pay_period,
      openings: j.openings,
      closingDate: j.closing_date,
      applyMethod: j.apply_method,
      externalUrl: j.external_url,
      plan: j.plan,
      featured: j.plan === 'featured',
      status: j.status,
      publishedAt: j.published_at,
      expiresAt: j.expires_at,
      createdAt: j.created_at,
      employer: { id: j.employer_id, name: j.employer_name, role: j.employer_role, title: j.employer_title, emailVerified: !!j.employer_verified },
      saved: !!j.saved,
      myApplication: j.my_app_status ? { id: j.my_app_id, status: j.my_app_status } : null
    };
    if (viewerId && (viewerId === j.employer_id || j.viewer_is_admin)) {
      out.flags = parseJson(j.flags, []);
      out.reviewNote = j.review_note;
      out.applicantCount = j.applicant_count ?? undefined;
    }
    return out;
  };

  const SELECT_JOB = `
    SELECT j.*, u.name AS employer_name, u.role AS employer_role, u.title AS employer_title, u.email_verified AS employer_verified,
      EXISTS (SELECT 1 FROM saved_jobs s WHERE s.job_id = j.id AND s.user_id = :viewer) AS saved,
      (SELECT a.id FROM job_applications a WHERE a.job_id = j.id AND a.applicant_id = :viewer) AS my_app_id,
      (SELECT a.status FROM job_applications a WHERE a.job_id = j.id AND a.applicant_id = :viewer) AS my_app_status,
      (SELECT COUNT(*) FROM job_applications a WHERE a.job_id = j.id AND a.status != 'withdrawn') AS applicant_count,
      (SELECT role = 'admin' FROM users WHERE id = :viewer) AS viewer_is_admin
    FROM jobs j JOIN users u ON u.id = j.employer_id`;

  const LIVE = `j.status = 'published' AND j.closing_date >= :today AND (j.expires_at IS NULL OR j.expires_at > :now)`;

  function getJob(id, viewer) {
    const j = db.get(`${SELECT_JOB} WHERE j.id = :id`, { id, viewer: viewer?.id ?? '' });
    if (!j) throw new HttpError(404, 'not_found', 'This job could not be found.');
    const isOwner = viewer && (viewer.id === j.employer_id || viewer.role === 'admin');
    if (j.status !== 'published' && !isOwner) throw new HttpError(404, 'not_found', 'This job is no longer available.');
    return j;
  }
  function ownJob(ctx, id) {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', id);
    if (!j) throw new HttpError(404, 'not_found', 'Job not found.');
    if (j.employer_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only the employer can manage this listing.');
    return j;
  }

  function lines(v, name, max = 15) {
    if (v === undefined) return [];
    const arr = Array.isArray(v) ? v : String(v).split('\n');
    const out = arr.map((x) => String(x).trim()).filter(Boolean);
    if (out.length > max) throw bad(`${name}: up to ${max} points.`);
    return out.map((x) => str(x, name, { max: 300 }));
  }

  function parseJobInput(b) {
    const data = {
      title: str(b.title, 'Job title', { min: 4, max: 120 }),
      description: str(b.description, 'Description', { min: 30, max: 6000 }),
      responsibilities: lines(b.responsibilities, 'Responsibilities'),
      qualifications: lines(b.qualifications, 'Qualifications'),
      category: oneOf(b.category, JOB_CATEGORIES, 'Category'),
      employmentType: oneOf(b.employmentType, TYPES, 'Employment type'),
      workMode: oneOf(b.workMode || 'onsite', MODES, 'Work mode'),
      location: str(b.location, 'Location', { min: 2, max: 120 }),
      payMin: b.payMin === '' || b.payMin == null ? null : Number(b.payMin),
      payMax: b.payMax === '' || b.payMax == null ? null : Number(b.payMax),
      payPeriod: b.payPeriod ? oneOf(b.payPeriod, PERIODS, 'Pay period') : null,
      openings: Number(b.openings || 1),
      closingDate: str(b.closingDate, 'Closing date', { min: 10, max: 10 }),
      applyMethod: oneOf(b.applyMethod || 'platform', ['platform', 'external'], 'Application method'),
      externalUrl: str(b.externalUrl, 'Application link', { max: 500 })
    };
    for (const k of ['payMin', 'payMax'])
      if (data[k] !== null && (!Number.isInteger(data[k]) || data[k] < 0 || data[k] > 100_000_000)) throw bad('Pay must be a whole number of naira.');
    if (data.payMin !== null && data.payMax !== null && data.payMin > data.payMax) throw bad('Minimum pay can’t be more than maximum pay.');
    if ((data.payMin !== null || data.payMax !== null) && !data.payPeriod) throw bad('Say whether pay is per day, month, year or project.');
    if (!Number.isInteger(data.openings) || data.openings < 1 || data.openings > 500) throw bad('Openings must be between 1 and 500.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.closingDate) || data.closingDate < today()) throw bad('Closing date must be today or later.');
    if (data.closingDate > new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10)) throw bad('Closing date can be at most 120 days away.');
    if (data.applyMethod === 'external' && !/^https:\/\/[^\s]+$/.test(data.externalUrl)) throw bad('External applications need a secure https:// link.');
    data.flags = screenJobText([data.title, data.description, ...data.responsibilities, ...data.qualifications].join('\n'));
    return data;
  }

  /* ---------- browsing ---------- */
  route('GET', '/api/jobs/meta', () => ({
    categories: JOB_CATEGORIES,
    plans: Object.entries(JOB_PLANS).map(([id, p]) => ({ id, ...p })),
    types: TYPES,
    modes: MODES
  }));

  route('GET', '/api/jobs', (ctx) => {
    const q = ctx.query;
    const where = [LIVE];
    const params = { viewer: ctx.user?.id ?? '', today: today(), now: now() };
    if (q.get('q')) {
      where.push('(j.title LIKE :q OR j.description LIKE :q OR u.name LIKE :q)');
      params.q = `%${q.get('q').slice(0, 80).replace(/[%_]/g, '')}%`;
    }
    if (q.get('category')) (where.push('j.category = :category'), (params.category = oneOf(q.get('category'), JOB_CATEGORIES, 'Category')));
    if (q.get('type')) (where.push('j.employment_type = :type'), (params.type = oneOf(q.get('type'), TYPES, 'Type')));
    if (q.get('mode')) (where.push('j.work_mode = :mode'), (params.mode = oneOf(q.get('mode'), MODES, 'Work mode')));
    if (q.get('location')) (where.push('j.location LIKE :loc'), (params.loc = `%${q.get('location').slice(0, 60).replace(/[%_]/g, '')}%`));
    if (q.get('payMin')) (where.push('COALESCE(j.pay_max, j.pay_min, 0) >= :payMin'), (params.payMin = Number(q.get('payMin')) || 0));
    const rows = db.all(
      `${SELECT_JOB} WHERE ${where.join(' AND ')}
       ORDER BY (j.plan = 'featured') DESC, j.published_at DESC LIMIT ${Math.min(Number(q.get('limit')) || 50, 100)}`,
      params
    );
    return { jobs: rows.map((j) => jobView(j, ctx.user?.id)) };
  });

  route('GET', '/api/jobs/:id', (ctx) => {
    if (ctx.params.id === 'meta') throw new HttpError(404, 'not_found', 'Not found.');
    return { job: jobView(getJob(ctx.params.id, ctx.user), ctx.user?.id) };
  });

  route('POST', '/api/jobs/:id/save', (ctx) => {
    getJob(ctx.params.id, ctx.user);
    const has = db.get('SELECT 1 FROM saved_jobs WHERE user_id=? AND job_id=?', ctx.user.id, ctx.params.id);
    if (has) db.run('DELETE FROM saved_jobs WHERE user_id=? AND job_id=?', ctx.user.id, ctx.params.id);
    else db.run('INSERT INTO saved_jobs (user_id, job_id, created_at) VALUES (?,?,?)', ctx.user.id, ctx.params.id, now());
    return { saved: !has };
  }, { auth: true });

  route('GET', '/api/me/saved-jobs', (ctx) => ({
    jobs: db
      .all(`${SELECT_JOB} WHERE j.id IN (SELECT job_id FROM saved_jobs WHERE user_id = :viewer) ORDER BY j.published_at DESC`, { viewer: ctx.user.id })
      .map((j) => jobView(j, ctx.user.id))
  }), { auth: true });

  /* ---------- employer: create, pay, manage ---------- */
  route('POST', '/api/jobs', (ctx) => {
    requireVerified(ctx);
    if (!EMPLOYER_ROLES.includes(ctx.user.role))
      throw new HttpError(403, 'forbidden', 'Only farm and business accounts can post jobs.');
    const d = parseJobInput(ctx.body);
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO jobs (id, employer_id, title, description, responsibilities, qualifications, category, employment_type, work_mode,
         location, pay_min, pay_max, pay_period, openings, closing_date, apply_method, external_url, flags, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.user.id, d.title, d.description, JSON.stringify(d.responsibilities), JSON.stringify(d.qualifications), d.category,
      d.employmentType, d.workMode, d.location, d.payMin, d.payMax, d.payPeriod, d.openings, d.closingDate, d.applyMethod,
      d.externalUrl, JSON.stringify(d.flags), t, t
    );
    return { status: 201, body: { job: jobView(getJob(id, ctx.user), ctx.user.id) } };
  }, { auth: true });

  route('PATCH', '/api/jobs/:id', (ctx) => {
    requireActive(ctx);
    const j = ownJob(ctx, ctx.params.id);
    if (['closed', 'archived', 'expired'].includes(j.status)) throw bad('This listing can no longer be edited. Post a new job instead.');
    if (j.status === 'under_review') throw bad('This listing is being reviewed. You can edit it once the review is done.');
    const d = parseJobInput({ ...ctx.body });
    // Edits to a live listing go back through review.
    const nextStatus = ['published', 'paused'].includes(j.status) ? 'under_review' : j.status;
    db.run(
      `UPDATE jobs SET title=?, description=?, responsibilities=?, qualifications=?, category=?, employment_type=?, work_mode=?, location=?,
         pay_min=?, pay_max=?, pay_period=?, openings=?, closing_date=?, apply_method=?, external_url=?, flags=?, status=?, updated_at=? WHERE id=?`,
      d.title, d.description, JSON.stringify(d.responsibilities), JSON.stringify(d.qualifications), d.category, d.employmentType, d.workMode,
      d.location, d.payMin, d.payMax, d.payPeriod, d.openings, d.closingDate, d.applyMethod, d.externalUrl, JSON.stringify(d.flags), nextStatus, now(), j.id
    );
    return { job: jobView(getJob(j.id, ctx.user), ctx.user.id), reReview: nextStatus !== j.status };
  }, { auth: true });

  // Choose a plan and pay. If this listing was already paid for (e.g. it was rejected and edited),
  // it goes straight back to review.
  route('POST', '/api/jobs/:id/checkout', async (ctx) => {
    requireVerified(ctx);
    const j = ownJob(ctx, ctx.params.id);
    if (!['draft', 'rejected', 'payment_pending'].includes(j.status)) throw bad('This listing has already been submitted.');
    const plan = oneOf(ctx.body.plan || 'standard', Object.keys(JOB_PLANS), 'Plan');
    const paid = db.get("SELECT * FROM payments WHERE purpose='job_listing' AND subject_id=? AND status='successful' AND json_extract(meta,'$.kind')='new'", j.id);
    if (paid || ctx.user.role === 'admin') {
      db.run("UPDATE jobs SET status='under_review', plan=?, updated_at=? WHERE id=?", paid ? j.plan : plan, now(), j.id);
      return { status: 'under_review', checkoutUrl: null };
    }
    const p = JOB_PLANS[plan];
    const payment = await kit.createPayment({
      user: ctx.user,
      purpose: 'job_listing',
      subjectId: j.id,
      amountNgn: p.priceNgn,
      description: `${p.label}: ${j.title}`,
      meta: { kind: 'new', plan },
      returnPath: 'jobs:mine'
    });
    db.run("UPDATE jobs SET status='payment_pending', plan=?, updated_at=? WHERE id=?", plan, now(), j.id);
    return { status: 'payment_pending', checkoutUrl: payment.checkout_url, reference: payment.reference, amountNgn: p.priceNgn };
  }, { auth: true });

  route('POST', '/api/jobs/:id/renew', async (ctx) => {
    requireVerified(ctx);
    const j = ownJob(ctx, ctx.params.id);
    if (!['published', 'expired', 'paused'].includes(j.status)) throw bad('Only live, paused or expired listings can be renewed.');
    const plan = oneOf(ctx.body.plan || j.plan, Object.keys(JOB_PLANS), 'Plan');
    if (j.closing_date < today()) throw bad('Move the closing date forward before renewing.');
    const p = JOB_PLANS[plan];
    const payment = await kit.createPayment({
      user: ctx.user, purpose: 'job_listing', subjectId: j.id, amountNgn: p.priceNgn,
      description: `Renewal, ${p.label}: ${j.title}`, meta: { kind: 'renew', plan }, returnPath: 'jobs:mine'
    });
    return { checkoutUrl: payment.checkout_url, reference: payment.reference, amountNgn: p.priceNgn };
  }, { auth: true });

  fulfil.job_listing = (payment) => {
    kit.ledger.recordPlatformIncome({ purpose: 'job_listing', sourceId: payment.subject_id, payment });
    const meta = parseJson(payment.meta, {});
    const j = db.get('SELECT * FROM jobs WHERE id = ?', payment.subject_id);
    if (!j) return;
    if (meta.kind === 'renew') {
      const from = j.expires_at && j.expires_at > now() ? new Date(j.expires_at).getTime() : Date.now();
      const expires = new Date(from + JOB_PLANS[meta.plan].days * DAY).toISOString();
      db.run("UPDATE jobs SET status = 'published', plan = ?, expires_at = ?, updated_at = ? WHERE id = ?", meta.plan, expires, now(), j.id);
      notify(j.employer_id, 'job', 'Listing renewed', `“${j.title}” is live until ${expires.slice(0, 10)}.`, 'jobs:mine');
    } else {
      db.run("UPDATE jobs SET status = 'under_review', plan = ?, updated_at = ? WHERE id = ?", meta.plan || j.plan, now(), j.id);
      notify(j.employer_id, 'job', 'Listing sent for review', `We’ll check “${j.title}” and publish it, usually within one working day.`, 'jobs:mine');
      for (const a of db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'"))
        notify(a.id, 'review', 'Job listing waiting for review', j.title, 'admin:jobs');
    }
  };
  fulfil['job_listing:failed'] = (payment) => {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', payment.subject_id);
    if (j?.status === 'payment_pending') db.run("UPDATE jobs SET status='draft', updated_at=? WHERE id=?", now(), j.id);
  };

  route('POST', '/api/jobs/:id/status', (ctx) => {
    requireActive(ctx);
    const j = ownJob(ctx, ctx.params.id);
    const action = oneOf(ctx.body.action, ['pause', 'resume', 'close'], 'Action');
    const allowed = { pause: ['published'], resume: ['paused'], close: ['published', 'paused', 'draft', 'rejected', 'expired', 'payment_pending'] };
    if (!allowed[action].includes(j.status)) throw bad(`You can’t ${action} a listing that is ${j.status.replace('_', ' ')}.`);
    const next = { pause: 'paused', resume: 'published', close: 'closed' }[action];
    if (action === 'resume' && j.expires_at && j.expires_at < now()) throw bad('This listing has expired. Renew it instead.');
    db.run('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', next, now(), j.id);
    if (action === 'close') {
      for (const a of db.all("SELECT applicant_id FROM job_applications WHERE job_id = ? AND status IN ('submitted','reviewing','shortlisted','interview')", j.id))
        notify(a.applicant_id, 'application', 'A job you applied for has closed', j.title, 'jobs:applications');
    }
    return { status: next };
  }, { auth: true });

  route('GET', '/api/me/jobs', (ctx) => ({
    jobs: db
      .all(`${SELECT_JOB} WHERE j.employer_id = :viewer AND j.status != 'archived' ORDER BY j.created_at DESC`, { viewer: ctx.user.id })
      .map((j) => jobView(j, ctx.user.id))
  }), { auth: true });

  /* ---------- jobseeker profile & CV ---------- */
  const profileView = (p, cv) => ({
    headline: p?.headline ?? '',
    skills: parseJson(p?.skills, []),
    experience: p?.experience ?? '',
    qualifications: p?.qualifications ?? '',
    preferredLocations: p?.preferred_locations ?? '',
    visibility: p?.visibility ?? 'employers',
    jobAlerts: p ? !!p.job_alerts : true,
    cv: cv ? { id: cv.id, filename: cv.filename, sizeBytes: cv.size_bytes, uploadedAt: cv.created_at } : null
  });

  route('GET', '/api/me/jobseeker', (ctx) => {
    const p = db.get('SELECT * FROM jobseeker_profiles WHERE user_id = ?', ctx.user.id);
    const cv = p?.cv_file_id ? db.get('SELECT * FROM files WHERE id = ?', p.cv_file_id) : null;
    return { profile: profileView(p, cv) };
  }, { auth: true });

  route('PUT', '/api/me/jobseeker', (ctx) => {
    const b = ctx.body;
    const skills = Array.isArray(b.skills) ? b.skills.map((s) => str(String(s), 'Skill', { max: 40 })).filter(Boolean).slice(0, 25) : [];
    const p = {
      headline: str(b.headline, 'Headline', { max: 120 }),
      experience: str(b.experience, 'Experience', { max: 4000 }),
      qualifications: str(b.qualifications, 'Qualifications', { max: 2000 }),
      preferred: str(b.preferredLocations, 'Preferred locations', { max: 200 }),
      visibility: oneOf(b.visibility || 'employers', ['employers', 'hidden'], 'Visibility'),
      alerts: b.jobAlerts === false ? 0 : 1
    };
    db.run(
      `INSERT INTO jobseeker_profiles (user_id, headline, skills, experience, qualifications, preferred_locations, visibility, job_alerts, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline, skills=excluded.skills, experience=excluded.experience,
         qualifications=excluded.qualifications, preferred_locations=excluded.preferred_locations, visibility=excluded.visibility,
         job_alerts=excluded.job_alerts, updated_at=excluded.updated_at`,
      ctx.user.id, p.headline, JSON.stringify(skills), p.experience, p.qualifications, p.preferred, p.visibility, p.alerts, now()
    );
    const row = db.get('SELECT * FROM jobseeker_profiles WHERE user_id = ?', ctx.user.id);
    const cv = row.cv_file_id ? db.get('SELECT * FROM files WHERE id = ?', row.cv_file_id) : null;
    return { profile: profileView(row, cv) };
  }, { auth: true });

  // Upload a CV as the raw request body. The filename travels in X-Filename.
  route('POST', '/api/files/cv', (ctx) => {
    requireActive(ctx);
    if (!kit.limit(`cv:${ctx.user.id}`, 20, 3600_000)) throw new HttpError(429, 'rate_limited', 'Too many uploads. Try again later.');
    const buf = ctx.rawBody;
    const isPdf = buf.subarray(0, 5).toString() === '%PDF-';
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // .docx
    const isOle = buf[0] === 0xd0 && buf[1] === 0xcf; // .doc
    const ok = { '.pdf': isPdf, '.docx': isZip, '.doc': isOle }[CV_TYPES[ctx.contentType]];
    if (!ok) throw bad('The file doesn’t look like a real PDF or Word document.');
    const id = newId();
    const raw = decodeURIComponent(String(ctx.req.headers['x-filename'] || `cv${CV_TYPES[ctx.contentType]}`));
    const filename = raw.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'cv';
    mkdirSync(cfg.uploadDir, { recursive: true });
    writeFileSync(join(cfg.uploadDir, id), buf);
    db.run(
      'INSERT INTO files (id, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.user.id, 'cv', filename, ctx.contentType, buf.length, createHash('sha256').update(buf).digest('hex'), id, now()
    );
    db.run(
      `INSERT INTO jobseeker_profiles (user_id, cv_file_id, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET cv_file_id = excluded.cv_file_id, updated_at = excluded.updated_at`,
      ctx.user.id, id, now()
    );
    return { status: 201, body: { file: { id, filename, sizeBytes: buf.length } } };
  }, { auth: true, raw: { types: Object.keys(CV_TYPES), maxBytes: MAX_CV_BYTES } });

  // CVs are private: the owner, admins, and employers the person applied to with that CV.
  route('GET', '/api/files/:id', (ctx) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', ctx.params.id);
    const allowed =
      f &&
      (f.owner_id === ctx.user.id ||
        ctx.user.role === 'admin' ||
        // Business verification documents: also the business's admins.
        (f.kind === 'business_evidence' && db.get("SELECT 1 FROM business_members WHERE business_id = ? AND user_id = ? AND role = 'admin'", f.owner_id, ctx.user.id)) ||
        db.get(
          `SELECT 1 FROM job_applications a JOIN jobs j ON j.id = a.job_id
           WHERE a.cv_file_id = ? AND j.employer_id = ? AND a.status != 'withdrawn'`,
          f.id, ctx.user.id
        ));
    if (!allowed) throw new HttpError(404, 'not_found', 'File not found.');
    const path = join(cfg.uploadDir, f.storage_key);
    if (!existsSync(path)) throw new HttpError(404, 'not_found', 'File not found.');
    if (f.owner_id !== ctx.user.id) audit(ctx, 'file.cv_downloaded', 'file', f.id, { owner: f.owner_id });
    return { file: { buffer: readFileSync(path), mime: f.mime, filename: f.filename } };
  }, { auth: true });

  /* ---------- applications ---------- */
  route('POST', '/api/jobs/:id/apply', (ctx) => {
    requireVerified(ctx);
    const j = getJob(ctx.params.id, ctx.user);
    if (j.status !== 'published' || j.closing_date < today()) throw bad('This job is no longer taking applications.');
    if (j.employer_id === ctx.user.id) throw bad('You can’t apply to your own listing.');
    if (j.apply_method === 'external') throw bad('This employer takes applications on their own site. Use the link on the listing.');
    if (db.get("SELECT 1 FROM job_applications WHERE job_id=? AND applicant_id=? AND status != 'withdrawn'", j.id, ctx.user.id))
      throw new HttpError(409, 'already_applied', 'You’ve already applied for this job.');
    const coverNote = str(ctx.body.coverNote, 'Cover note', { max: 3000 });
    let cvId = ctx.body.cvFileId || null;
    if (cvId && !db.get("SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND kind='cv'", cvId, ctx.user.id)) throw bad('Choose a CV you uploaded.');
    if (!cvId) cvId = db.get('SELECT cv_file_id FROM jobseeker_profiles WHERE user_id = ?', ctx.user.id)?.cv_file_id ?? null;
    if (!cvId && coverNote.length < 30) throw bad('Upload a CV or write at least a few lines about your experience.');
    const id = newId();
    db.run(
      `INSERT INTO job_applications (id, job_id, applicant_id, cover_note, cv_file_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(job_id, applicant_id) DO UPDATE SET cover_note=excluded.cover_note, cv_file_id=excluded.cv_file_id, status='submitted', updated_at=excluded.updated_at`,
      id, j.id, ctx.user.id, coverNote, cvId, now(), now()
    );
    notify(j.employer_id, 'application', `New application: ${j.title}`, `${ctx.user.name} applied.`, 'jobs:mine');
    return { status: 201, body: { application: { id, status: 'submitted' } } };
  }, { auth: true });

  route('GET', '/api/me/applications', (ctx) => ({
    applications: db
      .all(
        `SELECT a.*, j.title, j.location, j.status AS job_status, u.name AS employer_name
         FROM job_applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = j.employer_id
         WHERE a.applicant_id = ? ORDER BY a.updated_at DESC`,
        ctx.user.id
      )
      .map((a) => ({
        id: a.id, jobId: a.job_id, title: a.title, employer: a.employer_name, location: a.location,
        status: a.status, jobStatus: a.job_status, createdAt: a.created_at, updatedAt: a.updated_at
      }))
  }), { auth: true });

  route('POST', '/api/applications/:id/withdraw', (ctx) => {
    const a = db.get('SELECT * FROM job_applications WHERE id = ? AND applicant_id = ?', ctx.params.id, ctx.user.id);
    if (!a) throw new HttpError(404, 'not_found', 'Application not found.');
    if (['hired', 'rejected', 'withdrawn'].includes(a.status)) throw bad('This application is already closed.');
    db.run("UPDATE job_applications SET status='withdrawn', updated_at=? WHERE id=?", now(), a.id);
    return { status: 'withdrawn' };
  }, { auth: true });

  // Employers see applicants only for their own listings (PRD §25.2).
  route('GET', '/api/jobs/:id/applications', (ctx) => {
    const j = ownJob(ctx, ctx.params.id);
    const rows = db.all(
      `SELECT a.*, u.name, u.email, u.location, u.title AS user_title, p.headline, p.skills, p.experience, p.qualifications,
              f.filename AS cv_name
       FROM job_applications a JOIN users u ON u.id = a.applicant_id
       LEFT JOIN jobseeker_profiles p ON p.user_id = a.applicant_id
       LEFT JOIN files f ON f.id = a.cv_file_id
       WHERE a.job_id = ? AND a.status != 'withdrawn' ORDER BY a.created_at ASC`,
      j.id
    );
    return {
      applications: rows.map((a) => ({
        id: a.id, status: a.status, coverNote: a.cover_note, employerNote: a.employer_note, createdAt: a.created_at,
        applicant: {
          id: a.applicant_id, name: a.name, email: a.email, location: a.location, headline: a.headline || a.user_title || '',
          skills: parseJson(a.skills, []), experience: a.experience || '', qualifications: a.qualifications || ''
        },
        cv: a.cv_file_id ? { id: a.cv_file_id, filename: a.cv_name } : null
      }))
    };
  }, { auth: true });

  route('PATCH', '/api/applications/:id', (ctx) => {
    const a = db.get('SELECT a.*, j.employer_id, j.title FROM job_applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', ctx.params.id);
    if (!a || (a.employer_id !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'not_found', 'Application not found.');
    if (a.status === 'withdrawn') throw bad('The candidate withdrew this application.');
    const status = oneOf(ctx.body.status, APP_STATUSES, 'Status');
    const note = str(ctx.body.note, 'Note', { max: 1000 });
    db.run('UPDATE job_applications SET status=?, employer_note=?, updated_at=? WHERE id=?', status, note, now(), a.id);
    if (status !== a.status) {
      const label = { reviewing: 'is being reviewed', shortlisted: 'has been shortlisted', interview: 'has moved to interview', offered: 'has an offer', hired: 'was successful', rejected: 'was not successful', submitted: 'was received' }[status];
      notify(a.applicant_id, 'application', `Your application ${label}`, a.title + (note ? ` · ${note}` : ''), 'jobs:applications');
    }
    return { status };
  }, { auth: true });

  /* ---------- admin review ---------- */
  route('GET', '/api/admin/jobs', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'under_review', ['under_review', 'published', 'rejected', 'payment_pending'], 'Status');
    return {
      jobs: db
        .all(`${SELECT_JOB} WHERE j.status = :status ORDER BY j.updated_at ASC LIMIT 200`, { status, viewer: ctx.user.id })
        .map((j) => jobView(j, ctx.user.id))
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/jobs/:id/review', (ctx) => {
    const j = db.get('SELECT * FROM jobs WHERE id = ?', ctx.params.id);
    if (!j) throw new HttpError(404, 'not_found', 'Job not found.');
    if (j.status !== 'under_review') throw new HttpError(409, 'not_in_review', 'This listing isn’t waiting for review.');
    const decision = oneOf(ctx.body.decision, ['approve', 'reject'], 'Decision');
    const note = str(ctx.body.note, 'Note', { min: decision === 'reject' ? 5 : 0, max: 1000 });
    db.tx(() => {
      if (decision === 'approve') {
        const plan = JOB_PLANS[j.plan] || JOB_PLANS.standard;
        // Paid time starts at first approval; re-approval after an edit keeps the original expiry.
        const expires = j.expires_at || new Date(Date.now() + plan.days * DAY).toISOString();
        db.run("UPDATE jobs SET status='published', published_at=COALESCE(published_at, ?), expires_at=?, review_note=?, reviewed_by=?, updated_at=? WHERE id=?",
          now(), expires, note, ctx.user.id, now(), j.id);
        notify(j.employer_id, 'job', 'Your job is live', `“${j.title}” is published until ${expires.slice(0, 10)}.`, 'jobs:mine');
        if (!j.published_at) sendJobAlerts(j);
      } else {
        db.run("UPDATE jobs SET status='rejected', review_note=?, reviewed_by=?, updated_at=? WHERE id=?", note, ctx.user.id, now(), j.id);
        notify(j.employer_id, 'job', 'Your job listing needs changes', `${j.title}: ${note} Edit and resubmit it at no extra cost.`, 'jobs:mine');
      }
      audit(ctx, `job.${decision === 'approve' ? 'approved' : 'rejected'}`, 'job', j.id, { note });
    });
    return { ok: true };
  }, { roles: ['admin'] });

  // Opt-in alerts for people looking for work (PRD §25.1, §31).
  function sendJobAlerts(j) {
    const seekers = db.all(
      `SELECT DISTINCT u.id FROM users u LEFT JOIN jobseeker_profiles p ON p.user_id = u.id
       WHERE u.status = 'active' AND u.id != ? AND COALESCE(p.job_alerts, 1) = 1
         AND (p.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM follows f WHERE f.user_id = u.id AND f.target_type='topic' AND f.target='careers')
              OR u.goals LIKE '%find-a-job%')
       LIMIT 500`,
      j.employer_id
    );
    for (const s of seekers) notify(s.id, 'job_alert', 'New job that may suit you', `${j.title} · ${j.location}`, `job:${j.id}`);
  }

  /* ---------- scheduled: expire listings ---------- */
  kit.ticks.push(() => {
    const due = db.all(
      "SELECT * FROM jobs WHERE status IN ('published','paused') AND ((expires_at IS NOT NULL AND expires_at <= ?) OR closing_date < ?)",
      now(), today()
    );
    for (const j of due) {
      db.run("UPDATE jobs SET status='expired', updated_at=? WHERE id=?", now(), j.id);
      notify(j.employer_id, 'job', 'Your job listing has expired', `“${j.title}” is no longer shown. Renew it from My jobs if you’re still hiring.`, 'jobs:mine');
    }
  });
}
