// Business profiles, verification, products & services, and enquiries/leads (PRD §22.5, §30).
// Verification states exactly what was checked; it is never a guarantee of quality or solvency.
import { newId, now } from '../security.js';
import { BUSINESS_CATEGORIES, EVIDENCE_TYPES, AD_IMAGE_TYPES } from '../config.js';
import { saveUpload, fileResponse } from '../uploads.js';
import { permissionsFor } from './team.js';

const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];
const MAX_EVIDENCE = 5;

export function registerBusiness(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, parseJson, requireActive, requireVerified } = kit;

  const admins = () => db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  const ensure = (userId) => {
    if (!db.get('SELECT 1 FROM business_profiles WHERE user_id = ?', userId))
      db.run('INSERT INTO business_profiles (user_id, created_at, updated_at) VALUES (?,?,?)', userId, now(), now());
    return db.get('SELECT * FROM business_profiles WHERE user_id = ?', userId);
  };
  // Business-account-only actions, done by the owner or a team member whose role allows it.
  const act = (ctx, perm) => {
    const a = kit.actingBusiness(ctx, perm);
    if (a.biz.role !== 'business') throw new HttpError(403, 'forbidden', 'Only business accounts have a business profile.');
    return a;
  };
  const url = (v, label) => {
    const s = str(v, label, { max: 300 });
    if (s && !/^https:\/\/[^\s]+\.[^\s]+$/i.test(s)) throw bad(`${label} must be a full https:// link.`);
    return s;
  };

  /** Can this member buy adverts and sponsorships? Verified businesses, and specialists with checked credentials. */
  kit.canAdvertise = (user) => {
    if (!user || user.status !== 'active') return false;
    if (user.role === 'business') return db.get("SELECT verification_status FROM business_profiles WHERE user_id = ?", user.id)?.verification_status === 'verified';
    if (user.role === 'specialist') return db.get("SELECT credential_status FROM specialist_profiles WHERE user_id = ?", user.id)?.credential_status === 'verified';
    return false;
  };
  kit.advertiserName = (userId) => {
    const b = db.get('SELECT trading_name, legal_name FROM business_profiles WHERE user_id = ?', userId);
    return b?.trading_name || b?.legal_name || db.get('SELECT name FROM users WHERE id = ?', userId)?.name || 'Advertiser';
  };

  const profileView = (b, user, { priv = false } = {}) => ({
    id: b.user_id,
    name: b.trading_name || b.legal_name || user?.name || '',
    legalName: b.legal_name,
    tradingName: b.trading_name,
    category: b.category,
    region: b.region,
    serviceArea: b.service_area,
    website: b.website,
    socials: parseJson(b.socials, []),
    about: b.about,
    avatarUrl: user?.avatar_url ?? '',
    verification: {
      status: b.verification_status,
      scope: b.verification_status === 'verified' ? b.verification_scope : '',
      verifiedAt: b.verification_status === 'verified' ? b.verified_at : null
    },
    ...(priv ? {
      rcNumber: b.rc_number, address: b.address, contactName: b.contact_name, contactRole: b.contact_role, phone: b.phone,
      verificationNote: b.verification_note, submittedAt: b.submitted_at,
      evidence: parseJson(b.evidence, []).map((e) => ({ ...e, filename: db.get('SELECT filename FROM files WHERE id = ?', e.fileId)?.filename ?? '' }))
    } : {})
  });

  const listingView = (l) => ({
    id: l.id, businessId: l.business_id, kind: l.kind, title: l.title, description: l.description, topic: l.topic,
    priceType: l.price_type, priceNgn: l.price_ngn, unit: l.unit, serviceArea: l.service_area, availability: l.availability,
    imageUrl: l.image_file_id ? `/api/media/${l.image_file_id}` : '', status: l.status, createdAt: l.created_at,
    ...(l.business_name !== undefined ? { business: { id: l.business_id, name: l.business_name, verified: l.verification_status === 'verified' } } : {})
  });

  /* ---------- my business ---------- */
  route('GET', '/api/me/business', (ctx) => {
    const { biz, role } = act(ctx, 'view');
    const perms = permissionsFor(role);
    const b = ensure(biz.id);
    return {
      profile: profileView(b, biz, { priv: perms.includes('profile') }),
      listings: perms.includes('listings') ? db.all("SELECT * FROM business_listings WHERE business_id = ? AND status != 'removed' ORDER BY created_at DESC", biz.id).map(listingView) : [],
      newLeads: perms.includes('leads') ? db.get("SELECT COUNT(*) AS n FROM enquiries WHERE business_id = ? AND status = 'new'", biz.id).n : 0,
      canAdvertise: kit.canAdvertise(biz),
      categories: BUSINESS_CATEGORIES,
      myRole: role,
      permissions: perms
    };
  }, { auth: true });

  route('PUT', '/api/me/business', (ctx) => {
    const { biz } = act(ctx, 'profile');
    const b = ensure(biz.id);
    if (b.verification_status === 'pending') throw bad('Your details are being checked. You can edit them once the review is finished.');
    const f = {
      legal_name: str(ctx.body.legalName, 'Registered (legal) name', { max: 160 }),
      trading_name: str(ctx.body.tradingName, 'Trading name', { max: 120 }),
      category: oneOf(ctx.body.category || 'other', Object.keys(BUSINESS_CATEGORIES), 'Category'),
      rc_number: str(ctx.body.rcNumber, 'CAC registration number', { max: 40 }).toUpperCase(),
      address: str(ctx.body.address, 'Business address', { max: 300 }),
      region: str(ctx.body.region, 'State / region', { max: 80 }),
      service_area: str(ctx.body.serviceArea, 'Service area', { max: 200 }),
      contact_name: str(ctx.body.contactName, 'Authorised contact', { max: 120 }),
      contact_role: str(ctx.body.contactRole, 'Contact’s role', { max: 80 }),
      phone: str(ctx.body.phone, 'Phone', { max: 30 }),
      website: url(ctx.body.website, 'Website'),
      about: str(ctx.body.about, 'About the business', { max: 2000 }),
      socials: JSON.stringify((Array.isArray(ctx.body.socials) ? ctx.body.socials : []).slice(0, 4).map((s) => url(s, 'Social link')).filter(Boolean))
    };
    if (f.phone && !/^\+?[\d\s-]{7,20}$/.test(f.phone)) throw bad('Enter a valid phone number.');
    // Changing who the business legally is undoes verification; everything else can change freely.
    const identityChanged = b.verification_status === 'verified' && (f.legal_name !== b.legal_name || f.rc_number !== b.rc_number);
    db.run(
      `UPDATE business_profiles SET legal_name=?, trading_name=?, category=?, rc_number=?, address=?, region=?, service_area=?, contact_name=?,
        contact_role=?, phone=?, website=?, about=?, socials=?, updated_at=? ${identityChanged ? ", verification_status='unverified', verification_scope='', verification_note='Registered name or number changed. Submit again for verification.'" : ''}
       WHERE user_id=?`,
      f.legal_name, f.trading_name, f.category, f.rc_number, f.address, f.region, f.service_area, f.contact_name, f.contact_role, f.phone, f.website,
      f.about, f.socials, now(), biz.id
    );
    if (identityChanged) audit(ctx, 'business.unverified_on_change', 'user', biz.id);
    return { profile: profileView(ensure(biz.id), biz, { priv: true }), reverify: identityChanged };
  }, { auth: true });

  route('POST', '/api/me/business/evidence', (ctx) => {
    const { biz } = act(ctx, 'profile');
    const b = ensure(biz.id);
    if (b.verification_status === 'pending') throw bad('Your documents are being checked.');
    const list = parseJson(b.evidence, []);
    if (list.length >= MAX_EVIDENCE) throw bad(`You can attach up to ${MAX_EVIDENCE} documents.`);
    const label = str(decodeURIComponent(ctx.query.get('label') || ''), 'Document name', { min: 3, max: 80 });
    const file = saveUpload(kit, ctx, 'business_evidence', biz.id);
    list.push({ fileId: file.id, label });
    db.run('UPDATE business_profiles SET evidence = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(list), now(), biz.id);
    return { status: 201, body: { evidence: list } };
  }, { auth: true, raw: { types: Object.keys(EVIDENCE_TYPES), maxBytes: 8 * 1024 * 1024 } });

  route('DELETE', '/api/me/business/evidence/:fileId', (ctx) => {
    const { biz } = act(ctx, 'profile');
    const b = ensure(biz.id);
    if (b.verification_status === 'pending') throw bad('Your documents are being checked.');
    const list = parseJson(b.evidence, []).filter((e) => e.fileId !== ctx.params.fileId);
    db.run('UPDATE business_profiles SET evidence = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(list), now(), biz.id);
    return { evidence: list };
  }, { auth: true });

  route('POST', '/api/me/business/submit', (ctx) => {
    const { biz } = act(ctx, 'profile');
    requireVerified(ctx);
    const b = ensure(biz.id);
    if (['pending', 'verified'].includes(b.verification_status)) throw bad(b.verification_status === 'pending' ? 'Already submitted.' : 'Already verified.');
    const missing = [
      !b.legal_name && 'registered name', !b.rc_number && 'CAC registration number', !b.address && 'address', !b.region && 'state',
      !b.contact_name && 'authorised contact', !b.phone && 'phone', !parseJson(b.evidence, []).length && 'at least one supporting document'
    ].filter(Boolean);
    if (missing.length) throw bad(`Add your ${missing.join(', ')} before submitting.`);
    if (ctx.body.authorised !== true) throw bad('Confirm that you’re authorised to act for this business.');
    db.run("UPDATE business_profiles SET verification_status = 'pending', verification_note = '', submitted_at = ?, updated_at = ? WHERE user_id = ?", now(), now(), biz.id);
    audit(ctx, 'business.verification_submitted', 'user', biz.id);
    for (const a of admins()) notify(a.id, 'review', 'Business waiting for verification', b.legal_name, 'admin:businesses');
    return { status: 'pending' };
  }, { auth: true });

  /* ---------- public profiles & directory ---------- */
  route('GET', '/api/businesses', (ctx) => {
    const q = String(ctx.query.get('q') || '').slice(0, 80).replace(/[%_]/g, '');
    const category = ctx.query.get('category') || '';
    const rows = db.all(
      `SELECT b.*, u.name, u.avatar_url,
         (SELECT COUNT(*) FROM business_listings l WHERE l.business_id = b.user_id AND l.status = 'published') AS listing_count
       FROM business_profiles b JOIN users u ON u.id = b.user_id
       WHERE u.status = 'active' AND b.verification_status = 'verified'
         AND (:category = '' OR b.category = :category)
         AND (:q = '' OR b.trading_name LIKE :like OR b.legal_name LIKE :like OR b.about LIKE :like OR b.service_area LIKE :like)
       ORDER BY b.verified_at DESC LIMIT 60`,
      { q, like: `%${q}%`, category }
    );
    return { businesses: rows.map((b) => ({ ...profileView(b, b), listingCount: b.listing_count })), categories: BUSINESS_CATEGORIES };
  });

  route('GET', '/api/businesses/:id', (ctx) => {
    const u = db.get("SELECT * FROM users WHERE id = ? AND role = 'business' AND status = 'active'", ctx.params.id);
    const b = u && db.get('SELECT * FROM business_profiles WHERE user_id = ?', u.id);
    const own = ctx.user && (ctx.user.id === u?.id || ctx.user.role === 'admin' || !!db.get('SELECT 1 FROM business_members WHERE business_id = ? AND user_id = ?', u?.id, ctx.user.id));
    if (!b || (b.verification_status !== 'verified' && !own)) throw new HttpError(404, 'not_found', 'This business could not be found.');
    return {
      business: profileView(b, u),
      categories: BUSINESS_CATEGORIES,
      listings: db.all(`SELECT * FROM business_listings WHERE business_id = ? AND status = 'published' ORDER BY created_at DESC`, u.id).map(listingView),
      sponsoring: db.all(
        `SELECT e.id, e.title, e.starts_at FROM event_sponsorships s JOIN events e ON e.id = s.event_id
         WHERE s.business_id = ? AND s.status IN ('confirmed','completed') AND e.status != 'cancelled' ORDER BY e.starts_at DESC LIMIT 6`, u.id
      ).map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at }))
    };
  });

  /* ---------- listings: products & services ---------- */
  const ownListing = (ctx, id) => {
    const { biz } = act(ctx, 'listings');
    const l = db.get('SELECT * FROM business_listings WHERE id = ?', id);
    if (!l || l.business_id !== biz.id || l.status === 'removed') throw new HttpError(404, 'not_found', 'Listing not found.');
    return l;
  };
  const parseListing = (body) => {
    const priceType = oneOf(body.priceType || 'quote', ['fixed', 'from', 'quote'], 'Price type');
    const price = priceType === 'quote' ? null : Number(body.priceNgn);
    if (priceType !== 'quote' && (!Number.isInteger(price) || price < 1 || price > 1_000_000_000)) throw bad('Enter a price in whole naira, or choose “price on request”.');
    return {
      kind: oneOf(body.kind || 'product', ['product', 'service'], 'Type'),
      title: str(body.title, 'Name', { min: 3, max: 120 }),
      description: str(body.description, 'Description', { min: 20, max: 3000 }),
      topic: oneOf(body.topic, TOPICS, 'Topic'),
      price_type: priceType, price_ngn: price,
      unit: str(body.unit, 'Unit', { max: 40 }),
      service_area: str(body.serviceArea, 'Where you supply', { max: 200 }),
      availability: str(body.availability, 'Availability', { max: 200 })
    };
  };

  route('POST', '/api/me/listings', (ctx) => {
    const { biz } = act(ctx, 'listings');
    const f = parseListing(ctx.body);
    if (db.get("SELECT COUNT(*) AS n FROM business_listings WHERE business_id = ? AND status != 'removed'", biz.id).n >= 100) throw bad('You can have up to 100 listings.');
    const id = newId();
    db.run(
      `INSERT INTO business_listings (id, business_id, kind, title, description, topic, price_type, price_ngn, unit, service_area, availability, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'published', ?, ?)`,
      id, biz.id, f.kind, f.title, f.description, f.topic, f.price_type, f.price_ngn, f.unit, f.service_area, f.availability, now(), now()
    );
    return { status: 201, body: { listing: listingView(db.get('SELECT * FROM business_listings WHERE id = ?', id)) } };
  }, { auth: true });

  route('PATCH', '/api/me/listings/:id', (ctx) => {
    const l = ownListing(ctx, ctx.params.id);
    if (ctx.body.status !== undefined && Object.keys(ctx.body).length === 1) {
      const status = oneOf(ctx.body.status, ['published', 'hidden', 'removed'], 'Status');
      db.run('UPDATE business_listings SET status = ?, updated_at = ? WHERE id = ?', status, now(), l.id);
    } else {
      const f = parseListing(ctx.body);
      db.run(
        `UPDATE business_listings SET kind=?, title=?, description=?, topic=?, price_type=?, price_ngn=?, unit=?, service_area=?, availability=?, updated_at=? WHERE id=?`,
        f.kind, f.title, f.description, f.topic, f.price_type, f.price_ngn, f.unit, f.service_area, f.availability, now(), l.id
      );
    }
    return { listing: listingView(db.get('SELECT * FROM business_listings WHERE id = ?', l.id)) };
  }, { auth: true });

  route('POST', '/api/me/listings/:id/image', (ctx) => {
    const l = ownListing(ctx, ctx.params.id);
    const file = saveUpload(kit, ctx, 'listing_image', l.business_id);
    db.run('UPDATE business_listings SET image_file_id = ?, updated_at = ? WHERE id = ?', file.id, now(), l.id);
    return { status: 201, body: { imageUrl: `/api/media/${file.id}` } };
  }, { auth: true, raw: { types: Object.keys(AD_IMAGE_TYPES), maxBytes: 2 * 1024 * 1024 } });

  // Marketplace of products & services from verified businesses only.
  route('GET', '/api/listings', (ctx) => {
    const q = String(ctx.query.get('q') || '').slice(0, 80).replace(/[%_]/g, '');
    const topic = ctx.query.get('topic') || '';
    const kind = ctx.query.get('kind') || '';
    return {
      listings: db.all(
        `SELECT l.*, COALESCE(NULLIF(b.trading_name,''), b.legal_name) AS business_name, b.verification_status
         FROM business_listings l JOIN business_profiles b ON b.user_id = l.business_id JOIN users u ON u.id = l.business_id
         WHERE l.status = 'published' AND b.verification_status = 'verified' AND u.status = 'active'
           AND (:topic = '' OR l.topic = :topic) AND (:kind = '' OR l.kind = :kind)
           AND (:q = '' OR l.title LIKE :like OR l.description LIKE :like OR l.service_area LIKE :like)
         ORDER BY l.updated_at DESC LIMIT 60`,
        { q, like: `%${q}%`, topic, kind }
      ).map(listingView)
    };
  });

  // Public images (listing photos, advert images, sponsor logos) only once their owner item is visible.
  route('GET', '/api/media/:id', (ctx) => {
    const f = db.get("SELECT * FROM files WHERE id = ? AND kind IN ('listing_image','ad_image','sponsor_logo')", ctx.params.id);
    if (!f) throw new HttpError(404, 'not_found', 'Not found.');
    const visible =
      (ctx.user && (ctx.user.id === f.owner_id || ctx.user.role === 'admin' || db.get('SELECT 1 FROM business_members WHERE business_id = ? AND user_id = ?', f.owner_id, ctx.user.id))) ||
      db.get(`SELECT 1 FROM business_listings l JOIN business_profiles b ON b.user_id = l.business_id
              WHERE l.image_file_id = ? AND l.status = 'published' AND b.verification_status = 'verified'`, f.id) ||
      db.get("SELECT 1 FROM ad_campaigns WHERE image_file_id = ? AND status IN ('approved','paused','ended')", f.id) ||
      db.get("SELECT 1 FROM event_sponsorships WHERE logo_file_id = ? AND status IN ('requested','accepted','confirmed','completed')", f.id);
    if (!visible) throw new HttpError(404, 'not_found', 'Not found.');
    return fileResponse(kit, f.id, true);
  });

  /* ---------- enquiries / leads ---------- */
  const startConversation = (a, b) => {
    const [x, y] = [a, b].sort();
    db.run('INSERT OR IGNORE INTO conversations (id, user_a, user_b, last_at, created_at) VALUES (?,?,?,?,?)', newId(), x, y, now(), now());
    return db.get('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', x, y).id;
  };

  route('POST', '/api/enquiries', (ctx) => {
    requireVerified(ctx);
    const target = db.get("SELECT * FROM users WHERE id = ? AND status = 'active'", String(ctx.body.businessId || ''));
    if (!target || !['business', 'specialist'].includes(target.role)) throw new HttpError(404, 'not_found', 'Business not found.');
    if (target.id === ctx.user.id) throw bad('You can’t send an enquiry to yourself.');
    if (db.get("SELECT 1 FROM user_blocks WHERE kind = 'block' AND ((user_id = ? AND target_user_id = ?) OR (user_id = ? AND target_user_id = ?))", ctx.user.id, target.id, target.id, ctx.user.id))
      throw new HttpError(403, 'forbidden', 'You can’t contact this business.');
    if (!kit.limit(`enquiry:${ctx.user.id}`, 15, 60 * 60_000)) throw new HttpError(429, 'rate_limited', 'You’ve sent a lot of enquiries. Try again later.');
    const listingId = ctx.body.listingId ? String(ctx.body.listingId) : null;
    if (listingId && !db.get("SELECT 1 FROM business_listings WHERE id = ? AND business_id = ? AND status = 'published'", listingId, target.id)) throw bad('That product or service isn’t available.');
    const adId = ctx.body.adId ? String(ctx.body.adId) : null;
    if (adId && !db.get('SELECT 1 FROM ad_campaigns WHERE id = ? AND business_id = ?', adId, target.id)) throw bad('Unknown advert.');
    const message = str(ctx.body.message, 'Message', { min: 10, max: 2000 });
    const phone = str(ctx.body.sharePhone, 'Phone', { max: 30 });
    if (phone && !/^\+?[\d\s-]{7,20}$/.test(phone)) throw bad('Enter a valid phone number, or leave it empty.');
    const listing = listingId ? db.get('SELECT title FROM business_listings WHERE id = ?', listingId) : null;
    const id = newId();
    let conversationId;
    db.tx(() => {
      conversationId = startConversation(ctx.user.id, target.id);
      const text = `${listing ? `Enquiry about “${listing.title}”\n\n` : 'Enquiry\n\n'}${message}${phone ? `\n\nPhone: ${phone}` : ''}`;
      db.run('INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?,?,?,?,?)', newId(), conversationId, ctx.user.id, text, now());
      db.run('UPDATE conversations SET last_at = ? WHERE id = ?', now(), conversationId);
      db.run(
        `INSERT INTO enquiries (id, business_id, from_user_id, listing_id, ad_id, message, share_phone, conversation_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, target.id, ctx.user.id, listingId, adId, message, phone, conversationId, now(), now()
      );
    });
    if (target.role === 'business') kit.notifyBusiness(target.id, 'leads', 'lead', `New enquiry from ${ctx.user.name}`, listing ? listing.title : message.slice(0, 100), 'business:leads');
    else notify(target.id, 'lead', `New enquiry from ${ctx.user.name}`, message.slice(0, 100), `messages:${conversationId}`);
    return { status: 201, body: { enquiry: { id, conversationId } } };
  }, { auth: true });

  route('GET', '/api/me/leads', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'leads');
    return {
      leads: db.all(
        `SELECT e.*, u.name AS from_name, u.title AS from_title, u.role AS from_role, l.title AS listing_title, a.headline AS ad_headline
         FROM enquiries e JOIN users u ON u.id = e.from_user_id
         LEFT JOIN business_listings l ON l.id = e.listing_id LEFT JOIN ad_campaigns a ON a.id = e.ad_id
         WHERE e.business_id = ? ORDER BY e.created_at DESC LIMIT 300`, biz.id
      ).map((e) => ({
        id: e.id, message: e.message, phone: e.share_phone, status: e.status, createdAt: e.created_at, conversationId: e.conversation_id,
        from: { id: e.from_user_id, name: e.from_name, title: e.from_title, role: e.from_role },
        source: e.ad_id ? { type: 'advert', label: e.ad_headline } : e.listing_id ? { type: 'listing', label: e.listing_title } : { type: 'profile', label: 'Business profile' }
      }))
    };
  }, { auth: true });

  route('PATCH', '/api/me/leads/:id', (ctx) => {
    const { biz } = kit.actingBusiness(ctx, 'leads');
    const status = oneOf(ctx.body.status, ['new', 'contacted', 'won', 'closed'], 'Status');
    const r = db.run('UPDATE enquiries SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?', status, now(), ctx.params.id, biz.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Lead not found.');
    return { ok: true };
  }, { auth: true });

  /* ---------- admin verification ---------- */
  route('GET', '/api/admin/businesses', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'pending', ['pending', 'verified', 'rejected', 'unverified'], 'Status');
    return {
      businesses: db.all(
        `SELECT b.*, u.name, u.email, u.avatar_url, u.created_at AS joined FROM business_profiles b JOIN users u ON u.id = b.user_id
         WHERE b.verification_status = ? ORDER BY b.submitted_at`, status
      ).map((b) => ({ ...profileView(b, b, { priv: true }), accountName: b.name, email: b.email, joinedAt: b.joined }))
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/businesses/:id/verify', (ctx) => {
    const b = db.get('SELECT * FROM business_profiles WHERE user_id = ?', ctx.params.id);
    if (!b) throw new HttpError(404, 'not_found', 'Business not found.');
    const decision = oneOf(ctx.body.decision, ['verified', 'rejected', 'unverified'], 'Decision');
    if (decision !== 'unverified' && b.verification_status !== 'pending') throw bad('This business isn’t waiting for review.');
    const scope = decision === 'verified' ? str(ctx.body.scope, 'What was checked', { min: 15, max: 500 }) : '';
    const note = decision === 'verified' ? '' : str(ctx.body.note, 'Reason', { min: 10, max: 1000 });
    db.run(
      'UPDATE business_profiles SET verification_status = ?, verification_scope = ?, verification_note = ?, verified_at = ?, verified_by = ?, updated_at = ? WHERE user_id = ?',
      decision, scope, note, decision === 'verified' ? now() : null, ctx.user.id, now(), b.user_id
    );
    // Withdrawing verification also stops any adverts that are running.
    if (decision === 'unverified') db.run("UPDATE ad_campaigns SET status = 'suspended', review_note = ?, updated_at = ? WHERE business_id = ? AND status = 'approved'", 'Business verification withdrawn', now(), b.user_id);
    audit(ctx, `business.${decision}`, 'user', b.user_id, { scope, note });
    kit.notifyBusiness(b.user_id, 'profile', 'review',
      { verified: 'Your business is verified', rejected: 'Business verification not approved', unverified: 'Business verification withdrawn' }[decision],
      decision === 'verified' ? `What we checked: ${scope} You can now advertise and sponsor events.` : `${note} You can update your details and submit again, or contact support to appeal.`,
      'business:profile');
    return { ok: true };
  }, { roles: ['admin'] });
}
