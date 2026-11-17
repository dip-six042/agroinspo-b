// Business teams. The business account is the owner. Staff are separate member accounts who act
// for the business by sending an X-Business-Id header; every request is checked against their role,
// and the audit log records the person, not just the business.
import { newId, now } from '../security.js';

const DAY = 86400000;
export const TEAM_ROLES = {
  admin: { label: 'Admin', description: 'Everything except removing the owner: profile and verification, team, products, adverts, sponsorships, leads and payments.' },
  marketing: { label: 'Marketing', description: 'Products & services, adverts and event sponsorships, including paying for them. No access to leads or the team.' },
  sales: { label: 'Sales', description: 'Leads only: read enquiries, reply as the business and update their status.' }
};
const PERMS = {
  owner: ['view', 'profile', 'team', 'listings', 'ads', 'sponsorships', 'leads', 'billing'],
  admin: ['view', 'profile', 'team', 'listings', 'ads', 'sponsorships', 'leads', 'billing'],
  marketing: ['view', 'listings', 'ads', 'sponsorships'],
  sales: ['view', 'leads']
};
const PERM_WORDS = {
  view: 'open the business dashboard', profile: 'manage the business profile', team: 'manage the team', listings: 'manage products and services', ads: 'manage adverts',
  sponsorships: 'manage sponsorships', leads: 'see leads', billing: 'see payments'
};
const MAX_MEMBERS = 20;

export const permissionsFor = (role) => PERMS[role] ?? [];

export function registerTeam(kit) {
  const { db, route, audit, notify, mailer, cfg, HttpError, bad, str, oneOf, requireActive, requireVerified } = kit;

  const membership = (businessId, userId) => db.get('SELECT * FROM business_members WHERE business_id = ? AND user_id = ?', businessId, userId);

  /**
   * Resolves which business this request acts for and checks the caller's permission.
   * Returns { biz, role, actor }: biz is the business's user row, actor is the signed-in person.
   * Specialists act only for themselves (adverts, sponsorships and leads for their own practice).
   */
  kit.actingBusiness = (ctx, perm) => {
    requireActive(ctx);
    const header = String(ctx.req.headers['x-business-id'] || '');
    if (!header || header === ctx.user.id) {
      if (ctx.user.role === 'business') return { biz: ctx.user, role: 'owner', actor: ctx.user };
      if (ctx.user.role === 'specialist' && ['view', 'ads', 'sponsorships', 'leads', 'billing'].includes(perm)) return { biz: ctx.user, role: 'owner', actor: ctx.user };
      throw new HttpError(403, 'forbidden', 'Only business accounts and their team can do this.');
    }
    const m = membership(header, ctx.user.id);
    if (!m) throw new HttpError(403, 'not_team_member', 'You’re not on this business’s team.');
    const biz = db.get("SELECT * FROM users WHERE id = ? AND role = 'business'", header);
    if (!biz || biz.status !== 'active') throw new HttpError(403, 'forbidden', 'This business account isn’t active.');
    if (!PERMS[m.role].includes(perm)) throw new HttpError(403, 'role_forbidden', `Your role (${TEAM_ROLES[m.role].label}) can’t ${PERM_WORDS[perm]}. Ask an admin on the team.`);
    return { biz, role: m.role, actor: ctx.user };
  };
  /** Same as actingBusiness, but returns null instead of throwing (for pages that only adapt their view). */
  kit.maybeActingBusiness = (ctx, perm) => {
    if (!ctx.user) return null;
    try {
      return kit.actingBusiness(ctx, perm);
    } catch {
      return null;
    }
  };

  /** Notifies the business account and every team member whose role covers `perm`. */
  kit.notifyBusiness = (businessId, perm, kind, title, body, link) => {
    notify(businessId, kind, title, body, link);
    for (const m of db.all('SELECT user_id, role FROM business_members WHERE business_id = ?', businessId))
      if (PERMS[m.role].includes(perm)) notify(m.user_id, kind, title, body, `${link}:${businessId}`);
  };

  kit.teamSummary = (user) => ({
    memberOf: db.get(`SELECT COUNT(*) AS n FROM business_members m JOIN users b ON b.id = m.business_id WHERE m.user_id = ? AND b.status = 'active'`, user.id).n,
    invites: user.email_verified ? db.get("SELECT COUNT(*) AS n FROM business_invites WHERE email = ? AND status = 'pending' AND expires_at > ?", user.email.toLowerCase(), now()).n : 0
  });

  const bizName = (id) => kit.advertiserName(id);

  /* ---------- the businesses I can act for ---------- */
  route('GET', '/api/me/businesses', (ctx) => {
    const own = ctx.user.role === 'business' ? [{ id: ctx.user.id, name: bizName(ctx.user.id), role: 'owner', permissions: PERMS.owner }] : [];
    const staff = db.all(
      `SELECT m.business_id, m.role FROM business_members m JOIN users b ON b.id = m.business_id WHERE m.user_id = ? AND b.status = 'active' ORDER BY m.created_at`, ctx.user.id
    ).map((m) => ({ id: m.business_id, name: bizName(m.business_id), role: m.role, permissions: PERMS[m.role] }));
    const invites = ctx.user.email_verified
      ? db.all("SELECT * FROM business_invites WHERE email = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC", ctx.user.email.toLowerCase(), now())
          .map((i) => ({ id: i.id, business: { id: i.business_id, name: bizName(i.business_id) }, role: i.role, roleLabel: TEAM_ROLES[i.role].label,
            invitedBy: i.invited_by === i.business_id ? '' : db.get('SELECT name FROM users WHERE id = ?', i.invited_by)?.name ?? '', expiresAt: i.expires_at }))
      : [];
    return { businesses: [...own, ...staff], invites, emailVerified: !!ctx.user.email_verified, roles: TEAM_ROLES };
  }, { auth: true });

  route('POST', '/api/business-invites/:id/:action', (ctx) => {
    requireVerified(ctx);
    const action = oneOf(ctx.params.action, ['accept', 'decline'], 'Action');
    const i = db.get("SELECT * FROM business_invites WHERE id = ? AND status = 'pending'", ctx.params.id);
    // The invite must be addressed to this person's verified email address.
    if (!i || i.email !== ctx.user.email.toLowerCase()) throw new HttpError(404, 'not_found', 'Invitation not found.');
    if (i.expires_at < now()) {
      db.run("UPDATE business_invites SET status = 'expired' WHERE id = ?", i.id);
      throw bad('This invitation has expired. Ask the business to send a new one.');
    }
    if (action === 'accept') {
      if (ctx.user.role === 'admin') throw bad('Platform admin accounts can’t join a business team. Use a separate account.');
      if (ctx.user.id === i.business_id) throw bad('That’s your own business.');
      db.tx(() => {
        db.run('INSERT OR REPLACE INTO business_members (business_id, user_id, role, added_by, created_at) VALUES (?,?,?,?,?)', i.business_id, ctx.user.id, i.role, i.invited_by, now());
        db.run("UPDATE business_invites SET status = 'accepted', decided_at = ? WHERE id = ?", now(), i.id);
      });
      audit(ctx, 'business_team.joined', 'user', i.business_id, { role: i.role });
      kit.notifyBusiness(i.business_id, 'team', 'team', `${ctx.user.name} joined your team`, `Role: ${TEAM_ROLES[i.role].label}.`, 'business:team');
    } else {
      db.run("UPDATE business_invites SET status = 'declined', decided_at = ? WHERE id = ?", now(), i.id);
    }
    return { ok: true, businessId: i.business_id };
  }, { auth: true });

  route('POST', '/api/me/businesses/:id/leave', (ctx) => {
    const m = membership(ctx.params.id, ctx.user.id);
    if (!m) throw new HttpError(404, 'not_found', 'You’re not on this team.');
    db.run('DELETE FROM business_members WHERE business_id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    audit(ctx, 'business_team.left', 'user', ctx.params.id, { role: m.role });
    kit.notifyBusiness(ctx.params.id, 'team', 'team', `${ctx.user.name} left your team`, '', 'business:team');
    return { ok: true };
  }, { auth: true });

  /* ---------- team management (owner and admins) ---------- */
  const teamView = (bizId) => ({
    owner: (() => { const u = db.get('SELECT id, name, email FROM users WHERE id = ?', bizId); return { id: u.id, name: u.name, email: u.email }; })(),
    members: db.all(
      `SELECT m.*, u.name, u.email, u.status, a.name AS added_by_name FROM business_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN users a ON a.id = m.added_by WHERE m.business_id = ? ORDER BY m.created_at`, bizId
    ).map((m) => ({ id: m.user_id, name: m.name, email: m.email, role: m.role, status: m.status, addedBy: m.added_by_name, since: m.created_at })),
    invites: db.all("SELECT * FROM business_invites WHERE business_id = ? AND status = 'pending' ORDER BY created_at DESC", bizId)
      .map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, expired: i.expires_at < now() })),
    roles: TEAM_ROLES
  });

  route('GET', '/api/business/team', (ctx) => {
    const { biz, role } = kit.actingBusiness(ctx, 'team');
    return { ...teamView(biz.id), myRole: role };
  }, { auth: true });

  route('POST', '/api/business/team/invites', async (ctx) => {
    requireVerified(ctx);
    const { biz, role: myRole } = kit.actingBusiness(ctx, 'team');
    if (biz.role !== 'business') throw bad('Teams are for business accounts.');
    const email = str(ctx.body.email, 'Email', { min: 5, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    const role = oneOf(ctx.body.role, Object.keys(TEAM_ROLES), 'Role');
    if (role === 'admin' && myRole !== 'owner') throw new HttpError(403, 'role_forbidden', 'Only the business owner can add admins.');
    if (email === biz.email.toLowerCase()) throw bad('That’s the business account itself.');
    const existing = db.get('SELECT id, role FROM users WHERE lower(email) = ?', email);
    if (existing?.role === 'admin') throw bad('Platform admin accounts can’t join a business team.');
    if (existing && membership(biz.id, existing.id)) throw bad('This person is already on the team.');
    if (db.get('SELECT COUNT(*) AS n FROM business_members WHERE business_id = ?', biz.id).n >= MAX_MEMBERS) throw bad(`A team can have up to ${MAX_MEMBERS} members.`);
    if (!kit.limit(`invite:${biz.id}`, 30, DAY)) throw new HttpError(429, 'rate_limited', 'You’ve sent a lot of invitations today.');
    // Re-inviting the same address replaces the earlier pending invite.
    db.run("UPDATE business_invites SET status = 'revoked', decided_at = ? WHERE business_id = ? AND email = ? AND status = 'pending'", now(), biz.id, email);
    const id = newId();
    db.run('INSERT INTO business_invites (id, business_id, email, role, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
      id, biz.id, email, role, ctx.user.id, new Date(Date.now() + 14 * DAY).toISOString(), now());
    audit(ctx, 'business_team.invited', 'user', biz.id, { email, role });
    const name = bizName(biz.id);
    await mailer.send({
      to: email,
      subject: `${name} invited you to their team on Agro Inspo`,
      text: `${ctx.user.name} invited you to join ${name} on Agro Inspo as ${TEAM_ROLES[role].label}.\n\n${TEAM_ROLES[role].description}\n\n` +
        `Log in (or create a free account) with this email address, confirm your email, then open Business dashboard → Invitations: ${cfg.appUrl}/?view=business\n\n` +
        `The invitation expires in 14 days. If you weren’t expecting it, you can ignore this email.`
    });
    if (existing) notify(existing.id, 'team', `${name} invited you to their team`, `Role: ${TEAM_ROLES[role].label}. Accept from your Business dashboard.`, 'business:invites');
    return { status: 201, body: teamView(biz.id) };
  }, { auth: true });

  route('DELETE', '/api/business/team/invites/:id', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'team');
    const r = db.run("UPDATE business_invites SET status = 'revoked', decided_at = ? WHERE id = ? AND business_id = ? AND status = 'pending'", now(), ctx.params.id, biz.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Invitation not found.');
    audit(ctx, 'business_team.invite_revoked', 'user', biz.id, { invite: ctx.params.id });
    return teamView(biz.id);
  }, { auth: true });

  route('PATCH', '/api/business/team/:userId', (ctx) => {
    const { biz, role: myRole } = kit.actingBusiness(ctx, 'team');
    const m = membership(biz.id, ctx.params.userId);
    if (!m) throw new HttpError(404, 'not_found', 'Member not found.');
    const role = oneOf(ctx.body.role, Object.keys(TEAM_ROLES), 'Role');
    if ((role === 'admin' || m.role === 'admin') && myRole !== 'owner') throw new HttpError(403, 'role_forbidden', 'Only the business owner can add or change admins.');
    if (ctx.params.userId === ctx.user.id) throw bad('You can’t change your own role.');
    db.run('UPDATE business_members SET role = ? WHERE business_id = ? AND user_id = ?', role, biz.id, m.user_id);
    audit(ctx, 'business_team.role_changed', 'user', biz.id, { member: m.user_id, from: m.role, to: role });
    notify(m.user_id, 'team', `Your role at ${bizName(biz.id)} changed`, `You’re now ${TEAM_ROLES[role].label}.`, `business:team:${biz.id}`);
    return teamView(biz.id);
  }, { auth: true });

  route('DELETE', '/api/business/team/:userId', (ctx) => {
    const { biz, role: myRole } = kit.actingBusiness(ctx, 'team');
    const m = membership(biz.id, ctx.params.userId);
    if (!m) throw new HttpError(404, 'not_found', 'Member not found.');
    if (m.role === 'admin' && myRole !== 'owner') throw new HttpError(403, 'role_forbidden', 'Only the business owner can remove admins.');
    db.run('DELETE FROM business_members WHERE business_id = ? AND user_id = ?', biz.id, m.user_id);
    audit(ctx, 'business_team.removed', 'user', biz.id, { member: m.user_id, role: m.role });
    notify(m.user_id, 'team', `You were removed from ${bizName(biz.id)}’s team`, '', '');
    return teamView(biz.id);
  }, { auth: true });

  /* ---------- replying to leads as the business ---------- */
  const leadFor = (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'leads');
    const e = db.get('SELECT * FROM enquiries WHERE id = ? AND business_id = ?', ctx.params.id, biz.id);
    if (!e) throw new HttpError(404, 'not_found', 'Lead not found.');
    return { biz, e };
  };
  route('GET', '/api/me/leads/:id/thread', (ctx) => {
    const { biz, e } = leadFor(ctx);
    db.run('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL', now(), e.conversation_id, biz.id);
    const from = db.get('SELECT id, name, title FROM users WHERE id = ?', e.from_user_id);
    return {
      from,
      messages: db.all(
        `SELECT m.*, s.name AS sent_by_name FROM messages m LEFT JOIN users s ON s.id = m.sent_by WHERE m.conversation_id = ? ORDER BY m.created_at LIMIT 300`, e.conversation_id
      ).map((m) => ({ id: m.id, body: m.body, fromBusiness: m.sender_id === biz.id, sentBy: m.sender_id === biz.id ? m.sent_by_name || bizName(biz.id) : from.name, createdAt: m.created_at, read: !!m.read_at }))
    };
  }, { auth: true });

  route('POST', '/api/me/leads/:id/reply', (ctx) => {
    const { biz, e } = leadFor(ctx);
    if (db.get("SELECT 1 FROM user_blocks WHERE kind = 'block' AND ((user_id = ? AND target_user_id = ?) OR (user_id = ? AND target_user_id = ?))", biz.id, e.from_user_id, e.from_user_id, biz.id))
      throw new HttpError(403, 'forbidden', 'You can’t message this member.');
    if (!kit.limit(`leadreply:${ctx.user.id}`, 60, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'You’re sending messages too quickly.');
    const body = str(ctx.body.body, 'Message', { min: 1, max: 2000 });
    const id = newId();
    db.run('INSERT INTO messages (id, conversation_id, sender_id, sent_by, body, created_at) VALUES (?,?,?,?,?,?)', id, e.conversation_id, biz.id, ctx.user.id, body, now());
    db.run('UPDATE conversations SET last_at = ? WHERE id = ?', now(), e.conversation_id);
    if (e.status === 'new') db.run("UPDATE enquiries SET status = 'contacted', updated_at = ? WHERE id = ?", now(), e.id);
    notify(e.from_user_id, 'message', `New message from ${bizName(biz.id)}`, body.slice(0, 120), `messages:${e.conversation_id}`);
    return { status: 201, body: { id, createdAt: now() } };
  }, { auth: true });
}
