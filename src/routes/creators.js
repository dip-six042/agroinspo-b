// Creator screening (PRD §26): topic quiz + sample → human review → publishing rights for that topic only.
// A passed quiz is a knowledge check, not a licence or accreditation, and the UI says so.
import { newId, now } from '../security.js';

const PASS_PCT = 80;
const RETEST_DAYS_FAILED = 7;
const RETEST_DAYS_REJECTED = 30;
const RESCREEN_MONTHS = 12;

// Questions are kept on the server; clients never receive the answers.
// [question, options[], correct index]
const GENERAL = [
  ['You’re not sure of the right pesticide dose for a crop. What should your post say?', ['Give your best guess so farmers can act quickly', 'Follow the product label and local regulations, and suggest checking with an extension officer', 'Recommend doubling the dose to be safe', 'Say any dose works if applied in the evening'], 1],
  ['A company pays you to mention its fertiliser. How must the post appear?', ['As a normal post, so it feels authentic', 'Clearly labelled as sponsored', 'Only mention the brand in comments', 'It can’t be posted at all'], 1],
  ['You share a result from your own farm trial. What’s the honest way to present it?', ['As proof the method always works', 'With the conditions, scale and that results can differ elsewhere', 'Round the numbers up so they’re memorable', 'Leave out the costs to keep it simple'], 1]
];
const BANK = {
  crops: [
    ['What is the most reliable way to decide how much fertiliser a field needs?', ['Copy what a neighbour uses', 'A soil test, interpreted against the crop’s needs', 'Apply double the bag recommendation', 'Judge by leaf colour alone'], 1],
    ['In maize, nitrogen deficiency usually first shows as…', ['Purple colouring on the youngest leaves', 'Yellowing that starts on the older, lower leaves', 'White spots on the cobs', 'Wilting only at midday'], 1],
    ['Ragged holes in the maize whorl with sawdust-like frass most likely point to…', ['Fall armyworm', 'Nitrogen excess', 'Frost damage', 'Boron toxicity'], 0],
    ['Why rotate crops between seasons?', ['It always doubles yield', 'To break pest and disease cycles and manage soil fertility', 'Because seed companies require it', 'It removes the need for fertiliser'], 1]
  ],
  poultry: [
    ['What is the core of Newcastle disease prevention?', ['Antibiotics in drinking water', 'Vaccination on schedule plus farm biosecurity', 'Extra feed during cold weather', 'Vitamins alone'], 1],
    ['What is a footbath at the poultry house entrance for?', ['Cooling workers’ feet', 'Reducing disease agents carried in on footwear', 'Measuring humidity', 'Washing feeders'], 1],
    ['“All-in, all-out” management means…', ['Feeding all birds at once', 'Placing and removing a flock together, then cleaning, disinfecting and resting the house', 'Letting birds roam in and out freely', 'Vaccinating all ages on the same day'], 1],
    ['Day-old chicks crowding tightly under the heat source usually means…', ['They are too hot', 'They are too cold', 'They are hungry', 'Lighting is too bright'], 1]
  ],
  'soil-health': [
    ['Which material is commonly used to correct acidic soils?', ['Urea', 'Agricultural lime', 'Table salt', 'Elemental sulphur'], 1],
    ['A good soil sample for a field is…', ['One scoop from the best-looking spot', 'A mix of sub-samples taken across the field at the same depth', 'Topsoil from the field edge', 'Soil taken right after fertilising'], 1],
    ['Raising soil organic matter generally…', ['Reduces water holding', 'Improves water holding and nutrient retention', 'Makes soil more acidic in all cases', 'Has no effect on soil life'], 1],
    ['A soil pH of 7 is…', ['Strongly acidic', 'Neutral', 'Strongly alkaline', 'Saline'], 1]
  ],
  aquaculture: [
    ['Catfish gasping at the surface in the early morning most likely signals…', ['They want feed', 'Low dissolved oxygen', 'The water is too clear', 'They are ready to spawn'], 1],
    ['Overfeeding fish in a pond or tank mainly leads to…', ['Faster growth with no downside', 'Poor water quality and ammonia build-up', 'Lower water temperature', 'Fewer algae'], 1],
    ['Before stocking new fingerlings you should…', ['Release them straight in to reduce stress', 'Let them adjust gradually to the pond water temperature', 'Starve the pond for a week', 'Add salt to the bag'], 1],
    ['Sorting catfish by size mainly reduces…', ['Cannibalism and uneven growth', 'Water changes', 'Feed costs to zero', 'The need for oxygen'], 0]
  ],
  livestock: [
    ['Ruminants are at higher risk of bloat when…', ['They graze dry hay', 'They suddenly get large amounts of lush legume pasture', 'They drink clean water', 'They are kept in shade'], 1],
    ['A sound deworming approach is…', ['Dose every week whether needed or not', 'Follow a vet-advised plan, using checks such as faecal tests', 'Never deworm', 'Use half doses to save money'], 1],
    ['How should animal vaccines be stored?', ['In the sun to keep them warm', 'As the label says, usually in a cold chain', 'Mixed with feed', 'Opened and reused across weeks'], 1],
    ['Livestock should have clean drinking water…', ['Once a day', 'At all times', 'Only in the dry season', 'Only after feeding'], 1]
  ],
  irrigation: [
    ['The main advantage of drip irrigation is…', ['It needs no maintenance', 'Water goes to the root zone with less loss', 'It works without any pressure', 'It replaces fertiliser'], 1],
    ['Blocked drippers are best prevented by…', ['Bigger pumps', 'Filtering water and flushing the lines regularly', 'Running only at noon', 'Adding sand to the tank'], 1],
    ['In the hot season, the best time to irrigate is usually…', ['Midday', 'Early morning or evening', 'Any time; it makes no difference', 'Only at night after rain'], 1],
    ['A common result of overwatering is…', ['Better root growth', 'Waterlogging, root disease and nutrients washing away', 'Higher soil oxygen', 'Fewer weeds'], 1]
  ]
};
export const questionsFor = (topic) => [...(BANK[topic] || []), ...GENERAL].map(([q, options, answer], i) => ({ id: `${topic}-${i}`, q, options, answer }));

export function registerCreators(kit) {
  const { db, route, audit, notify, HttpError, bad, str, oneOf, requireVerified } = kit;
  const TOPICS = ['crops', 'poultry', 'livestock', 'aquaculture', 'soil-health', 'irrigation', 'horticulture', 'bsf-insect-farming', 'mechanisation', 'agribusiness', 'careers'];

  kit.isCreator = (userId, topic) => !!db.get('SELECT 1 FROM creator_topics WHERE user_id = ? AND topic = ? AND revoked_at IS NULL', userId, topic);

  route('GET', '/api/creator/quiz/:topic', (ctx) => {
    const topic = oneOf(ctx.params.topic, TOPICS, 'Topic');
    return {
      topic,
      passPct: PASS_PCT,
      interviewNote: BANK[topic] ? '' : 'This topic doesn’t have a specialist question set yet, so a reviewer will look closely at your sample and may ask for a short interview.',
      questions: questionsFor(topic).map(({ id, q, options }) => ({ id, q, options }))
    };
  });

  route('GET', '/api/me/creator', (ctx) => ({
    topics: db.all('SELECT topic, approved_at, review_by FROM creator_topics WHERE user_id = ? AND revoked_at IS NULL', ctx.user.id)
      .map((t) => ({ topic: t.topic, approvedAt: t.approved_at, reviewBy: t.review_by })),
    applications: db.all('SELECT * FROM creator_applications WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id)
      .map((a) => ({ id: a.id, topic: a.topic, status: a.status, score: a.quiz_score, note: a.review_note, retestAfter: a.retest_after, createdAt: a.created_at }))
  }), { auth: true });

  route('POST', '/api/creator/applications', (ctx) => {
    requireVerified(ctx);
    const topic = oneOf(ctx.body.topic, TOPICS, 'Topic');
    if (kit.isCreator(ctx.user.id, topic)) throw bad('You’re already approved for this topic.');
    const last = db.get('SELECT * FROM creator_applications WHERE user_id = ? AND topic = ? ORDER BY created_at DESC', ctx.user.id, topic);
    if (last?.status === 'pending' || last?.status === 'info_requested') throw new HttpError(409, 'pending', 'You already have an application in review for this topic.');
    if (last?.retest_after && last.retest_after > now()) throw bad(`You can apply again for this topic after ${last.retest_after.slice(0, 10)}.`);
    if (ctx.body.acceptTerms !== true) throw bad('Accept the Creator Policy to continue.');
    const sample = str(ctx.body.sample, 'Sample', { min: 200, max: 5000 });
    const answers = ctx.body.answers && typeof ctx.body.answers === 'object' ? ctx.body.answers : {};
    const qs = questionsFor(topic);
    const correct = qs.filter((q) => Number(answers[q.id]) === q.answer).length;
    const score = Math.round((correct / qs.length) * 100);
    const passed = score >= PASS_PCT;
    const id = newId();
    db.run(
      `INSERT INTO creator_applications (id, user_id, topic, sample, quiz_score, quiz_answers, status, retest_after, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, ctx.user.id, topic, sample, score, JSON.stringify(answers), passed ? 'pending' : 'failed_quiz',
      passed ? null : new Date(Date.now() + RETEST_DAYS_FAILED * 86400000).toISOString(), now()
    );
    if (passed) for (const a of db.all("SELECT id FROM users WHERE role='admin' AND status='active'")) notify(a.id, 'review', 'Creator application to review', `${ctx.user.name} · ${topic}`, 'admin:creators');
    return { status: 201, body: { application: { id, status: passed ? 'pending' : 'failed_quiz', score, passPct: PASS_PCT, correct, total: qs.length } } };
  }, { auth: true });

  route('GET', '/api/admin/creator-applications', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'pending', ['pending', 'approved', 'rejected', 'info_requested', 'failed_quiz'], 'Status');
    return {
      applications: db.all(
        `SELECT a.*, u.name, u.role, u.title FROM creator_applications a JOIN users u ON u.id = a.user_id WHERE a.status = ? ORDER BY a.created_at`, status
      ).map((a) => ({ id: a.id, topic: a.topic, sample: a.sample, score: a.quiz_score, status: a.status, note: a.review_note, createdAt: a.created_at, user: { id: a.user_id, name: a.name, role: a.role, title: a.title } }))
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/creator-applications/:id/decide', (ctx) => {
    const a = db.get('SELECT * FROM creator_applications WHERE id = ?', ctx.params.id);
    if (!a) throw new HttpError(404, 'not_found', 'Application not found.');
    if (!['pending', 'info_requested'].includes(a.status)) throw bad('This application has already been decided.');
    const decision = oneOf(ctx.body.decision, ['approved', 'rejected', 'info_requested'], 'Decision');
    const note = str(ctx.body.note, 'Note', { min: decision === 'approved' ? 0 : 10, max: 1000 });
    db.tx(() => {
      db.run('UPDATE creator_applications SET status = ?, reviewer_id = ?, review_note = ?, decided_at = ?, retest_after = ? WHERE id = ?',
        decision, ctx.user.id, note, now(), decision === 'rejected' ? new Date(Date.now() + RETEST_DAYS_REJECTED * 86400000).toISOString() : null, a.id);
      if (decision === 'approved') {
        const review = new Date();
        review.setMonth(review.getMonth() + RESCREEN_MONTHS);
        db.run(
          `INSERT INTO creator_topics (user_id, topic, approved_by, approved_at, review_by) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id, topic) DO UPDATE SET approved_by=excluded.approved_by, approved_at=excluded.approved_at, review_by=excluded.review_by, revoked_at=NULL`,
          a.user_id, a.topic, ctx.user.id, now(), review.toISOString()
        );
      }
      audit(ctx, `creator.${decision}`, 'user', a.user_id, { topic: a.topic, score: a.quiz_score, note });
    });
    const msg = {
      approved: [`You can now publish articles on ${a.topic}`, 'Your screened-creator badge covers this topic only.'],
      rejected: ['Creator application not approved', `${note} You can apply again after ${RETEST_DAYS_REJECTED} days, or contact support to appeal.`],
      info_requested: ['We need a little more from you', note]
    }[decision];
    notify(a.user_id, 'review', msg[0], msg[1], 'creator');
    return { ok: true };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/creators/:userId/revoke', (ctx) => {
    const topic = oneOf(ctx.body.topic, TOPICS, 'Topic');
    const reason = str(ctx.body.reason, 'Reason', { min: 10, max: 500 });
    db.run('UPDATE creator_topics SET revoked_at = ? WHERE user_id = ? AND topic = ?', now(), ctx.params.userId, topic);
    audit(ctx, 'creator.revoked', 'user', ctx.params.userId, { topic, reason });
    notify(ctx.params.userId, 'moderation', `Creator rights removed for ${topic}`, reason, 'creator');
    return { ok: true };
  }, { roles: ['admin'] });
}
