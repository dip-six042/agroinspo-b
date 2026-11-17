// Seeds demo accounts and community posts for local development.
//   npm run seed
// Accounts share one password (SEED_PASSWORD, default below). Refuses to run in production.
import { openDatabase } from '../src/db.js';
import { hashPassword, newId } from '../src/security.js';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SEED) {
  console.error('Refusing to seed demo data in production. Set ALLOW_SEED=1 if you really mean it.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD || 'agroinspo-demo-2026';
const db = openDatabase();
const t0 = Date.now();
const iso = (minsAgo) => new Date(t0 - minsAgo * 60_000).toISOString();

const people = [
  { key: 'admin', email: 'admin@agroinspo.test', name: 'Platform Admin', role: 'admin', title: 'Operations · Abuja', location: 'Abuja FCT', interests: ['agribusiness'] },
  { key: 'enthusiast', email: 'tunde@agroinspo.test', name: 'Tunde Alabi', role: 'enthusiast', title: 'Aspiring agribusiness professional', location: 'Lagos', interests: ['poultry', 'bsf-insect-farming', 'careers'] },
  { key: 'farmer', email: 'olayinka@agroinspo.test', name: 'Chief Olayinka Adeleke', role: 'farmer', title: 'Managing Director, GreenPeak Agro Ltd', location: 'Iseyin, Oyo State', interests: ['crops', 'irrigation', 'mechanisation'] },
  { key: 'specialist', email: 'folashade@agroinspo.test', name: 'Dr. Folashade Adeleke', role: 'specialist', title: 'Senior Agronomist & Soil Health Specialist', location: 'Ibadan, Oyo State', interests: ['soil-health', 'crops'], avatar: '/avatars/folashade.jpg' },
  { key: 'finance', email: 'finance@agroinspo.test', name: 'Finance Reviewer', role: 'admin', title: 'Finance · second approver for payouts', location: 'Lagos', interests: ['agribusiness'] },
  { key: 'vet', email: 'danladi@agroinspo.test', name: 'Dr. Ibrahim Danladi', role: 'specialist', title: 'Livestock Veterinarian & Poultry Pathologist', location: 'Kaduna / Zaria', interests: ['poultry', 'livestock'], avatar: '/avatars/danladi.jpg' },
  { key: 'engineer', email: 'lawal@agroinspo.test', name: 'Engr. Babatunde Lawal', role: 'specialist', title: 'Irrigation Engineer & Farm Mechanisation Lead', location: 'Abeokuta, Ogun State', interests: ['irrigation', 'mechanisation'], avatar: '/avatars/lawal.jpg' },
  { key: 'fish', email: 'chioma@agroinspo.test', name: 'Chioma Nwachukwu', role: 'specialist', title: 'Commercial Aquaculture Advisor', location: 'Warri / Port Harcourt', interests: ['aquaculture'], avatar: '/avatars/chioma.jpg' },
  { key: 'business', email: 'agriflow@agroinspo.test', name: 'AgriFlow Seed & Tech Ltd', role: 'business', title: 'Certified seed distributor', location: 'Ikeja, Lagos', interests: ['agribusiness', 'crops'] },
  { key: 'staff', email: 'kemi@agroinspo.test', name: 'Kemi Adeyemi', role: 'enthusiast', title: 'Sales lead, AgriFlow Seeds', location: 'Ibadan', interests: ['agribusiness', 'crops'] },
  { key: 'business2', email: 'sahel@agroinspo.test', name: 'Sahel Cold Chain Logistics', role: 'business', title: 'Refrigerated haulage for produce', location: 'Kano', interests: ['agribusiness', 'horticulture'] }
];

const ids = {};
db.tx(() => {
  for (const p of people) {
    const existing = db.get('SELECT id FROM users WHERE email = ?', p.email);
    if (existing) {
      ids[p.key] = existing.id;
      continue;
    }
    const id = newId();
    ids[p.key] = id;
    db.run(
      `INSERT INTO users (id, email, password_hash, name, role, title, location, interests, goals, privacy, notif_prefs,
         email_verified, onboarded, terms_accepted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)`,
      id, p.email, hashPassword(PASSWORD), p.name, p.role, p.title, p.location, JSON.stringify(p.interests), '[]',
      JSON.stringify({ profileVisibility: 'members', showLocation: true, showActivity: true }),
      JSON.stringify({ comments: true, likes: true, follows: true, email: true }), iso(5000), iso(5000), iso(5000)
    );
    for (const topic of p.interests)
      db.run('INSERT OR IGNORE INTO follows (user_id, target_type, target, created_at) VALUES (?,?,?,?)', id, 'topic', topic, iso(5000));
  }
  for (const p of people) {
    if (p.avatar) db.run('UPDATE users SET avatar_url = ? WHERE id = ?', p.avatar, ids[p.key]);
  }

  if (db.get('SELECT COUNT(*) AS n FROM posts').n === 0) {
    const posts = [
      [ids.specialist, 'crops', 180, 'Farmers often notice yellowing on lower leaves around V6 to V8 and rush to apply more NPK 15-15-15. In acidic savanna soils (pH below 5.8), check your soil pH first and consider side-dressing with calcium ammonium nitrate rather than raw urea during hot afternoons to limit ammonia loss.'],
      [ids.business, 'agribusiness', 1440, 'Dry-season irrigation starts with good seed. Our SAMMAZ 52 hybrid maize is available across South-West depots with NASC tamper-evident labels. Ask us for depot locations near you.', 1],
      [ids.enthusiast, 'bsf-insect-farming', 2880, 'Just finished a small 5-crate trial breeding black soldier fly larvae on spent brewer’s grain from a local brewery. Looking to connect with hatcheries interested in trial batches. Anyone in Ogun?'],
      [ids.farmer, 'irrigation', 4000, 'We switched block B to solar drip this season. Biggest lesson so far: flush the lines weekly, the borehole water carries more sediment than we expected. Happy to share the setup if it helps anyone planning dry-season maize.']
    ];
    for (const [author, topic, minsAgo, body, sponsored = 0] of posts) {
      db.run(
        'INSERT INTO posts (id, author_id, topic, body, is_sponsored, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        newId(), author, topic, body, sponsored, iso(minsAgo), iso(minsAgo)
      );
    }
  }

  // Phase 2 samples: live jobs and events.
  if (db.get('SELECT COUNT(*) AS n FROM jobs').n === 0) {
    const day = 86400000;
    const d = (n) => new Date(t0 + n * day).toISOString();
    const jobs = [
      [ids.farmer, 'Assistant Farm Manager (Grains & Tubers)', 'farm-management', 'full-time', 'Iseyin, Oyo State (housing provided)', 250000, 380000,
        'Help run 120 ha of maize and cassava: plan field operations, supervise equipment crews and keep input and harvest records.',
        ['Plan weekly field operations with the farm manager', 'Supervise tractor and boom-sprayer crews', 'Keep input, labour and harvest records'],
        ['B.Agric or HND in Agronomy or Agricultural Economics', 'At least 2 years on a commercial farm'], 'featured'],
      [ids.business, 'Technical Sales Agronomist (Irrigation & Seeds)', 'agribusiness-sales', 'full-time', 'Ibadan / South-West (field based)', 300000, 450000,
        'Run demonstration plots, advise farmers on hybrid seed and solar drip systems, and supervise installations across Oyo, Ogun and Osun.',
        ['Run on-farm trial plots', 'Quote and supervise solar pump installations', 'Support farmer clusters after sale'],
        ['B.Sc in Agronomy or related field', 'Valid driving licence'], 'standard'],
      [ids.farmer, 'Fish Farm Attendant', 'aquaculture', 'full-time', 'Iseyin, Oyo State', 90000, 120000,
        'Feed and monitor catfish in 24 tanks, test water quality daily and help with sorting and harvest.',
        ['Feed fish on schedule', 'Record water quality and mortality', 'Assist with sorting and harvest'],
        ['SSCE; aquaculture experience is a plus'], 'standard']
    ];
    for (const [emp, title, cat, type, loc, min, max, desc, resp, qual, plan] of jobs)
      db.run(
        `INSERT INTO jobs (id, employer_id, title, description, responsibilities, qualifications, category, employment_type, location,
           pay_min, pay_max, pay_period, openings, closing_date, plan, status, published_at, expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'month',1,?,?,'published',?,?,?,?)`,
        newId(), emp, title, desc, JSON.stringify(resp), JSON.stringify(qual), cat, type, loc, min, max,
        d(25).slice(0, 10), plan, d(-3), d(27), d(-4), d(-3)
      );

    const events = [
      ['Dry-Season Vegetable Economics: Solar Drip Setup & ROI', 'irrigation', d(2).slice(0, 11) + '15:00:00.000Z', 90, 0, 1, 'scheduled',
        'Capital costs for 2-hectare solar drip systems, discharge calculations per dripper, and planning dry-season pepper and cucumber cycles.'],
      ['Clinic: Newcastle Disease Prevention for Broiler Farms', 'poultry', d(5).slice(0, 11) + '10:00:00.000Z', 60, 2500, 1, 'scheduled',
        'Vaccination timing, cold-chain handling and farm biosecurity routines that keep Newcastle out of your houses.'],
      ['Soil Testing Basics for Smallholders', 'soil-health', d(-6).slice(0, 11) + '14:00:00.000Z', 60, 0, 1, 'ended',
        'How to take a representative soil sample, read a lab report and turn pH and NPK results into a fertiliser plan.']
    ];
    for (const [title, topic, starts, dur, price, rec, status, desc] of events) {
      const id = newId();
      db.run(
        `INSERT INTO events (id, host_id, title, description, topic, speakers, starts_at, duration_min, price_ngn, recording, status, room_id,
           replay_url, replay_published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ids.specialist, title, desc, topic, 'Dr. Folashade Adeleke', starts, dur, price, rec, status, `ev_${id.slice(0, 8)}`,
        status === 'ended' ? 'https://videos.example.com/agroinspo/soil-testing-basics' : '', status === 'ended' ? 1 : 0, d(-10), d(-10)
      );
    }
  }

  // Phase 3 samples: specialist profiles, services, open slots, a published book.
  if (db.get('SELECT COUNT(*) AS n FROM specialist_profiles').n === 0) {
    const day = 86400000;
    const specs = [
      [ids.specialist, 'Soil fertility and maize agronomy for savanna farms', ['Soil testing', 'Fertiliser planning', 'Maize & cassava'], 14,
        ['PhD Soil Science (University of Ibadan)', 'Registered Soil Scientist (SSSN)'], 'verified', 'Degree certificate and SSSN registration checked against issuer records.',
        [['Soil report review & fertiliser plan', 'soil-health', 'video', 45, 18000, 'Send your lab report before the call. You get a written fertiliser plan for one crop and one season.'],
         ['Quick crop problem call', 'crops', 'audio', 30, 10000, 'Describe the symptoms and share photos; we find the likely cause and next steps.']]],
      [ids.vet, 'Poultry health, vaccination plans and biosecurity', ['Broilers & layers', 'Vaccination schedules', 'Biosecurity'], 11,
        ['Doctor of Veterinary Medicine (ABU Zaria)', 'Member, Nigerian Veterinary Medical Association'], 'verified', 'DVM certificate and VCN licence number checked.',
        [['Flock health consultation', 'poultry', 'video', 60, 22000, 'Review mortality, vaccination records and house conditions; leave with a written action list.']]],
      [ids.engineer, 'Solar drip irrigation design and farm machinery', ['Drip & sprinkler design', 'Solar pumping', 'Tractor maintenance'], 9,
        ['B.Eng Agricultural Engineering', 'COREN registered'], 'pending', '',
        [['Irrigation design review', 'irrigation', 'video', 60, 25000, 'Share your farm size, water source and crops; we size the pump, lines and emitters.']]],
      [ids.fish, 'Catfish and tilapia farm setup and water quality', ['Pond & tank design', 'Water quality', 'Hatchery'], 8,
        ['M.Sc Fisheries & Aquaculture (UNN)'], 'unverified', '',
        [['Fish farm troubleshooting', 'aquaculture', 'audio', 45, 16000, 'Talk through mortality, feeding and water tests; get a checklist for the next two weeks.']]]
    ];
    for (const [uid, headline, specialties, years, creds, status, note, services] of specs) {
      db.run(`INSERT INTO specialist_profiles (user_id, headline, specialties, languages, service_area, experience_years, credentials, credential_status, credential_note, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, uid, headline, JSON.stringify(specialties), JSON.stringify(['English', 'Yoruba', 'Hausa'].slice(0, 2)),
        'Nationwide (online)', years, JSON.stringify(creds), status, status === 'verified' ? `${note} Checked by Agro Inspo on ${iso(10000).slice(0, 10)}.` : note, iso(9000));
      for (const [title, topic, mode, dur, price, desc] of services)
        db.run('INSERT INTO consultation_services (id, specialist_id, title, description, topic, mode, duration_min, price_ngn, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          newId(), uid, title, desc, topic, mode, dur, price, iso(9000), iso(9000));
      for (let d = 1; d <= 10; d++)
        for (const h of [8, 10, 13, 15]) {
          const t = new Date(t0 + d * day);
          t.setUTCHours(h, 0, 0, 0);
          db.run('INSERT OR IGNORE INTO availability_slots (id, specialist_id, starts_at, duration_min, created_at) VALUES (?,?,?,?,?)', newId(), uid, t.toISOString(), 60, iso(100));
        }
    }

    // A published handbook with a real cover image and a small PDF.
    const here = dirname(fileURLToPath(import.meta.url));
    const uploads = process.env.UPLOAD_DIR || join(here, '..', 'data', 'uploads');
    mkdirSync(uploads, { recursive: true });
    const addFile = (owner, kind, filename, mime, buf) => {
      const id = newId();
      writeFileSync(join(uploads, id), buf);
      db.run('INSERT INTO files (id, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, owner, kind, filename, mime, buf.length, createHash('sha256').update(buf).digest('hex'), id, iso(8000));
      return id;
    };
    const pdf = (title) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 60 760 Td (${title}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);
    const coverImg = readFileSync(join(here, 'seed-assets', 'african_agronomist_field_1793019544274.jpg'));
    const books = [
      [ids.specialist, 'Soil Testing for Smallholders', 'From sampling to a fertiliser plan', 'soil-health', 4500, 72,
        'How to take a proper composite soil sample, read a Nigerian lab report, and turn pH, organic matter and NPK numbers into a fertiliser plan for maize and cassava.'],
      [ids.vet, 'Broiler Biosecurity Handbook', 'Keeping Newcastle and Gumboro out', 'poultry', 6000, 96,
        'Practical routines for footbaths, visitor control, litter management, vaccination timing and cold-chain handling for small and medium broiler farms.']
    ];
    for (const [author, title, subtitle, topic, price, pages, desc] of books) {
      const cover = addFile(author, 'cover', 'cover.jpg', 'image/jpeg', coverImg);
      const file = addFile(author, 'book', `${title}.pdf`, 'application/pdf', pdf(title));
      const sample = addFile(author, 'book_sample', `${title} (sample).pdf`, 'application/pdf', pdf(`${title} - sample chapter`));
      db.run(`INSERT INTO books (id, author_id, title, subtitle, description, topic, pages, price_ngn, cover_file_id, sample_file_id, book_file_id, status, rights_declared_at, published_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?, 'published', ?,?,?,?)`, newId(), author, title, subtitle, desc, topic, pages, price, cover, sample, file, iso(7000), iso(7000), iso(7000), iso(7000));
    }
  }

  // Phase 4 samples: a verified business with listings, live adverts and a sponsorship package,
  // plus a second business waiting for verification.
  if (db.get('SELECT COUNT(*) AS n FROM business_profiles').n === 0) {
    const here4 = dirname(fileURLToPath(import.meta.url));
    const uploads4 = process.env.UPLOAD_DIR || join(here4, '..', 'data', 'uploads');
    mkdirSync(uploads4, { recursive: true });
    const img = (name) => readFileSync(join(here4, 'seed-assets', name));
    const add4 = (owner, kind, filename, mime, buf) => {
      const id = newId();
      writeFileSync(join(uploads4, id), buf);
      db.run('INSERT INTO files (id, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, owner, kind, filename, mime, buf.length, createHash('sha256').update(buf).digest('hex'), id, iso(500));
      return id;
    };
    const evidencePdf = Buffer.from('%PDF-1.4\n% Sample CAC certificate (demo)\n%%EOF');
    db.run(`INSERT INTO business_profiles (user_id, legal_name, trading_name, category, rc_number, address, region, service_area, contact_name, contact_role, phone, website, about,
              verification_status, verification_scope, evidence, submitted_at, verified_at, verified_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'verified',?,?,?,?,?,?,?)`,
      ids.business, 'AgriFlow Seed & Tech Limited', 'AgriFlow Seeds', 'inputs', 'RC1789234', '22 Oba Akran Avenue, Ikeja, Lagos', 'Lagos', 'Lagos, Ogun, Oyo and Osun (depots in Ikeja, Abeokuta and Ibadan)',
      'Bisi Okonkwo', 'Head of sales', '+234 802 555 0101', 'https://agriflow.example', 'Licensed distributor of NASC-certified hybrid maize, rice and vegetable seed, with agronomy support at every depot.',
      'CAC registration RC1789234 confirmed on the CAC public search; director’s ID matched; NASC seed dealer licence seen.',
      JSON.stringify([{ fileId: add4(ids.business, 'business_evidence', 'cac-certificate.pdf', 'application/pdf', evidencePdf), label: 'CAC certificate' }]),
      iso(4000), iso(3000), ids.admin, iso(5000), iso(3000));
    db.run(`INSERT INTO business_profiles (user_id, legal_name, trading_name, category, rc_number, address, region, service_area, contact_name, contact_role, phone, about,
              verification_status, evidence, submitted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      ids.business2, 'Sahel Cold Chain Logistics Ltd', 'Sahel Cold Chain', 'logistics', 'RC2045511', 'Plot 7 Sharada Industrial Estate, Kano', 'Kano', 'Northern states to Lagos and Port Harcourt',
      'Musa Bello', 'Managing director', '+234 806 555 0199', 'Refrigerated trucks for tomatoes, peppers and dairy from northern farms to southern markets.',
      JSON.stringify([{ fileId: add4(ids.business2, 'business_evidence', 'cac.pdf', 'application/pdf', evidencePdf), label: 'CAC certificate' }]), iso(90), iso(600), iso(90));

    const listings = [
      ['product', 'SAMMAZ 52 hybrid maize seed', 'NASC-certified, early-maturing hybrid maize for the savanna. Tamper-evident 20 kg bags; agronomist advice included at the depot.', 'crops', 'from', 42000, 'per 20 kg bag', 'modern_nigerian_farm_1793019543177.jpg'],
      ['product', 'FARO 66 rice seed (certified)', 'Flood-tolerant lowland rice seed with germination test certificate. Bulk discounts for cooperatives.', 'crops', 'fixed', 38000, 'per 25 kg bag', 'farm_cassava_harvest_1793018068561.jpg'],
      ['service', 'Depot soil testing & seed advice', 'Bring a composite soil sample to any depot; we send it to a partner lab and go through the results with you.', 'soil-health', 'quote', null, '', 'african_agronomist_field_1793019544274.jpg']
    ];
    const listingIds = [];
    for (const [kind, title, desc, topic, pt, price, unit, image] of listings) {
      const id = newId();
      listingIds.push(id);
      db.run(`INSERT INTO business_listings (id, business_id, kind, title, description, topic, price_type, price_ngn, unit, service_area, availability, image_file_id, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'published', ?, ?)`,
        id, ids.business, kind, title, desc, topic, pt, price, unit, 'Lagos, Ogun, Oyo, Osun', 'In stock', add4(ids.business, 'listing_image', image, 'image/jpeg', img(image)), iso(2000), iso(2000));
    }
    const ymd = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const ads = [
      ['feed', 'fortnight', 14, 'Certified SAMMAZ 52 maize seed, in stock now', 'Early-maturing hybrid for the savanna. NASC-labelled 20 kg bags at our Ikeja, Abeokuta and Ibadan depots, with free agronomy advice.', 'enquire', listingIds[0], '', 'crops', 25000, 'modern_nigerian_farm_1793019543177.jpg'],
      ['events', 'week', 7, 'Free soil test advice at AgriFlow depots', 'Bring a soil sample this month and talk through your fertiliser plan with our agronomists before planting.', 'enquire', listingIds[2], '', '', 10000, 'african_agronomist_field_1793019544274.jpg'],
      ['jobs', 'week', 7, 'AgriFlow is hiring field agronomists', 'Field-based technical sales roles across the South-West. See the listing on the jobs board or visit our careers page.', 'website', null, 'https://agriflow.example/careers', '', 10000, 'smart_drone_agritech_1793019543627.jpg']
    ];
    for (const [placement, pkg, days, headline, body, cta, listingId, url, topic, price, image] of ads) {
      const adId = newId();
      // A paid (simulated) Kora payment and the matching platform income, as a real checkout would leave them.
      const payId = newId();
      db.run(`INSERT INTO payments (id, reference, user_id, purpose, subject_id, description, amount_ngn, fee_ngn, provider, status, paid_at, created_at, updated_at)
              VALUES (?,?,?, 'advert', ?,?,?,?, 'kora-dummy', 'successful', ?,?,?)`,
        payId, `AI-AD-SEED${adId.slice(0, 6).toUpperCase()}`, ids.business, adId, `Advert: ${headline}`, price, Math.min(2000, Math.round(price * 0.015)), iso(3000), iso(3000), iso(3000));
      db.run(`INSERT INTO ledger_entries (id, account_id, entry_type, amount_ngn, source_type, source_id, payment_id, available_at, memo, created_at) VALUES (?, NULL, 'sale', ?, 'advert', ?, ?, ?, ?, ?)`,
        newId(), price, adId, payId, iso(3000), `Advert: ${headline}`, iso(3000));
      db.run(`INSERT INTO ledger_entries (id, account_id, entry_type, amount_ngn, source_type, source_id, payment_id, available_at, memo, created_at) VALUES (?, NULL, 'provider_fee', ?, 'advert', ?, ?, ?, 'Kora fee', ?)`,
        newId(), -Math.min(2000, Math.round(price * 0.015)), adId, payId, iso(3000), iso(3000));
      db.run(`INSERT INTO ad_campaigns (id, business_id, placement, package, days, headline, body, image_file_id, cta, listing_id, url, target_topic, target_region, starts_on, ends_on, price_ngn, flags, status, payment_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,?,'[]','approved',?,?,?)`,
        adId, ids.business, placement, pkg, days, headline, body, add4(ids.business, 'ad_image', image, 'image/jpeg', img(image)), cta, listingId, url, topic,
        ymd(-2), ymd(days - 3), price, payId, iso(3000), iso(3000));
    }
    const nextEvent = db.get("SELECT id FROM events WHERE status = 'scheduled' AND price_ngn = 0 ORDER BY starts_at LIMIT 1");
    if (nextEvent) {
      db.run(`INSERT INTO sponsorship_packages (id, event_id, name, price_ngn, benefits, deliverables, speaking_slot, exclusive, slots, cancellation, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        newId(), nextEvent.id, 'Session sponsor', 75000,
        'Your logo and a short description on the event page and in the reminder notifications, two verbal mentions during the session, and a 5-minute product slot before Q&A.',
        JSON.stringify(['Logo and description on the event page', 'Name in reminder notifications', 'Two verbal mentions during the session', '5-minute product slot before Q&A']),
        1, 0, 1, 'Full refund if the event is cancelled, or if you cancel at least 72 hours before it starts. No refund after that.', iso(1000));
      db.run(`INSERT INTO sponsorship_packages (id, event_id, name, price_ngn, benefits, deliverables, speaking_slot, exclusive, slots, cancellation, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        newId(), nextEvent.id, 'Resource partner', 25000,
        'Your name and a link to one free resource (guide, price list or video) in the event’s resources section, plus one verbal thank-you.',
        JSON.stringify(['Link to your resource on the event page', 'One verbal thank-you']), 0, 0, 3, '', iso(1000));
    }
  }

  // Phase 4 teams: Kemi handles AgriFlow's leads; Tunde has a pending invitation to its marketing team.
  if (db.get('SELECT COUNT(*) AS n FROM business_members').n === 0 && ids.business && ids.staff) {
    db.run("INSERT INTO business_members (business_id, user_id, role, added_by, created_at) VALUES (?,?, 'sales', ?, ?)", ids.business, ids.staff, ids.business, iso(2000));
    db.run("INSERT INTO business_invites (id, business_id, email, role, invited_by, expires_at, created_at) VALUES (?,?,?, 'marketing', ?, ?, ?)",
      newId(), ids.business, 'tunde@agroinspo.test', ids.business, new Date(Date.now() + 10 * 86400000).toISOString(), iso(60));
  }
});

console.log(`Seeded ${people.length} demo accounts. Password for all: ${PASSWORD}`);
for (const p of people) console.log(`  ${p.role.padEnd(11)} ${p.email}`);
db.close();
