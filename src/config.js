// Commercial settings. PLACEHOLDERS until the product owner approves the rate card
// (Build Tracker: "Approve rate card", PRD §28.2). Change here or via environment.

export const JOB_PLANS = {
  standard: {
    label: 'Standard listing',
    days: 30,
    priceNgn: Number(process.env.JOB_FEE_STANDARD_NGN || 10000),
    description: 'Listed for 30 days in search and job alerts.'
  },
  featured: {
    label: 'Featured listing',
    days: 30,
    priceNgn: Number(process.env.JOB_FEE_FEATURED_NGN || 25000),
    description: 'Listed for 30 days, pinned to the top of results and highlighted in job alerts.'
  }
};

export const JOB_CATEGORIES = [
  'farm-management', 'crop-production', 'livestock-poultry', 'aquaculture', 'agronomy-extension',
  'agribusiness-sales', 'processing-storage', 'machinery-irrigation', 'research-lab', 'admin-finance'
];

// Phrases that often appear in recruitment scams (PRD §25.2 "screen for … suspicious requests
// for payment"). A match never blocks a listing; it flags it for the human reviewer.
export const SCAM_PATTERNS = [
  { re: /\b(registration|application|processing|training|form|medical)\s+fee\b/i, flag: 'Mentions a fee for candidates' },
  { re: /\bpay\b.{0,30}\b(to apply|before (the )?interview|for (the )?(form|uniform|training))\b/i, flag: 'Asks candidates to pay' },
  { re: /\b(whatsapp|telegram)\s+only\b/i, flag: 'Contact only through a private messaging app' },
  { re: /\b(guaranteed|100%)\s+(job|employment|placement)\b/i, flag: 'Guarantees employment' },
  { re: /\b(bvn|atm card|bank (pin|password))\b/i, flag: 'Asks for banking credentials' },
  { re: /\b(urgent(ly)?|immediate(ly)?)\b.{0,20}\b(transfer|send money|deposit)\b/i, flag: 'Urgent money transfer language' }
];

export const MAX_CV_BYTES = 5 * 1024 * 1024;
export const CV_TYPES = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

/* ---------- Phase 3: money rules. PLACEHOLDERS pending product-owner approval (PRD §28.2, §37). ---------- */
const pct = (v, d) => Number(process.env[v] ?? d);
export const COMMISSION = {
  consultation: pct('COMMISSION_CONSULTATION_PCT', 15) / 100,
  event_ticket: pct('COMMISSION_EVENT_PCT', 15) / 100,
  book_purchase: pct('COMMISSION_BOOK_PCT', 20) / 100,
  sponsorship: pct('COMMISSION_SPONSORSHIP_PCT', 15) / 100
};
// Days after the sale event before earnings become available (dispute/refund windows).
export const HOLD_DAYS = {
  consultation: pct('HOLD_DAYS_CONSULTATION', 3),
  event_ticket: pct('HOLD_DAYS_EVENT', 3),
  book_purchase: pct('HOLD_DAYS_BOOK', 7),
  sponsorship: pct('HOLD_DAYS_SPONSORSHIP', 7)       // counted from the event's end
};
export const MIN_PAYOUT_NGN = pct('MIN_PAYOUT_NGN', 5000);
export const CLIENT_FREE_CANCEL_HOURS = pct('CLIENT_FREE_CANCEL_HOURS', 24);
export const BOOK_REFUND_DAYS = pct('BOOK_REFUND_DAYS', 7);
export const SLOT_HOLD_MINUTES = 30;   // a slot is held this long while the client pays
export const ALLOW_SELF_APPROVAL = process.env.ALLOW_PAYOUT_SELF_APPROVAL === '1'; // dev only; maker-checker otherwise

export const MAX_BOOK_BYTES = 50 * 1024 * 1024;
export const BOOK_TYPES = { 'application/pdf': '.pdf', 'application/epub+zip': '.epub' };
export const COVER_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/* ---------- Phase 4: business & advertising. PLACEHOLDER prices pending the rate card (PRD §30). ---------- */
export const BUSINESS_CATEGORIES = {
  inputs: 'Seeds, fertiliser & crop inputs',
  'animal-health': 'Feed & animal health',
  equipment: 'Equipment & mechanisation',
  irrigation: 'Irrigation & energy',
  processing: 'Processing & storage',
  logistics: 'Logistics & cold chain',
  finance: 'Finance & insurance',
  services: 'Agronomy & farm services',
  cooperative: 'Cooperative / farmer group',
  training: 'Training & education',
  other: 'Other agricultural business'
};

// Placement × duration price list. Price shown in full before checkout.
const adPrice = (env, d) => Number(process.env[env] || d);
export const AD_PLACEMENTS = {
  feed: { label: 'Community feed', description: 'A labelled “Sponsored” card between posts, matched to the reader’s topics when you target one.' },
  events: { label: 'Events page', description: 'A labelled card at the top of the events list.' },
  jobs: { label: 'Jobs board', description: 'A labelled card beside job listings.' }
};
export const AD_PACKAGES = {
  week: { label: '7 days', days: 7, prices: { feed: adPrice('AD_FEED_7D_NGN', 15000), events: adPrice('AD_EVENTS_7D_NGN', 10000), jobs: adPrice('AD_JOBS_7D_NGN', 10000) } },
  fortnight: { label: '14 days', days: 14, prices: { feed: adPrice('AD_FEED_14D_NGN', 25000), events: adPrice('AD_EVENTS_14D_NGN', 17000), jobs: adPrice('AD_JOBS_14D_NGN', 17000) } },
  month: { label: '30 days', days: 30, prices: { feed: adPrice('AD_FEED_30D_NGN', 45000), events: adPrice('AD_EVENTS_30D_NGN', 30000), jobs: adPrice('AD_JOBS_30D_NGN', 30000) } }
};

// Restricted or prohibited advert content (PRD §30 "restricted/prohibited products"). A match
// never auto-rejects; it flags the advert so the reviewer checks it against the Advertising Policy.
export const AD_RESTRICTED_PATTERNS = [
  { re: /\b(guaranteed|assured|fixed)\s+(returns?|profits?|income|roi)\b|\b\d{1,3}\s?%\s+(returns?|roi|profit)\b/i, flag: 'Promises investment returns (investment adverts are not allowed)' },
  { re: /\b(double|triple)\s+your\s+(money|yield|harvest)\b/i, flag: 'Exaggerated outcome claim' },
  { re: /\b(paraquat|lindane|endosulfan|aldrin|dieldrin|ddt|carbofuran|monocrotophos)\b/i, flag: 'Names a banned or severely restricted pesticide' },
  { re: /\b(antibiotics?|oxytetracycline|tylosin|enrofloxacin)\b.{0,40}\b(growth|without (a )?prescription|no prescription)\b/i, flag: 'Antibiotics for growth or without a prescription' },
  { re: /\b(no (nafdac|son) (number|approval) needed|unregistered)\b/i, flag: 'Suggests an unregistered product' },
  { re: /\b(crypto|forex|bitcoin|mlm|ponzi|referral bonus)\b/i, flag: 'Financial scheme language' },
  { re: /\b(100%|guaranteed)\s+(cure|germination|survival)\b/i, flag: 'Guaranteed result claim' }
];
export const AD_IMAGE_TYPES = COVER_TYPES;
export const EVIDENCE_TYPES = { 'application/pdf': '.pdf', ...COVER_TYPES };
