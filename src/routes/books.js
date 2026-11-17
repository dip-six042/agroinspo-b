// Books and digital learning products (PRD §29): upload, review, purchase, secure library access.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, now } from '../security.js';
import { MAX_BOOK_BYTES, BOOK_TYPES, COVER_TYPES, COMMISSION, BOOK_REFUND_DAYS } from '../config.js';

const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];
const KIND_LIMITS = {
  cover: { types: COVER_TYPES, max: 2 * 1024 * 1024, column: 'cover_file_id', fileKind: 'cover' },
  sample: { types: BOOK_TYPES, max: 10 * 1024 * 1024, column: 'sample_file_id', fileKind: 'book_sample' },
  book: { types: BOOK_TYPES, max: MAX_BOOK_BYTES, column: 'book_file_id', fileKind: 'book' }
};

// Check the file really is what its type claims.
export function sniff(buf, mime) {
  if (mime === 'application/pdf') return buf.subarray(0, 5).toString() === '%PDF-';
  if (mime === 'application/epub+zip') return buf[0] === 0x50 && buf[1] === 0x4b && buf.includes(Buffer.from('application/epub+zip'));
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return false;
}

export function registerBooks(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, requireVerified, requireActive, fulfil, ledger, cfg } = kit;

  const canPublish = (user) =>
    user.role === 'specialist' || user.role === 'admin' || !!db.get('SELECT 1 FROM creator_topics WHERE user_id = ? AND revoked_at IS NULL', user.id);

  const SELECT_BOOK = `
    SELECT b.*, u.name AS author_name, u.title AS author_title,
      (SELECT COUNT(*) FROM book_purchases p WHERE p.book_id = b.id AND p.status = 'paid') AS sales,
      EXISTS (SELECT 1 FROM book_purchases p WHERE p.book_id = b.id AND p.buyer_id = :viewer AND p.status = 'paid') AS owned
    FROM books b JOIN users u ON u.id = b.author_id`;

  const view = (b, viewer) => {
    const mine = viewer && (viewer.id === b.author_id || viewer.role === 'admin');
    return {
      id: b.id, title: b.title, subtitle: b.subtitle, description: b.description, topic: b.topic, language: b.language, pages: b.pages,
      priceNgn: b.price_ngn, status: b.status, publishedAt: b.published_at,
      author: { id: b.author_id, name: b.author_name, title: b.author_title },
      hasCover: !!b.cover_file_id, hasSample: !!b.sample_file_id, owned: !!b.owned,
      ...(mine ? { sales: b.sales, hasBookFile: !!b.book_file_id, reviewNote: b.review_note, rightsDeclared: !!b.rights_declared_at,
        netPerSaleNgn: b.price_ngn - Math.round(b.price_ngn * COMMISSION.book_purchase) } : {})
    };
  };

  function getBook(id, viewer) {
    const b = db.get(`${SELECT_BOOK} WHERE b.id = :id`, { id, viewer: viewer?.id ?? '' });
    const mine = b && viewer && (viewer.id === b.author_id || viewer.role === 'admin');
    if (!b || (b.status !== 'published' && !mine && !b.owned)) throw new HttpError(404, 'not_found', 'This book could not be found.');
    return b;
  }
  function ownBook(ctx, id) {
    const b = db.get('SELECT * FROM books WHERE id = ?', id);
    if (!b || (b.author_id !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'not_found', 'Book not found.');
    return b;
  }

  const parseBook = (b) => {
    const d = {
      title: str(b.title, 'Title', { min: 3, max: 140 }),
      subtitle: str(b.subtitle, 'Subtitle', { max: 200 }),
      description: str(b.description, 'Description', { min: 50, max: 4000 }),
      topic: oneOf(b.topic, TOPICS, 'Topic'),
      language: str(b.language || 'English', 'Language', { max: 40 }),
      pages: b.pages ? Number(b.pages) : null,
      price: Number(b.priceNgn)
    };
    if (d.pages !== null && (!Number.isInteger(d.pages) || d.pages < 1 || d.pages > 5000)) throw bad('Pages must be a whole number.');
    if (!Number.isInteger(d.price) || d.price < 500 || d.price > 500_000) throw bad('Price must be between ₦500 and ₦500,000.');
    return d;
  };

  /* ---------- authors ---------- */
  route('POST', '/api/books', (ctx) => {
    requireVerified(ctx);
    if (!canPublish(ctx.user)) throw new HttpError(403, 'forbidden', 'Specialists and approved creators can publish books.');
    const d = parseBook(ctx.body);
    const id = newId();
    db.run(
      'INSERT INTO books (id, author_id, title, subtitle, description, topic, language, pages, price_ngn, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, ctx.user.id, d.title, d.subtitle, d.description, d.topic, d.language, d.pages, d.price, now(), now()
    );
    return { status: 201, body: { book: view(getBook(id, ctx.user), ctx.user) } };
  }, { auth: true });

  route('PATCH', '/api/books/:id', (ctx) => {
    const b = ownBook(ctx, ctx.params.id);
    if (!['draft', 'rejected'].includes(b.status)) throw bad('Published books can’t be edited here. Contact support to change a live book.');
    const d = parseBook(ctx.body);
    db.run('UPDATE books SET title=?, subtitle=?, description=?, topic=?, language=?, pages=?, price_ngn=?, updated_at=? WHERE id=?',
      d.title, d.subtitle, d.description, d.topic, d.language, d.pages, d.price, now(), b.id);
    return { book: view(getBook(b.id, ctx.user), ctx.user) };
  }, { auth: true });

  for (const kind of Object.keys(KIND_LIMITS)) {
    const lim = KIND_LIMITS[kind];
    route('POST', `/api/books/:id/files/${kind}`, (ctx) => {
      requireActive(ctx);
      const b = ownBook(ctx, ctx.params.id);
      if (!['draft', 'rejected'].includes(b.status)) throw bad('Files can only be changed before the book is submitted.');
      if (!sniff(ctx.rawBody, ctx.contentType)) throw bad('The file doesn’t match its type.');
      const id = newId();
      mkdirSync(cfg.uploadDir, { recursive: true });
      writeFileSync(join(cfg.uploadDir, id), ctx.rawBody);
      const filename = decodeURIComponent(String(ctx.req.headers['x-filename'] || kind)).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      db.run('INSERT INTO files (id, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, ctx.user.id, lim.fileKind, filename, ctx.contentType, ctx.rawBody.length, createHash('sha256').update(ctx.rawBody).digest('hex'), id, now());
      db.run(`UPDATE books SET ${lim.column} = ?, updated_at = ? WHERE id = ?`, id, now(), b.id);
      return { status: 201, body: { file: { id, filename, sizeBytes: ctx.rawBody.length } } };
    }, { auth: true, raw: { types: Object.keys(lim.types), maxBytes: lim.max } });
  }

  route('POST', '/api/books/:id/submit', (ctx) => {
    const b = ownBook(ctx, ctx.params.id);
    if (!['draft', 'rejected'].includes(b.status)) throw bad('This book has already been submitted.');
    if (!b.book_file_id || !b.cover_file_id) throw bad('Upload the book file and a cover before submitting.');
    if (ctx.body.rightsDeclaration !== true) throw bad('Confirm that you own or have the right to sell this content.');
    db.run("UPDATE books SET status = 'under_review', rights_declared_at = ?, updated_at = ? WHERE id = ?", now(), now(), b.id);
    audit(ctx, 'book.submitted', 'book', b.id, { rightsDeclared: true });
    for (const a of db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")) notify(a.id, 'review', 'Book waiting for review', b.title, 'admin:books');
    return { status: 'under_review' };
  }, { auth: true });

  route('GET', '/api/me/books', (ctx) => ({
    books: db.all(`${SELECT_BOOK} WHERE b.author_id = :viewer ORDER BY b.created_at DESC`, { viewer: ctx.user.id }).map((b) => view(b, ctx.user)),
    canPublish: canPublish(ctx.user)
  }), { auth: true });

  /* ---------- store ---------- */
  route('GET', '/api/books', (ctx) => {
    const where = ["b.status = 'published'"];
    const params = { viewer: ctx.user?.id ?? '' };
    if (ctx.query.get('topic')) (where.push('b.topic = :topic'), (params.topic = oneOf(ctx.query.get('topic'), TOPICS, 'Topic')));
    if (ctx.query.get('q')) (where.push('(b.title LIKE :q OR b.description LIKE :q OR u.name LIKE :q)'), (params.q = `%${ctx.query.get('q').slice(0, 60).replace(/[%_]/g, '')}%`));
    return { books: db.all(`${SELECT_BOOK} WHERE ${where.join(' AND ')} ORDER BY b.published_at DESC LIMIT 100`, params).map((b) => view(b, ctx.user)) };
  });

  route('GET', '/api/books/:id', (ctx) => {
    const b = getBook(ctx.params.id, ctx.user);
    const p = ctx.user && b.owned ? db.get("SELECT id, paid_at FROM book_purchases WHERE book_id = ? AND buyer_id = ? AND status = 'paid'", b.id, ctx.user.id) : null;
    return { book: { ...view(b, ctx.user), ...(p ? { purchase: { id: p.id, paidAt: p.paid_at } } : {}) }, refundDays: BOOK_REFUND_DAYS };
  });

  const sendFile = (fileId, inline) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', fileId);
    const path = f && join(cfg.uploadDir, f.storage_key);
    if (!f || !existsSync(path)) throw new HttpError(404, 'not_found', 'File not found.');
    return { file: { buffer: readFileSync(path), mime: f.mime, filename: f.filename, inline } };
  };

  route('GET', '/api/books/:id/cover', (ctx) => {
    const b = getBook(ctx.params.id, ctx.user);
    if (!b.cover_file_id) throw new HttpError(404, 'not_found', 'No cover.');
    return sendFile(b.cover_file_id, true);
  });

  route('GET', '/api/books/:id/sample', (ctx) => {
    const b = getBook(ctx.params.id, ctx.user);
    if (!b.sample_file_id) throw new HttpError(404, 'not_found', 'No sample for this book.');
    return sendFile(b.sample_file_id, false);
  });

  // Only buyers with a paid purchase (and the author/admins) can download the full book.
  route('GET', '/api/books/:id/download', (ctx) => {
    const b = db.get('SELECT * FROM books WHERE id = ?', ctx.params.id);
    if (!b) throw new HttpError(404, 'not_found', 'Book not found.');
    const purchase = db.get("SELECT * FROM book_purchases WHERE book_id = ? AND buyer_id = ? AND status = 'paid'", b.id, ctx.user.id);
    if (!purchase && b.author_id !== ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'not_owned', 'Buy this book to download it.');
    if (!kit.limit(`dl:${ctx.user.id}:${b.id}`, 10, 24 * 3600_000)) throw new HttpError(429, 'rate_limited', 'Download limit reached for today. Try again tomorrow.');
    if (purchase) db.run('UPDATE book_purchases SET downloads = downloads + 1 WHERE id = ?', purchase.id);
    return sendFile(b.book_file_id, false);
  }, { auth: true });

  route('POST', '/api/books/:id/buy', async (ctx) => {
    requireVerified(ctx);
    const b = getBook(ctx.params.id, ctx.user);
    if (b.status !== 'published') throw bad('This book isn’t on sale.');
    if (b.author_id === ctx.user.id) throw bad('You’re the author of this book.');
    if (b.owned) throw new HttpError(409, 'already_owned', 'This book is already in your library.');
    const purchaseId = newId();
    db.run('INSERT INTO book_purchases (id, book_id, buyer_id, price_ngn, created_at) VALUES (?,?,?,?,?)', purchaseId, b.id, ctx.user.id, b.price_ngn, now());
    const payment = await kit.createPayment({
      user: ctx.user, purpose: 'book_purchase', subjectId: purchaseId, amountNgn: b.price_ngn,
      description: `Book: ${b.title}`, returnPath: 'books:library'
    });
    db.run('UPDATE book_purchases SET payment_id = ? WHERE id = ?', payment.id, purchaseId);
    return { checkoutUrl: payment.checkout_url, reference: payment.reference };
  }, { auth: true });

  fulfil.book_purchase = (payment) => {
    const p = db.get('SELECT p.*, b.author_id, b.title FROM book_purchases p JOIN books b ON b.id = p.book_id WHERE p.id = ?', payment.subject_id);
    if (!p || p.status !== 'pending') return;
    db.run("UPDATE book_purchases SET status = 'paid', paid_at = ? WHERE id = ?", now(), p.id);
    ledger.recordSale({ sellerId: p.author_id, purpose: 'book_purchase', sourceId: p.id, payment, availableFrom: now() });
    notify(p.author_id, 'sale', 'You sold a book', p.title, 'books:mine');
  };
  fulfil['book_purchase:refunded'] = (payment) => {
    if (payment.refunded_ngn >= payment.amount_ngn) db.run("UPDATE book_purchases SET status = 'refunded' WHERE id = ?", payment.subject_id);
  };

  route('GET', '/api/me/library', (ctx) => ({
    books: db.all(
      `${SELECT_BOOK} WHERE b.id IN (SELECT book_id FROM book_purchases WHERE buyer_id = :viewer AND status = 'paid') ORDER BY b.title`,
      { viewer: ctx.user.id }
    ).map((b) => ({
      ...view(b, ctx.user),
      purchase: (() => {
        const p = db.get("SELECT id, paid_at FROM book_purchases WHERE book_id = ? AND buyer_id = ? AND status = 'paid'", b.id, ctx.user.id);
        return { id: p.id, paidAt: p.paid_at };
      })()
    }))
  }), { auth: true });

  /* ---------- admin review ---------- */
  route('GET', '/api/admin/books', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'under_review', ['under_review', 'published', 'rejected', 'suspended'], 'Status');
    return { books: db.all(`${SELECT_BOOK} WHERE b.status = :status ORDER BY b.updated_at`, { status, viewer: ctx.user.id }).map((b) => view(b, ctx.user)) };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/books/:id/review', (ctx) => {
    const b = db.get('SELECT * FROM books WHERE id = ?', ctx.params.id);
    if (!b) throw new HttpError(404, 'not_found', 'Book not found.');
    const decision = oneOf(ctx.body.decision, ['approve', 'reject', 'suspend'], 'Decision');
    const note = str(ctx.body.note, 'Note', { min: decision === 'approve' ? 0 : 5, max: 1000 });
    if (decision !== 'suspend' && b.status !== 'under_review') throw bad('This book isn’t waiting for review.');
    const status = { approve: 'published', reject: 'rejected', suspend: 'suspended' }[decision];
    db.run('UPDATE books SET status = ?, review_note = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?',
      status, note, decision === 'approve' ? now() : null, now(), b.id);
    notify(b.author_id, 'review', { approve: 'Your book is on sale', reject: 'Your book needs changes', suspend: 'Your book was taken down' }[decision], `${b.title}${note ? ' · ' + note : ''}`, 'books:mine');
    audit(ctx, `book.${status}`, 'book', b.id, { note });
    return { status };
  }, { roles: ['admin'] });
}
