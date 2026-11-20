// Agro Inspo API · Phase 1 (Foundation)
// Accounts, onboarding, profiles, community feed, safety tools, notifications, admin and audit.
// Every permission check happens here on the server (PRD §34); the UI only mirrors it.
import {
  hashPassword,
  verifyPassword,
  newToken,
  sha256,
  newId,
  now,
  inFuture,
  createRateLimiter
} from './security.js';
import { fileURLToPath } from 'node:url';
import { createPaymentProvider } from './payments.js';
import { createVideoProvider } from './video.js';
import { registerPayments } from './routes/payments.js';
import { registerJobs } from './routes/jobs.js';
import { registerEvents } from './routes/events.js';
import { registerInvestment } from './routes/investment.js';
import { registerConsultations } from './routes/consultations.js';
import { registerFinance } from './routes/finance.js';
import { registerBooks } from './routes/books.js';
import { registerCreators } from './routes/creators.js';
import { registerMessages } from './routes/messages.js';
import { registerBusiness } from './routes/business.js';
import { registerAds } from './routes/ads.js';
import { registerSponsorships } from './routes/sponsorships.js';
import { registerTeam } from './routes/team.js';
import { createLedger } from './ledger.js';

export const ROLES = ['enthusiast', 'farmer', 'specialist', 'business', 'admin'];
export const SELF_SERVE_ROLES = ['enthusiast', 'farmer', 'specialist', 'business'];
export const TOPICS = [
  'crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture',
  'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'
];
export const GOALS = [
  'learn-farming', 'find-a-job', 'hire-workers', 'get-expert-advice', 'offer-consulting',
  'grow-my-business', 'find-partners'
];
const REPORT_REASONS = ['spam', 'scam', 'harassment', 'misinformation', 'inappropriate', 'other'];
const DEFAULT_PRIVACY = { profileVisibility: 'members', showLocation: true, showActivity: true };
const DEFAULT_NOTIF = { comments: true, likes: true, follows: true, email: true };

const SESSION_COOKIE = 'ai_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const VERIFY_TTL = 48 * 3600 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const MAX_BODY = 100 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const bad = (message, code = 'invalid_input') => new HttpError(400, code, message);

/* ---------- validation ---------- */
export function str(v, name, { min = 0, max = 500, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required && min > 0) throw bad(`${name} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${name} must be text.`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
}
export function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`);
  return v;
}
export function listOf(v, allowed, name, max = 20) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max) throw bad(`${name} must be a list of up to ${max} items.`);
  const out = [...new Set(v)];
  for (const x of out) if (!allowed.includes(x)) throw bad(`Unknown ${name} value: ${x}.`);
  return out;
}
function email(v) {
  const s = str(v, 'Email', { min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Enter a valid email address.');
  return s;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 10) throw bad('Password must be at least 10 characters.');
  if (v.length > 200) throw bad('Password is too long.');
  return v;
}
export const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/* ---------- serialisers ---------- */
function meView(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    title: u.title,
    location: u.location,
    bio: u.bio,
    avatarUrl: u.avatar_url,
    interests: parseJson(u.interests, []),
    goals: parseJson(u.goals, []),
    privacy: { ...DEFAULT_PRIVACY, ...parseJson(u.privacy, {}) },
    notificationPrefs: { ...DEFAULT_NOTIF, ...parseJson(u.notif_prefs, {}) },
    emailVerified: !!u.email_verified,
    onboarded: !!u.onboarded,
    status: u.status,
    createdAt: u.created_at
  };
}
function publicView(u, viewer) {
  const privacy = { ...DEFAULT_PRIVACY, ...parseJson(u.privacy, {}) };
  const self = viewer && viewer.id === u.id;
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    title: u.title,
    avatarUrl: u.avatar_url,
    location: self || privacy.showLocation ? u.location : '',
    bio: u.bio,
    interests: self || privacy.showActivity ? parseJson(u.interests, []) : []
  };
}
const authorOf = (row) => ({
  id: row.author_id,
  name: row.author_name,
  role: row.author_role,
  title: row.author_title,
  avatarUrl: row.author_avatar
});

/* ---------- app ---------- */
export function createApp({ db, mailer, payments, video, config = {} }) {
  payments = payments || createPaymentProvider();
  video = video || createVideoProvider();
  const cfg = {
    appUrl: config.appUrl || process.env.APP_URL || 'http://localhost:3000',
    allowedOrigins: config.allowedOrigins || (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:8787').split(','),
    secureCookies: config.secureCookies ?? process.env.NODE_ENV === 'production',
    exposeDevLinks: config.exposeDevLinks ?? process.env.NODE_ENV !== 'production',
    ipRateLimits: config.ipRateLimits ?? true,
    uploadDir: config.uploadDir || process.env.UPLOAD_DIR || fileURLToPath(new URL('../data/uploads/', import.meta.url))
  };
  const limit = createRateLimiter();
  const routes = [];
  const route = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, opts });
  };

  /* ----- helpers bound to db ----- */
  const audit = (ctx, action, targetType = '', targetId = '', details = {}) =>
    db.run(
      'INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
      newId(), ctx.user?.id ?? null, action, targetType, targetId, JSON.stringify(details), ctx.ip, now()
    );

  function notify(userId, kind, title, body = '', link = '') {
    const u = db.get('SELECT notif_prefs FROM users WHERE id = ?', userId);
    if (!u) return;
    const prefs = { ...DEFAULT_NOTIF, ...parseJson(u.notif_prefs, {}) };
    const prefKey = { comment: 'comments', reply: 'comments', like: 'likes', follow: 'follows' }[kind];
    if (prefKey && prefs[prefKey] === false) return;
    db.run(
      'INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)',
      newId(), userId, kind, title, body, link, now()
    );
  }

  function issueToken(userId, kind, ttl) {
    db.run('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL', now(), userId, kind);
    const t = newToken();
    db.run(
      'INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at, created_at) VALUES (?,?,?,?,?)',
      t.hash, userId, kind, inFuture(ttl), now()
    );
    return t.token;
  }
  function consumeToken(token, kind) {
    if (typeof token !== 'string' || token.length < 20) throw bad('This link is invalid.', 'invalid_token');
    const row = db.get('SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?', sha256(token), kind);
    if (!row || row.used_at) throw bad('This link has already been used or is invalid.', 'invalid_token');
    if (row.expires_at < now()) throw bad('This link has expired. Request a new one.', 'expired_token');
    db.run('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?', now(), row.token_hash);
    return row.user_id;
  }

  async function sendVerification(user) {
    const token = issueToken(user.id, 'verify_email', VERIFY_TTL);
    const link = `${cfg.appUrl}/?verify=${token}`;
    await mailer.send({
      to: user.email,
      subject: 'Confirm your Agro Inspo email',
      text: `Hi ${user.name},\n\nConfirm your email address to start posting and booking on Agro Inspo:\n${link}\n\nThis link expires in 48 hours.`
    });
    return link;
  }

  function startSession(ctx, userId) {
    const t = newToken();
    db.run(
      'INSERT INTO sessions (id, user_id, expires_at, created_at, user_agent) VALUES (?,?,?,?,?)',
      t.hash, userId, inFuture(SESSION_TTL), now(), String(ctx.req.headers['user-agent'] || '').slice(0, 200)
    );
    ctx.setCookie(SESSION_COOKIE, t.token, SESSION_TTL / 1000);
  }

  const visibleAuthorsClause = `
    p.author_id NOT IN (SELECT target_user_id FROM user_blocks WHERE user_id = :viewer)
    AND p.author_id NOT IN (SELECT user_id FROM user_blocks WHERE target_user_id = :viewer AND kind = 'block')`;

  function loadPosts(viewerId, where = '1=1', params = {}, limitN = 20) {
    return db.all(
      `SELECT p.*, u.name AS author_name, u.role AS author_role, u.title AS author_title, u.avatar_url AS author_avatar,
         (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'published') AS comment_count,
         EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = :viewer) AS liked,
         EXISTS (SELECT 1 FROM post_saves s WHERE s.post_id = p.id AND s.user_id = :viewer) AS saved,
         EXISTS (SELECT 1 FROM creator_topics ct WHERE ct.user_id = p.author_id AND ct.topic = p.topic AND ct.revoked_at IS NULL) AS screened
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.status = 'published' AND u.status = 'active' AND ${visibleAuthorsClause} AND ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${Number(limitN) + 1}`,
      { viewer: viewerId ?? '', ...params }
    ).map((r) => ({
      id: r.id,
      topic: r.topic,
      body: r.body,
      imageUrl: r.image_url,
      isSponsored: !!r.is_sponsored,
      createdAt: r.created_at,
      author: authorOf(r),
      likeCount: r.like_count,
      commentCount: r.comment_count,
      liked: !!r.liked,
      saved: !!r.saved,
      kind: r.kind || 'discussion',
      authorScreenedForTopic: !!r.screened
    }));
  }

  function requireActive(ctx) {
    if (ctx.user.status === 'suspended')
      throw new HttpError(403, 'suspended', 'Your account is suspended. You can still view content and submit an appeal.');
  }
  function requireVerified(ctx) {
    requireActive(ctx);
    if (!ctx.user.email_verified)
      throw new HttpError(403, 'email_unverified', 'Confirm your email address before posting or commenting.');
  }
  // Moderation removal and restoration per content type.
  function removeTarget(type, id) {
    if (type === 'post' || type === 'comment') db.run(`UPDATE ${type === 'post' ? 'posts' : 'comments'} SET status = 'removed' WHERE id = ?`, id);
    if (type === 'job') db.run("UPDATE jobs SET status = 'archived', review_note = 'Removed by moderators', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'event') db.run("UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'ad') db.run("UPDATE ad_campaigns SET status = 'suspended', review_note = 'Removed after a report', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'listing') db.run("UPDATE business_listings SET status = 'removed', updated_at = ? WHERE id = ?", now(), id);
  }
  function restoreTarget(type, id) {
    if (type === 'post' || type === 'comment') db.run(`UPDATE ${type === 'post' ? 'posts' : 'comments'} SET status = 'published' WHERE id = ?`, id);
    if (type === 'job') db.run("UPDATE jobs SET status = 'published', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'event') db.run("UPDATE events SET status = 'scheduled', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'ad') db.run("UPDATE ad_campaigns SET status = 'approved', review_note = '', updated_at = ? WHERE id = ?", now(), id);
    if (type === 'listing') db.run("UPDATE business_listings SET status = 'published', updated_at = ? WHERE id = ?", now(), id);
  }

  function getPostOr404(id) {
    const p = db.get("SELECT * FROM posts WHERE id = ? AND status = 'published'", id);
    if (!p) throw new HttpError(404, 'not_found', 'This post no longer exists.');
    return p;
  }

  /* =========================================================
     AUTH
     ========================================================= */
  route('POST', '/api/auth/signup', async (ctx) => {
    const b = ctx.body;
    const role = oneOf(b.role, SELF_SERVE_ROLES, 'Role');
    const data = {
      name: str(b.name, 'Name', { min: 2, max: 80 }),
      email: email(b.email),
      password: password(b.password)
    };
    if (b.acceptTerms !== true) throw bad('Accept the Terms and Privacy Policy to continue.', 'terms_required');
    if (db.get('SELECT 1 FROM users WHERE email = ?', data.email))
      throw new HttpError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO users (id, email, password_hash, name, role, privacy, notif_prefs, terms_accepted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, data.email, hashPassword(data.password), data.name, role,
      JSON.stringify(DEFAULT_PRIVACY), JSON.stringify(DEFAULT_NOTIF), t, t, t
    );
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    ctx.user = user;
    audit(ctx, 'user.signup', 'user', id, { role });
    const link = await sendVerification(user);
    startSession(ctx, id);
    return { status: 201, body: { user: meView(user), ...(cfg.exposeDevLinks ? { devVerifyLink: link } : {}) } };
  }, { rate: [10, 60_000] });

  route('POST', '/api/auth/login', (ctx) => {
    const e = email(ctx.body.email);
    const p = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    if (!limit(`login:${e}`, 8, 15 * 60_000))
      throw new HttpError(429, 'rate_limited', 'Too many attempts for this account. Wait 15 minutes and try again.');
    const user = db.get('SELECT * FROM users WHERE email = ?', e);
    if (!user || !verifyPassword(p, user.password_hash))
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    ctx.user = user;
    startSession(ctx, user.id);
    audit(ctx, 'user.login', 'user', user.id);
    return { user: meView(user) };
  }, { rate: [20, 60_000] });

  route('POST', '/api/auth/logout', (ctx) => {
    if (ctx.sessionId) db.run('DELETE FROM sessions WHERE id = ?', ctx.sessionId);
    ctx.setCookie(SESSION_COOKIE, '', 0);
    return { ok: true };
  });

  route('GET', '/api/auth/me', (ctx) => ({ user: ctx.user ? { ...meView(ctx.user), team: kit.teamSummary(ctx.user) } : null }));

  route('POST', '/api/auth/verify-email', (ctx) => {
    const userId = consumeToken(ctx.body.token, 'verify_email');
    db.run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', now(), userId);
    ctx.user = ctx.user || { id: userId };
    audit(ctx, 'user.email_verified', 'user', userId);
    const user = db.get('SELECT * FROM users WHERE id = ?', userId);
    return { user: meView(user) };
  }, { rate: [20, 60_000] });

  route('POST', '/api/auth/resend-verification', async (ctx) => {
    if (ctx.user.email_verified) return { ok: true, alreadyVerified: true };
    if (!limit(`resend:${ctx.user.id}`, 3, 60 * 60_000))
      throw new HttpError(429, 'rate_limited', 'You can request 3 verification emails per hour.');
    const link = await sendVerification(ctx.user);
    return { ok: true, ...(cfg.exposeDevLinks ? { devVerifyLink: link } : {}) };
  }, { auth: true });

  route('POST', '/api/auth/request-reset', async (ctx) => {
    const e = email(ctx.body.email);
    const user = db.get('SELECT * FROM users WHERE email = ?', e);
    let link;
    // Same response whether or not the account exists, so emails can't be enumerated.
    if (user && limit(`reset:${user.id}`, 3, 60 * 60_000)) {
      const token = issueToken(user.id, 'reset_password', RESET_TTL);
      link = `${cfg.appUrl}/?reset=${token}`;
      await mailer.send({
        to: user.email,
        subject: 'Reset your Agro Inspo password',
        text: `Hi ${user.name},\n\nUse this link to choose a new password:\n${link}\n\nIt expires in 1 hour. If you didn't ask for this, ignore this email.`
      });
    }
    return { ok: true, ...(cfg.exposeDevLinks && link ? { devResetLink: link } : {}) };
  }, { rate: [10, 60_000] });

  route('POST', '/api/auth/reset-password', (ctx) => {
    const pw = password(ctx.body.password);
    const userId = consumeToken(ctx.body.token, 'reset_password');
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(pw), now(), userId);
      db.run('DELETE FROM sessions WHERE user_id = ?', userId); // sign out everywhere
    });
    ctx.user = { id: userId };
    audit(ctx, 'user.password_reset', 'user', userId);
    return { ok: true };
  }, { rate: [10, 60_000] });

  /* =========================================================
     PROFILE & ONBOARDING
     ========================================================= */
  route('GET', '/api/meta', () => ({ topics: TOPICS, goals: GOALS, roles: SELF_SERVE_ROLES, reportReasons: REPORT_REASONS }));

  route('PATCH', '/api/me', (ctx) => {
    const b = ctx.body;
    const u = ctx.user;
    const next = {
      name: b.name !== undefined ? str(b.name, 'Name', { min: 2, max: 80 }) : u.name,
      title: b.title !== undefined ? str(b.title, 'Title', { max: 120 }) : u.title,
      location: b.location !== undefined ? str(b.location, 'Location', { max: 120 }) : u.location,
      bio: b.bio !== undefined ? str(b.bio, 'Bio', { max: 1000 }) : u.bio,
      interests: listOf(b.interests, TOPICS, 'interest') ?? parseJson(u.interests, []),
      goals: listOf(b.goals, GOALS, 'goal') ?? parseJson(u.goals, []),
      privacy: { ...DEFAULT_PRIVACY, ...parseJson(u.privacy, {}) },
      notif: { ...DEFAULT_NOTIF, ...parseJson(u.notif_prefs, {}) }
    };
    if (b.privacy !== undefined) {
      if (typeof b.privacy !== 'object' || !b.privacy) throw bad('Privacy settings are malformed.');
      if (b.privacy.profileVisibility !== undefined)
        next.privacy.profileVisibility = oneOf(b.privacy.profileVisibility, ['public', 'members'], 'Profile visibility');
      for (const k of ['showLocation', 'showActivity'])
        if (b.privacy[k] !== undefined) next.privacy[k] = !!b.privacy[k];
    }
    if (b.notificationPrefs !== undefined) {
      if (typeof b.notificationPrefs !== 'object' || !b.notificationPrefs) throw bad('Notification settings are malformed.');
      for (const k of Object.keys(DEFAULT_NOTIF))
        if (b.notificationPrefs[k] !== undefined) next.notif[k] = !!b.notificationPrefs[k];
    }
    const onboarded = b.completeOnboarding === true ? 1 : u.onboarded;
    if (b.completeOnboarding === true && next.interests.length === 0)
      throw bad('Pick at least one interest so we can tailor your feed.');
    db.run(
      `UPDATE users SET name=?, title=?, location=?, bio=?, interests=?, goals=?, privacy=?, notif_prefs=?, onboarded=?, updated_at=? WHERE id=?`,
      next.name, next.title, next.location, next.bio, JSON.stringify(next.interests), JSON.stringify(next.goals),
      JSON.stringify(next.privacy), JSON.stringify(next.notif), onboarded, now(), u.id
    );
    if (b.completeOnboarding === true && !u.onboarded) {
      // Following your interests seeds a personalised feed.
      for (const topic of next.interests)
        db.run('INSERT OR IGNORE INTO follows (user_id, target_type, target, created_at) VALUES (?,?,?,?)', u.id, 'topic', topic, now());
    }
    return { user: meView(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
  }, { auth: true });

  route('POST', '/api/me/password', (ctx) => {
    if (!verifyPassword(String(ctx.body.currentPassword || ''), ctx.user.password_hash))
      throw new HttpError(400, 'invalid_credentials', 'Current password is incorrect.');
    const pw = password(ctx.body.newPassword);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(pw), now(), ctx.user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', ctx.user.id, ctx.sessionId);
    });
    audit(ctx, 'user.password_changed', 'user', ctx.user.id);
    return { ok: true };
  }, { auth: true, rate: [10, 60_000] });

  route('GET', '/api/users/:id', (ctx) => {
    const u = db.get("SELECT * FROM users WHERE id = ? AND status = 'active'", ctx.params.id);
    if (!u) throw new HttpError(404, 'not_found', 'This member could not be found.');
    const privacy = { ...DEFAULT_PRIVACY, ...parseJson(u.privacy, {}) };
    if (privacy.profileVisibility === 'members' && !ctx.user)
      throw new HttpError(401, 'login_required', 'Log in to view member profiles.');
    const blocked = ctx.user && db.get("SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ? AND kind = 'block'", u.id, ctx.user.id);
    if (blocked) throw new HttpError(404, 'not_found', 'This member could not be found.');
    const rel = ctx.user
      ? {
          following: !!db.get("SELECT 1 FROM follows WHERE user_id=? AND target_type='user' AND target=?", ctx.user.id, u.id),
          muted: !!db.get("SELECT 1 FROM user_blocks WHERE user_id=? AND target_user_id=? AND kind='mute'", ctx.user.id, u.id),
          blocked: !!db.get("SELECT 1 FROM user_blocks WHERE user_id=? AND target_user_id=? AND kind='block'", ctx.user.id, u.id)
        }
      : null;
    return { user: publicView(u, ctx.user), relationship: rel };
  });

  /* =========================================================
     FEED
     ========================================================= */
  route('GET', '/api/posts', (ctx) => {
    const q = ctx.query;
    const where = [];
    const params = {};
    if (q.get('topic')) {
      where.push('p.topic = :topic');
      params.topic = oneOf(q.get('topic'), TOPICS, 'Topic');
    }
    if (q.get('author')) {
      where.push('p.author_id = :author');
      params.author = q.get('author');
    }
    if (q.get('view') === 'following' && ctx.user) {
      where.push(`(p.topic IN (SELECT target FROM follows WHERE user_id = :viewer AND target_type='topic')
                  OR p.author_id IN (SELECT target FROM follows WHERE user_id = :viewer AND target_type='user')
                  OR p.author_id = :viewer)`);
    }
    if (q.get('view') === 'saved' && ctx.user) where.push('p.id IN (SELECT post_id FROM post_saves WHERE user_id = :viewer)');
    if (q.get('kind') === 'article') where.push("p.kind = 'article'");
    if (q.get('q')) {
      where.push('(p.body LIKE :q OR u.name LIKE :q)');
      params.q = `%${String(q.get('q')).slice(0, 80).replace(/[%_]/g, '')}%`;
    }
    if (q.get('before')) {
      where.push('p.created_at < :before');
      params.before = String(q.get('before'));
    }
    const pageSize = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 50);
    const rows = loadPosts(ctx.user?.id, where.join(' AND ') || '1=1', params, pageSize);
    const hasMore = rows.length > pageSize;
    const posts = rows.slice(0, pageSize);
    return { posts, nextBefore: hasMore ? posts[posts.length - 1].createdAt : null };
  });

  route('POST', '/api/posts', (ctx) => {
    requireVerified(ctx);
    if (!limit(`post:${ctx.user.id}`, 10, 60 * 60_000))
      throw new HttpError(429, 'rate_limited', 'You can publish up to 10 posts an hour.');
    const topic = oneOf(ctx.body.topic, TOPICS, 'Topic');
    const kind = oneOf(ctx.body.kind || 'discussion', ['discussion', 'article'], 'Post type');
    // Educational articles are creator-gated per topic (PRD §26); discussions are open to everyone verified.
    if (kind === 'article' && !kit.isCreator(ctx.user.id, topic))
      throw new HttpError(403, 'creator_required', 'Pass creator screening for this topic to publish articles. You can still post a discussion.');
    const body = str(ctx.body.body, 'Post', { min: kind === 'article' ? 300 : 2, max: kind === 'article' ? 20000 : 5000 });
    const id = newId();
    const t = now();
    db.run('INSERT INTO posts (id, author_id, topic, body, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, ctx.user.id, topic, body, kind, t, t);
    return { status: 201, body: { post: loadPosts(ctx.user.id, 'p.id = :id', { id }, 1)[0] } };
  }, { auth: true });

  route('DELETE', '/api/posts/:id', (ctx) => {
    const p = getPostOr404(ctx.params.id);
    const isAdmin = ctx.user.role === 'admin';
    if (p.author_id !== ctx.user.id && !isAdmin) throw new HttpError(403, 'forbidden', 'You can only delete your own posts.');
    db.run("UPDATE posts SET status = 'removed', updated_at = ? WHERE id = ?", now(), p.id);
    if (isAdmin && p.author_id !== ctx.user.id) audit(ctx, 'post.removed_by_admin', 'post', p.id);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/posts/:id/like', (ctx) => {
    requireActive(ctx);
    const p = getPostOr404(ctx.params.id);
    const existing = db.get('SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?', p.id, ctx.user.id);
    if (existing) db.run('DELETE FROM post_likes WHERE post_id=? AND user_id=?', p.id, ctx.user.id);
    else {
      db.run('INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)', p.id, ctx.user.id, now());
      if (p.author_id !== ctx.user.id) notify(p.author_id, 'like', `${ctx.user.name} liked your post`, p.body.slice(0, 120), `post:${p.id}`);
    }
    const count = db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', p.id).n;
    return { liked: !existing, likeCount: count };
  }, { auth: true });

  route('POST', '/api/posts/:id/save', (ctx) => {
    const p = getPostOr404(ctx.params.id);
    const existing = db.get('SELECT 1 FROM post_saves WHERE post_id=? AND user_id=?', p.id, ctx.user.id);
    if (existing) db.run('DELETE FROM post_saves WHERE post_id=? AND user_id=?', p.id, ctx.user.id);
    else db.run('INSERT INTO post_saves (post_id, user_id, created_at) VALUES (?,?,?)', p.id, ctx.user.id, now());
    return { saved: !existing };
  }, { auth: true });

  route('GET', '/api/posts/:id/comments', (ctx) => {
    getPostOr404(ctx.params.id);
    const viewer = ctx.user?.id ?? '';
    const rows = db.all(
      `SELECT c.*, u.name AS author_name, u.role AS author_role, u.title AS author_title, u.avatar_url AS author_avatar
       FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.post_id = :post AND c.status = 'published' AND u.status = 'active'
         AND c.author_id NOT IN (SELECT target_user_id FROM user_blocks WHERE user_id = :viewer)
         AND c.author_id NOT IN (SELECT user_id FROM user_blocks WHERE target_user_id = :viewer AND kind = 'block')
       ORDER BY c.created_at ASC LIMIT 500`,
      { post: ctx.params.id, viewer }
    );
    return {
      comments: rows.map((r) => ({ id: r.id, parentId: r.parent_id, body: r.body, createdAt: r.created_at, author: authorOf(r) }))
    };
  });

  route('POST', '/api/posts/:id/comments', (ctx) => {
    requireVerified(ctx);
    if (!limit(`comment:${ctx.user.id}`, 30, 10 * 60_000))
      throw new HttpError(429, 'rate_limited', 'You are commenting too quickly. Try again in a few minutes.');
    const p = getPostOr404(ctx.params.id);
    const blocked = db.get("SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ? AND kind = 'block'", p.author_id, ctx.user.id);
    if (blocked) throw new HttpError(403, 'forbidden', 'You can’t reply to this post.');
    const body = str(ctx.body.body, 'Comment', { min: 1, max: 2000 });
    let parent = null;
    if (ctx.body.parentId) {
      parent = db.get("SELECT * FROM comments WHERE id = ? AND post_id = ? AND status = 'published'", ctx.body.parentId, p.id);
      if (!parent) throw bad('The comment you are replying to no longer exists.');
      if (parent.parent_id) parent = db.get('SELECT * FROM comments WHERE id = ?', parent.parent_id); // keep threads one level deep
    }
    const id = newId();
    db.run(
      'INSERT INTO comments (id, post_id, author_id, parent_id, body, created_at) VALUES (?,?,?,?,?,?)',
      id, p.id, ctx.user.id, parent?.id ?? null, body, now()
    );
    if (p.author_id !== ctx.user.id) notify(p.author_id, 'comment', `${ctx.user.name} commented on your post`, body.slice(0, 140), `post:${p.id}`);
    if (parent && parent.author_id !== ctx.user.id && parent.author_id !== p.author_id)
      notify(parent.author_id, 'reply', `${ctx.user.name} replied to your comment`, body.slice(0, 140), `post:${p.id}`);
    const r = db.get(
      `SELECT c.*, u.name AS author_name, u.role AS author_role, u.title AS author_title, u.avatar_url AS author_avatar
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`, id
    );
    return { status: 201, body: { comment: { id, parentId: r.parent_id, body: r.body, createdAt: r.created_at, author: authorOf(r) } } };
  }, { auth: true });

  route('DELETE', '/api/comments/:id', (ctx) => {
    const c = db.get("SELECT * FROM comments WHERE id = ? AND status = 'published'", ctx.params.id);
    if (!c) throw new HttpError(404, 'not_found', 'This comment no longer exists.');
    if (c.author_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'You can only delete your own comments.');
    db.run("UPDATE comments SET status = 'removed' WHERE id = ?", c.id);
    if (c.author_id !== ctx.user.id) audit(ctx, 'comment.removed_by_admin', 'comment', c.id);
    return { ok: true };
  }, { auth: true });

  /* =========================================================
     FOLLOWS, BLOCKS, MUTES
     ========================================================= */
  route('GET', '/api/me/follows', (ctx) => ({
    topics: db.all("SELECT target FROM follows WHERE user_id=? AND target_type='topic'", ctx.user.id).map((r) => r.target),
    users: db.all(
      "SELECT u.id, u.name, u.title, u.role, u.avatar_url AS avatarUrl FROM follows f JOIN users u ON u.id = f.target WHERE f.user_id=? AND f.target_type='user'",
      ctx.user.id
    ),
    muted: db.all("SELECT u.id, u.name FROM user_blocks b JOIN users u ON u.id = b.target_user_id WHERE b.user_id=? AND b.kind='mute'", ctx.user.id),
    blocked: db.all("SELECT u.id, u.name FROM user_blocks b JOIN users u ON u.id = b.target_user_id WHERE b.user_id=? AND b.kind='block'", ctx.user.id)
  }), { auth: true });

  route('POST', '/api/follows', (ctx) => {
    const type = oneOf(ctx.body.type, ['topic', 'user'], 'Follow type');
    const target = String(ctx.body.target || '');
    if (type === 'topic') oneOf(target, TOPICS, 'Topic');
    else {
      if (target === ctx.user.id) throw bad('You can’t follow yourself.');
      if (!db.get("SELECT 1 FROM users WHERE id = ? AND status='active'", target)) throw new HttpError(404, 'not_found', 'Member not found.');
    }
    const existing = db.get('SELECT 1 FROM follows WHERE user_id=? AND target_type=? AND target=?', ctx.user.id, type, target);
    if (existing) db.run('DELETE FROM follows WHERE user_id=? AND target_type=? AND target=?', ctx.user.id, type, target);
    else {
      db.run('INSERT INTO follows (user_id, target_type, target, created_at) VALUES (?,?,?,?)', ctx.user.id, type, target, now());
      if (type === 'user') notify(target, 'follow', `${ctx.user.name} started following you`, '', `user:${ctx.user.id}`);
    }
    return { following: !existing };
  }, { auth: true });

  route('POST', '/api/blocks', (ctx) => {
    const kind = oneOf(ctx.body.kind, ['block', 'mute'], 'Kind');
    const target = String(ctx.body.userId || '');
    if (target === ctx.user.id) throw bad('You can’t block or mute yourself.');
    if (!db.get('SELECT 1 FROM users WHERE id = ?', target)) throw new HttpError(404, 'not_found', 'Member not found.');
    const existing = db.get('SELECT 1 FROM user_blocks WHERE user_id=? AND target_user_id=? AND kind=?', ctx.user.id, target, kind);
    if (existing) db.run('DELETE FROM user_blocks WHERE user_id=? AND target_user_id=? AND kind=?', ctx.user.id, target, kind);
    else {
      db.run('INSERT INTO user_blocks (user_id, target_user_id, kind, created_at) VALUES (?,?,?,?)', ctx.user.id, target, kind, now());
      if (kind === 'block')
        db.run("DELETE FROM follows WHERE target_type='user' AND ((user_id=? AND target=?) OR (user_id=? AND target=?))", ctx.user.id, target, target, ctx.user.id);
    }
    return { active: !existing, kind };
  }, { auth: true });

  /* =========================================================
     REPORTS & APPEALS
     ========================================================= */
  route('POST', '/api/reports', (ctx) => {
    const targetType = oneOf(ctx.body.targetType, ['post', 'comment', 'user', 'job', 'event', 'ad', 'listing'], 'Report target');
    const reason = oneOf(ctx.body.reason, REPORT_REASONS, 'Reason');
    const details = str(ctx.body.details, 'Details', { max: 1000 });
    const targetId = String(ctx.body.targetId || '');
    const table = { post: 'posts', comment: 'comments', user: 'users', job: 'jobs', event: 'events', ad: 'ad_campaigns', listing: 'business_listings' }[targetType];
    if (!db.get(`SELECT 1 FROM ${table} WHERE id = ?`, targetId)) throw new HttpError(404, 'not_found', 'The item you reported no longer exists.');
    if (!limit(`report:${ctx.user.id}`, 20, 60 * 60_000)) throw new HttpError(429, 'rate_limited', 'You have sent a lot of reports. Try again later.');
    const dup = db.get("SELECT id FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status='open'", ctx.user.id, targetType, targetId);
    if (dup) return { report: { id: dup.id, status: 'open' }, duplicate: true };
    const id = newId();
    db.run(
      'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) VALUES (?,?,?,?,?,?,?)',
      id, ctx.user.id, targetType, targetId, reason, details, now()
    );
    return { status: 201, body: { report: { id, status: 'open' } } };
  }, { auth: true });

  // Moderation decisions that affected me (so I can appeal them).
  route('GET', '/api/me/moderation', (ctx) => {
    const rows = db.all(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.action, r.resolution_note, r.resolved_at,
              a.id AS appeal_id, a.status AS appeal_status, a.decision_note AS appeal_note
       FROM reports r
       LEFT JOIN posts p ON r.target_type='post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type='comment' AND c.id = r.target_id
       LEFT JOIN jobs j ON r.target_type='job' AND j.id = r.target_id
       LEFT JOIN events e ON r.target_type='event' AND e.id = r.target_id
       LEFT JOIN ad_campaigns ad ON r.target_type='ad' AND ad.id = r.target_id
       LEFT JOIN business_listings bl ON r.target_type='listing' AND bl.id = r.target_id
       LEFT JOIN appeals a ON a.report_id = r.id AND a.user_id = :me
       WHERE r.status = 'actioned' AND (p.author_id = :me OR c.author_id = :me OR j.employer_id = :me OR e.host_id = :me OR ad.business_id = :me OR bl.business_id = :me OR (r.target_type='user' AND r.target_id = :me))
       ORDER BY r.resolved_at DESC`,
      { me: ctx.user.id }
    );
    return {
      decisions: rows.map((r) => ({
        reportId: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        action: r.action,
        note: r.resolution_note,
        decidedAt: r.resolved_at,
        appeal: r.appeal_id ? { id: r.appeal_id, status: r.appeal_status, note: r.appeal_note } : null
      }))
    };
  }, { auth: true });

  route('POST', '/api/appeals', (ctx) => {
    const reportId = String(ctx.body.reportId || '');
    const message = str(ctx.body.message, 'Appeal', { min: 10, max: 2000 });
    const mine = db.all(
      `SELECT r.id FROM reports r
       LEFT JOIN posts p ON r.target_type='post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type='comment' AND c.id = r.target_id
       LEFT JOIN jobs j ON r.target_type='job' AND j.id = r.target_id
       LEFT JOIN events e ON r.target_type='event' AND e.id = r.target_id
       LEFT JOIN ad_campaigns ad ON r.target_type='ad' AND ad.id = r.target_id
       LEFT JOIN business_listings bl ON r.target_type='listing' AND bl.id = r.target_id
       WHERE r.id = :id AND r.status='actioned' AND (p.author_id = :me OR c.author_id = :me OR j.employer_id = :me OR e.host_id = :me OR ad.business_id = :me OR bl.business_id = :me OR (r.target_type='user' AND r.target_id = :me))`,
      { id: reportId, me: ctx.user.id }
    );
    if (!mine.length) throw new HttpError(404, 'not_found', 'There is no moderation decision to appeal here.');
    if (db.get('SELECT 1 FROM appeals WHERE report_id=? AND user_id=?', reportId, ctx.user.id))
      throw new HttpError(409, 'already_appealed', 'You have already appealed this decision.');
    const id = newId();
    db.run('INSERT INTO appeals (id, report_id, user_id, message, created_at) VALUES (?,?,?,?,?)', id, reportId, ctx.user.id, message, now());
    audit(ctx, 'appeal.submitted', 'report', reportId);
    return { status: 201, body: { appeal: { id, status: 'open' } } };
  }, { auth: true });

  /* =========================================================
     NOTIFICATIONS
     ========================================================= */
  route('GET', '/api/notifications', (ctx) => {
    const rows = db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user.id);
    const unread = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', ctx.user.id).n;
    return {
      unread,
      notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at }))
    };
  }, { auth: true });

  route('POST', '/api/notifications/:id/read', (ctx) => {
    db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', now(), ctx.params.id, ctx.user.id);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/notifications/read-all', (ctx) => {
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user.id);
    return { ok: true };
  }, { auth: true });

  /* =========================================================
     ADMIN
     ========================================================= */
  route('GET', '/api/admin/overview', () => ({
    users: db.get('SELECT COUNT(*) AS n FROM users').n,
    verifiedUsers: db.get('SELECT COUNT(*) AS n FROM users WHERE email_verified = 1').n,
    suspended: db.get("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'").n,
    openReports: db.get("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").n,
    openAppeals: db.get("SELECT COUNT(*) AS n FROM appeals WHERE status = 'open'").n,
    posts: db.get("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'").n,
    byRole: db.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role')
  }), { roles: ['admin'] });

  route('GET', '/api/admin/users', (ctx) => {
    const q = ctx.query;
    const where = ['1=1'];
    const params = {};
    if (q.get('q')) {
      where.push('(u.name LIKE :q OR u.email LIKE :q)');
      params.q = `%${String(q.get('q')).slice(0, 80).replace(/[%_]/g, '')}%`;
    }
    if (q.get('role')) {
      where.push('u.role = :role');
      params.role = oneOf(q.get('role'), ROLES, 'Role');
    }
    if (q.get('status')) {
      where.push('u.status = :status');
      params.status = oneOf(q.get('status'), ['active', 'suspended'], 'Status');
    }
    const rows = db.all(
      `SELECT u.*, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS post_count,
              (SELECT COUNT(*) FROM reports r WHERE r.target_type='user' AND r.target_id = u.id) AS report_count
       FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT 200`,
      params
    );
    return {
      users: rows.map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
        emailVerified: !!u.email_verified, onboarded: !!u.onboarded, createdAt: u.created_at,
        postCount: u.post_count, reportCount: u.report_count
      }))
    };
  }, { roles: ['admin'] });

  route('PATCH', '/api/admin/users/:id', (ctx) => {
    const target = db.get('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw new HttpError(404, 'not_found', 'User not found.');
    if (target.id === ctx.user.id) throw bad('You can’t change your own role or status here.');
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 500 });
    const changes = {};
    if (ctx.body.role !== undefined) changes.role = oneOf(ctx.body.role, ROLES, 'Role');
    if (ctx.body.status !== undefined) changes.status = oneOf(ctx.body.status, ['active', 'suspended'], 'Status');
    if (!Object.keys(changes).length) throw bad('Nothing to change.');
    db.tx(() => {
      if (changes.role) db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', changes.role, now(), target.id);
      if (changes.status) {
        db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', changes.status, now(), target.id);
        if (changes.status === 'suspended')
          notify(target.id, 'moderation', 'Your account has been suspended', reason, 'settings:moderation');
        else notify(target.id, 'moderation', 'Your account has been reinstated', reason, '');
      }
      if (changes.role) audit(ctx, 'user.role_changed', 'user', target.id, { from: target.role, to: changes.role, reason });
      if (changes.status) audit(ctx, changes.status === 'suspended' ? 'user.suspended' : 'user.reinstated', 'user', target.id, { reason });
    });
    return { ok: true };
  }, { roles: ['admin'] });

  route('GET', '/api/admin/reports', (ctx) => {
    const status = ctx.query.get('status') || 'open';
    oneOf(status, ['open', 'actioned', 'dismissed'], 'Status');
    const rows = db.all(
      `SELECT r.*, ru.name AS reporter_name,
         CASE r.target_type
           WHEN 'post' THEN (SELECT body FROM posts WHERE id = r.target_id)
           WHEN 'comment' THEN (SELECT body FROM comments WHERE id = r.target_id)
           WHEN 'job' THEN (SELECT title || ' — ' || description FROM jobs WHERE id = r.target_id)
           WHEN 'event' THEN (SELECT title || ' — ' || description FROM events WHERE id = r.target_id)
           WHEN 'ad' THEN (SELECT 'Advert: ' || headline || ' — ' || body FROM ad_campaigns WHERE id = r.target_id)
           WHEN 'listing' THEN (SELECT 'Listing: ' || title || ' — ' || description FROM business_listings WHERE id = r.target_id)
           ELSE (SELECT name || ' · ' || email FROM users WHERE id = r.target_id) END AS target_preview,
         CASE r.target_type
           WHEN 'post' THEN (SELECT author_id FROM posts WHERE id = r.target_id)
           WHEN 'comment' THEN (SELECT author_id FROM comments WHERE id = r.target_id)
           WHEN 'job' THEN (SELECT employer_id FROM jobs WHERE id = r.target_id)
           WHEN 'event' THEN (SELECT host_id FROM events WHERE id = r.target_id)
           WHEN 'ad' THEN (SELECT business_id FROM ad_campaigns WHERE id = r.target_id)
           WHEN 'listing' THEN (SELECT business_id FROM business_listings WHERE id = r.target_id)
           ELSE r.target_id END AS target_owner_id
       FROM reports r JOIN users ru ON ru.id = r.reporter_id
       WHERE r.status = ? ORDER BY r.created_at ASC LIMIT 200`,
      status
    );
    return {
      reports: rows.map((r) => ({
        id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details,
        status: r.status, action: r.action, note: r.resolution_note, createdAt: r.created_at, resolvedAt: r.resolved_at,
        reporter: { id: r.reporter_id, name: r.reporter_name },
        targetPreview: String(r.target_preview || '').slice(0, 300), targetOwnerId: r.target_owner_id
      }))
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/reports/:id/resolve', (ctx) => {
    const r = db.get('SELECT * FROM reports WHERE id = ?', ctx.params.id);
    if (!r) throw new HttpError(404, 'not_found', 'Report not found.');
    if (r.status !== 'open') throw new HttpError(409, 'already_resolved', 'This report has already been resolved.');
    const action = oneOf(ctx.body.action, ['dismiss', 'remove_content', 'suspend_user'], 'Action');
    const note = str(ctx.body.note, 'Note', { min: 3, max: 1000 });
    if (action === 'remove_content' && r.target_type === 'user') throw bad('Use “suspend user” for reports about a member.');
    db.tx(() => {
      let ownerId = r.target_type === 'user' ? r.target_id : null;
      if (r.target_type === 'post') ownerId = db.get('SELECT author_id FROM posts WHERE id=?', r.target_id)?.author_id;
      if (r.target_type === 'comment') ownerId = db.get('SELECT author_id FROM comments WHERE id=?', r.target_id)?.author_id;
      if (r.target_type === 'job') ownerId = db.get('SELECT employer_id FROM jobs WHERE id=?', r.target_id)?.employer_id;
      if (r.target_type === 'event') ownerId = db.get('SELECT host_id FROM events WHERE id=?', r.target_id)?.host_id;
      if (r.target_type === 'ad') ownerId = db.get('SELECT business_id FROM ad_campaigns WHERE id=?', r.target_id)?.business_id;
      if (r.target_type === 'listing') ownerId = db.get('SELECT business_id FROM business_listings WHERE id=?', r.target_id)?.business_id;
      if (action === 'remove_content') removeTarget(r.target_type, r.target_id);
      if (action === 'suspend_user' && ownerId) {
        if (ownerId === ctx.user.id) throw bad('You can’t suspend yourself.');
        db.run("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", now(), ownerId);
        audit(ctx, 'user.suspended', 'user', ownerId, { reportId: r.id, reason: note });
      }
      const status = action === 'dismiss' ? 'dismissed' : 'actioned';
      // Other open reports on the same item resolve with the same decision.
      db.run(
        `UPDATE reports SET status = ?, action = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?
         WHERE target_type = ? AND target_id = ? AND status = 'open'`,
        status, action, note, ctx.user.id, now(), r.target_type, r.target_id
      );
      audit(ctx, `report.${action}`, r.target_type, r.target_id, { reportId: r.id, note });
      notify(r.reporter_id, 'moderation', 'We reviewed your report', action === 'dismiss'
        ? 'We didn’t find a breach of our community guidelines.'
        : 'We took action on the content you reported. Thank you.', '');
      if (action !== 'dismiss' && ownerId)
        notify(ownerId, 'moderation', action === 'suspend_user' ? 'Your account has been suspended' : 'Your content was removed',
          `${note} You can appeal this decision from Settings → Moderation.`, 'settings:moderation');
    });
    return { ok: true };
  }, { roles: ['admin'] });

  route('GET', '/api/admin/appeals', () => ({
    appeals: db.all(
      `SELECT a.*, u.name AS user_name, r.target_type, r.target_id, r.reason, r.action, r.resolution_note
       FROM appeals a JOIN users u ON u.id = a.user_id JOIN reports r ON r.id = a.report_id
       WHERE a.status = 'open' ORDER BY a.created_at ASC`
    ).map((a) => ({
      id: a.id, reportId: a.report_id, message: a.message, createdAt: a.created_at,
      user: { id: a.user_id, name: a.user_name },
      decision: { targetType: a.target_type, targetId: a.target_id, reason: a.reason, action: a.action, note: a.resolution_note }
    }))
  }), { roles: ['admin'] });

  route('POST', '/api/admin/appeals/:id/decide', (ctx) => {
    const a = db.get('SELECT a.*, r.target_type, r.target_id, r.action FROM appeals a JOIN reports r ON r.id = a.report_id WHERE a.id = ?', ctx.params.id);
    if (!a) throw new HttpError(404, 'not_found', 'Appeal not found.');
    if (a.status !== 'open') throw new HttpError(409, 'already_decided', 'This appeal has already been decided.');
    const decision = oneOf(ctx.body.decision, ['upheld', 'overturned'], 'Decision');
    const note = str(ctx.body.note, 'Note', { min: 3, max: 1000 });
    db.tx(() => {
      if (decision === 'overturned') {
        if (a.action === 'remove_content') restoreTarget(a.target_type, a.target_id);
        if (a.action === 'suspend_user') db.run("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", now(), a.user_id);
      }
      db.run('UPDATE appeals SET status = ?, decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?', decision, note, ctx.user.id, now(), a.id);
      audit(ctx, `appeal.${decision}`, 'appeal', a.id, { note });
      notify(a.user_id, 'moderation', decision === 'overturned' ? 'Your appeal was successful' : 'Your appeal was not successful', note, '');
    });
    return { ok: true };
  }, { roles: ['admin'] });

  route('GET', '/api/admin/audit', (ctx) => {
    const before = ctx.query.get('before');
    const rows = db.all(
      `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${before ? 'WHERE a.created_at < :before' : ''} ORDER BY a.created_at DESC LIMIT 100`,
      before ? { before } : {}
    );
    return {
      entries: rows.map((r) => ({
        id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id,
        details: parseJson(r.details, {}), ip: r.ip, createdAt: r.created_at,
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null
      }))
    };
  }, { roles: ['admin'] });

  // Development only: read the email outbox so flows can be tested without a provider.
  route('GET', '/api/dev/outbox', () => {
    if (!cfg.exposeDevLinks) throw new HttpError(404, 'not_found', 'Not found.');
    return { emails: db.all('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 50') };
  });

  /* ----- Phase 2+: modules share the same router, validation, auth and audit ----- */
  const kit = {
    db, mailer, cfg, route, audit, notify, limit, payments, video, HttpError, bad, str, oneOf, listOf, parseJson,
    requireActive, requireVerified, fulfil: {}, ticks: [], onEventCancelled: [], ledger: createLedger(db)
  };
  registerPayments(kit);
  registerJobs(kit);
  registerEvents(kit);
  registerInvestment(kit);
  registerConsultations(kit);
  registerFinance(kit);
  registerBooks(kit);
  registerCreators(kit);
  registerMessages(kit);
  registerTeam(kit);
  registerBusiness(kit);
  registerAds(kit);
  registerSponsorships(kit);

  route('GET', '/api/health', () => ({ ok: true }));

  /* ---------- request handling ---------- */
  function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  async function readRaw(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'too_large', `Files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
      chunks.push(chunk);
    }
    if (!size) throw bad('The file is empty.');
    return Buffer.concat(chunks);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request is too large.');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw bad('Request body must be a JSON object.');
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    const cookies = [];
    const ctx = {
      req,
      ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      query: url.searchParams,
      params: {},
      body: {},
      user: null,
      sessionId: null,
      setCookie(name, value, maxAgeSec) {
        cookies.push(
          `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}${cfg.secureCookies ? '; Secure' : ''}`
        );
      }
    };
    const send = (status, body) => {
      if (cookies.length) headers['Set-Cookie'] = cookies;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        const pathExists = routes.some((r) => r.re.test(url.pathname));
        throw new HttpError(pathExists ? 405 : 404, pathExists ? 'method_not_allowed' : 'not_found', 'Not found.');
      }
      const m = url.pathname.match(match.re);
      match.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));

      if (req.method !== 'GET') {
        // CSRF defence: JSON-only bodies plus an Origin allow-list (SameSite=Lax cookies do the rest).
        const origin = req.headers.origin;
        if (origin && !match.opts.webhook && !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'bad_origin', 'Request origin not allowed.');
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
        if (match.opts.raw) {
          // Binary uploads: only the declared types, size-capped, and never from another origin.
          if (!match.opts.raw.types.includes(ct)) throw new HttpError(415, 'unsupported_media', 'That file type isn’t allowed.');
          ctx.contentType = ct;
          ctx.rawBody = await readRaw(req, match.opts.raw.maxBytes);
        } else {
          if (hasBody && ct !== 'application/json') throw new HttpError(415, 'unsupported_media', 'Send JSON.');
          ctx.body = await readBody(req);
        }
      }

      if (cfg.ipRateLimits && match.opts.rate && !limit(`${ctx.ip}:${match.re}`, match.opts.rate[0], match.opts.rate[1]))
        throw new HttpError(429, 'rate_limited', 'Too many requests. Slow down and try again shortly.');

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) {
        const sid = sha256(token);
        const row = db.get(
          'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
          sid, now()
        );
        if (row) {
          ctx.user = row;
          ctx.sessionId = sid;
        }
      }
      if ((match.opts.auth || match.opts.roles) && !ctx.user)
        throw new HttpError(401, 'login_required', 'Log in to continue.');
      if (match.opts.roles && !match.opts.roles.includes(ctx.user.role))
        throw new HttpError(403, 'forbidden', 'You don’t have permission to do that.');

      const out = await match.handler(ctx);
      if (out && out.html !== undefined) {
        res.writeHead(out.status || 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
        });
        return res.end(out.html);
      }
      if (out && out.file) {
        res.writeHead(200, {
          'Content-Type': out.file.mime,
          'Content-Length': out.file.buffer.length,
          'Content-Disposition': `${out.file.inline ? 'inline' : 'attachment'}; filename="${out.file.filename.replace(/[^\w.\- ]/g, '_')}"`,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(out.file.buffer);
      }
      if (out && typeof out.status === 'number' && 'body' in out) send(out.status, out.body);
      else send(200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: { code: err.code, message: err.message } });
      else {
        console.error(err);
        send(500, { error: { code: 'server_error', message: 'Something went wrong on our side. Try again.' } });
      }
    }
  };
  /** Scheduled work (reminders, expiries). index.js calls this every minute. */
  handle.tick = async () => {
    for (const t of kit.ticks) {
      try {
        await t();
      } catch (err) {
        console.error('[tick]', err);
      }
    }
  };
  handle.kit = kit;
  return handle;
}
