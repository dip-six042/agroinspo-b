// One-to-one messaging (PRD FR-15). Contact details stay private; blocks are respected.
import { newId, now } from '../security.js';

export function registerMessages(kit) {
  const { db, route, notify, HttpError, bad, str, requireActive } = kit;

  const blocked = (a, b) => !!db.get(
    "SELECT 1 FROM user_blocks WHERE kind = 'block' AND ((user_id = ? AND target_user_id = ?) OR (user_id = ? AND target_user_id = ?))", a, b, b, a
  );
  function convFor(ctx, id) {
    const c = db.get('SELECT * FROM conversations WHERE id = ?', id);
    if (!c || (c.user_a !== ctx.user.id && c.user_b !== ctx.user.id)) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return { ...c, other: c.user_a === ctx.user.id ? c.user_b : c.user_a };
  }

  route('POST', '/api/conversations', (ctx) => {
    requireActive(ctx);
    const other = String(ctx.body.userId || '');
    if (other === ctx.user.id) throw bad('You can’t message yourself.');
    if (!db.get("SELECT 1 FROM users WHERE id = ? AND status = 'active'", other)) throw new HttpError(404, 'not_found', 'Member not found.');
    if (blocked(ctx.user.id, other)) throw new HttpError(403, 'forbidden', 'You can’t message this member.');
    const [a, b] = [ctx.user.id, other].sort();
    db.run('INSERT OR IGNORE INTO conversations (id, user_a, user_b, last_at, created_at) VALUES (?,?,?,?,?)', newId(), a, b, now(), now());
    return { conversationId: db.get('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', a, b).id };
  }, { auth: true });

  route('GET', '/api/conversations', (ctx) => ({
    conversations: db.all(
      `SELECT c.*, u.id AS other_id, u.name AS other_name, u.title AS other_title, u.avatar_url AS other_avatar,
         (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != :me AND m.read_at IS NULL) AS unread
       FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a = :me THEN c.user_b ELSE c.user_a END
       WHERE (c.user_a = :me OR c.user_b = :me) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
       ORDER BY c.last_at DESC LIMIT 100`,
      { me: ctx.user.id }
    ).map((c) => ({
      id: c.id, lastAt: c.last_at, lastBody: c.last_body, unread: c.unread,
      other: { id: c.other_id, name: c.other_name, title: c.other_title, avatarUrl: c.other_avatar }
    })),
    unreadTotal: db.get(
      `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.user_a = :me OR c.user_b = :me) AND m.sender_id != :me AND m.read_at IS NULL`, { me: ctx.user.id }
    ).n
  }), { auth: true });

  route('GET', '/api/conversations/:id/messages', (ctx) => {
    const c = convFor(ctx, ctx.params.id);
    const after = ctx.query.get('after') || '';
    const rows = db.all('SELECT m.*, s.name AS sent_by_name FROM messages m LEFT JOIN users s ON s.id = m.sent_by WHERE m.conversation_id = ? AND m.created_at > ? ORDER BY m.created_at LIMIT 300', c.id, after);
    db.run('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL', now(), c.id, ctx.user.id);
    const other = db.get('SELECT id, name, title, avatar_url FROM users WHERE id = ?', c.other);
    return {
      other: { id: other.id, name: other.name, title: other.title, avatarUrl: other.avatar_url },
      blocked: blocked(ctx.user.id, c.other),
      // sentBy: a team member who replied on the business's behalf (shown to the business only).
      messages: rows.map((m) => ({ id: m.id, body: m.body, mine: m.sender_id === ctx.user.id, createdAt: m.created_at, read: !!m.read_at,
        ...(m.sender_id === ctx.user.id && m.sent_by && m.sent_by !== ctx.user.id ? { sentBy: m.sent_by_name } : {}) }))
    };
  }, { auth: true });

  route('POST', '/api/conversations/:id/messages', (ctx) => {
    requireActive(ctx);
    const c = convFor(ctx, ctx.params.id);
    if (blocked(ctx.user.id, c.other)) throw new HttpError(403, 'forbidden', 'You can’t message this member.');
    if (!kit.limit(`msg:${ctx.user.id}`, 40, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'You’re sending messages too quickly.');
    const body = str(ctx.body.body, 'Message', { min: 1, max: 2000 });
    const hadUnread = db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND sender_id = ? AND read_at IS NULL', c.id, ctx.user.id);
    const id = newId();
    db.run('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?,?,?,?,?)', id, c.id, ctx.user.id, body, now());
    db.run('UPDATE conversations SET last_at = ? WHERE id = ?', now(), c.id);
    // One notification per unread burst, not one per message.
    if (!hadUnread) notify(c.other, 'message', `New message from ${ctx.user.name}`, body.slice(0, 120), `messages:${c.id}`);
    return { status: 201, body: { id, createdAt: now() } };
  }, { auth: true });
}
