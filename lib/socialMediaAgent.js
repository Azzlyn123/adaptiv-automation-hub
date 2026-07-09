// Adaptiv Athletics — Social Media Agent
//
// Step 10. Tracks posted content performance, incoming comments/DMs/
// mentions, a content idea backlog, and a content calendar — and drafts
// (never sends/posts) outreach-style content and replies for a human to
// review. This is Layer 1 (manual/works-now): every number and comment is
// entered by the founder/team today. Layer 2 (future): once
// YouTube/TikTok/X/Meta API credentials are wired up, the same Notion
// schema and the same safety rules apply — only the data source changes
// from manual entry to a live API pull.
//
// SAFETY RULES (Step 10 — do not remove or weaken):
//   - Never post, publish, or schedule content automatically.
//   - Never reply to a comment, DM, or mention automatically.
//   - Never delete, hide, or moderate a comment automatically.
//   - Never follow, unfollow, like, or otherwise act on another account.
//   - All outbound content (captions, replies, posts) requires manual
//     human approval and manual publishing — this service can only draft.
//   - Create drafts, ideas, tasks, and reports only.
//   - Never fabricate engagement numbers — Social Metrics rows only ever
//     reflect data explicitly provided by the caller (Layer 1) or a real
//     platform API response (Layer 2) — never estimated/guessed.
//
// These rules are enforced in code, not just documented:
//   - buildContentCalendarProperties() always writes Approved: false and
//     Status defaults to "Needs Approval" — no code path in this module
//     can mark calendar content Approved or Posted.
//   - buildSocialInboxProperties() always writes Approved: false and never
//     writes Status "Replied" — moving a comment to Replied (i.e.
//     confirming a human actually posted the reply) is a manual, human-only
//     edit made directly in Notion.
//   - generateContentDraft() / generateReplyDraft() are both deterministic
//     templates (no auto-posting API call exists anywhere in this file) and
//     never claim guaranteed results.
//   - gatherSocialMediaSummary() is read-only — it never creates or edits a
//     Social Metrics, Content Calendar, Social Inbox, or Social Ideas row.
//
// Notion databases used:
//   - Social Metrics: Post (title), Platform (select), Date Posted (date),
//     URL (url), Views (number), Likes (number), Comments (number),
//     Shares (number), Saves (number), Watch Time (number),
//     Engagement Rate (number), Notes (rich_text)
//   - Content Calendar: Content Title (title), Platform (select),
//     Status (select), Content Type (select), Hook (rich_text),
//     Caption (rich_text), CTA (rich_text), Owner (rich_text),
//     Publish Date (date), Approved (checkbox)
//   - Social Inbox: Message/Comment (title), Platform (select),
//     User (rich_text), URL (url), Sentiment (select),
//     Needs Reply (checkbox), Draft Reply (rich_text), Approved (checkbox),
//     Status (select)
//   - Social Ideas: Idea (title), Platform (select), Content Type (select),
//     Status (select), Notes (rich_text), Date Added (date) — read-only in
//     this module (backlog count only); no route in this file writes to it.

// ---------------------------------------------------------------------------
// Valid select-field values (must match the live Notion schema exactly)
// ---------------------------------------------------------------------------
const VALID_PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'X'];
const VALID_IDEA_PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'X', 'Any'];

const VALID_CONTENT_TYPES = [
  'Founder Story',
  'Training Tip',
  'Coach Tool',
  'Film AI Demo',
  'Athlete Result',
  'App Demo',
  'Behind the Scenes',
  'Testimonial',
  'Launch Post',
];

const VALID_CALENDAR_STATUSES = ['Idea', 'Draft', 'Needs Approval', 'Approved', 'Posted', 'Repurpose', 'Rejected'];

const VALID_SENTIMENTS = ['Positive', 'Neutral', 'Negative', 'Lead', 'Support Issue', 'Spam'];

const VALID_INBOX_STATUSES = ['New', 'Needs Approval', 'Approved', 'Replied', 'Ignore'];

const VALID_IDEA_STATUSES = ['New', 'Considering', 'Approved for Calendar', 'Rejected'];

// Step 10 safety rules, exported verbatim so server.js / docs can surface
// them without re-typing them anywhere else.
const SAFETY_RULES = [
  'Never post, publish, or schedule content automatically.',
  'Never reply to a comment, DM, or mention automatically.',
  'Never delete, hide, or moderate a comment automatically.',
  'Never follow, unfollow, like, or otherwise act on another account.',
  'All outbound content (captions, replies, posts) requires manual human approval and manual publishing.',
  'Create drafts, ideas, tasks, and reports only.',
  'Never fabricate engagement numbers.',
];

// ---------------------------------------------------------------------------
// Engagement scoring
// ---------------------------------------------------------------------------
// Engagement Rate = (likes + comments + shares + saves) / views
// Returns null (not 0) when views is missing/zero — an undefined rate is
// more honest than a fake 0% rate for a post with no view data yet.
function computeEngagementRate({ views, likes, comments, shares, saves } = {}) {
  const v = typeof views === 'number' ? views : 0;
  if (v <= 0) return null;

  const l = typeof likes === 'number' ? likes : 0;
  const c = typeof comments === 'number' ? comments : 0;
  const s = typeof shares === 'number' ? shares : 0;
  const sv = typeof saves === 'number' ? saves : 0;

  const rate = (l + c + s + sv) / v;
  // Store as a percentage rounded to 2 decimal places (e.g. 11.33 = 11.33%).
  return Math.round(rate * 10000) / 100;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function isNonNegativeNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// POST /add-social-post — a piece of content that has already been posted
// manually by the founder/team (Layer 1). This route only records what
// happened — it never publishes anything itself.
function validatePostInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.postTitle || typeof b.postTitle !== 'string' || !b.postTitle.trim()) {
    errors.push('postTitle is required.');
  }
  if (!b.platform || !VALID_PLATFORMS.includes(b.platform)) {
    errors.push(`platform is required and must be one of: ${VALID_PLATFORMS.join(', ')}`);
  }
  if (!b.datePosted || typeof b.datePosted !== 'string' || !b.datePosted.trim()) {
    errors.push('datePosted is required (ISO date string, e.g. "2026-07-08").');
  }
  if (b.url !== undefined && typeof b.url !== 'string') {
    errors.push('url must be a string.');
  }

  const numericFields = ['views', 'likes', 'comments', 'shares', 'saves', 'watchTime'];
  for (const field of numericFields) {
    if (b[field] !== undefined && !isNonNegativeNumber(b[field])) {
      errors.push(`${field} must be a non-negative number.`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      postTitle: b.postTitle.trim(),
      platform: b.platform,
      datePosted: b.datePosted.trim(),
      url: b.url || '',
      views: typeof b.views === 'number' ? b.views : null,
      likes: typeof b.likes === 'number' ? b.likes : null,
      comments: typeof b.comments === 'number' ? b.comments : null,
      shares: typeof b.shares === 'number' ? b.shares : null,
      saves: typeof b.saves === 'number' ? b.saves : null,
      watchTime: typeof b.watchTime === 'number' ? b.watchTime : null,
      notes: b.notes || '',
    },
  };
}

// POST /add-social-comment — a comment, DM, or mention noticed manually
// (Layer 1) or pulled from a platform API (Layer 2, future). Never replies,
// never deletes, never moderates — recording only.
function validateCommentInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.message || typeof b.message !== 'string' || !b.message.trim()) {
    errors.push('message is required (the comment/DM/mention text).');
  }
  if (!b.platform || !VALID_PLATFORMS.includes(b.platform)) {
    errors.push(`platform is required and must be one of: ${VALID_PLATFORMS.join(', ')}`);
  }
  if (b.sentiment && !VALID_SENTIMENTS.includes(b.sentiment)) {
    errors.push(`sentiment must be one of: ${VALID_SENTIMENTS.join(', ')}`);
  }
  if (b.user !== undefined && typeof b.user !== 'string') {
    errors.push('user must be a string.');
  }
  if (b.url !== undefined && typeof b.url !== 'string') {
    errors.push('url must be a string.');
  }
  if (b.needsReply !== undefined && typeof b.needsReply !== 'boolean') {
    errors.push('needsReply must be a boolean.');
  }
  if (b.generateDraftReply !== undefined && typeof b.generateDraftReply !== 'boolean') {
    errors.push('generateDraftReply must be a boolean.');
  }

  if (errors.length > 0) return { valid: false, errors };

  const sentiment = b.sentiment || 'Neutral';
  // Sensible default: Spam never needs a reply; everything else does unless
  // the caller explicitly says otherwise.
  const defaultNeedsReply = sentiment !== 'Spam';

  return {
    valid: true,
    errors: [],
    normalized: {
      message: b.message.trim(),
      platform: b.platform,
      user: b.user || '',
      url: b.url || '',
      sentiment,
      needsReply: typeof b.needsReply === 'boolean' ? b.needsReply : defaultNeedsReply,
      generateDraftReply: Boolean(b.generateDraftReply),
    },
  };
}

// POST /draft-social-content — generates a new Content Calendar draft.
// Never accepts athlete-specific data (injuries, grades, medical info) —
// content drafts are program/brand-level only, same guardrail as Step 9's
// coach outreach drafts.
const FORBIDDEN_CONTENT_KEYS = ['athleteName', 'athleteData', 'injury', 'medicalInfo', 'grades', 'studentData'];

function validateContentDraftInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.platform || !VALID_PLATFORMS.includes(b.platform)) {
    errors.push(`platform is required and must be one of: ${VALID_PLATFORMS.join(', ')}`);
  }
  if (!b.contentType || !VALID_CONTENT_TYPES.includes(b.contentType)) {
    errors.push(`contentType is required and must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
  }
  if (!b.topic || typeof b.topic !== 'string' || !b.topic.trim()) {
    errors.push('topic is required (a short description of what the content is about).');
  }
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (b[key] !== undefined) {
      errors.push(`"${key}" is not allowed — content drafts may never include student-athlete data.`);
    }
  }
  if (b.context !== undefined && typeof b.context !== 'string') {
    errors.push('context must be a string.');
  }
  if (b.owner !== undefined && typeof b.owner !== 'string') {
    errors.push('owner must be a string.');
  }
  if (b.publishDate !== undefined && typeof b.publishDate !== 'string') {
    errors.push('publishDate must be a string (ISO date).');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      platform: b.platform,
      contentType: b.contentType,
      topic: b.topic.trim(),
      context: b.context || '',
      owner: b.owner || '',
      publishDate: b.publishDate || '',
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic draft generators (no LLM call — every draft is auditable
// before a human approves it, same pattern as Step 9's generateOutreachDraft)
// ---------------------------------------------------------------------------
function generateContentDraft({ platform, contentType, topic, context } = {}) {
  const contextLine = context && typeof context === 'string' ? context.trim() : '';

  const hooksByType = {
    'Founder Story': `Why we built Adaptiv: ${topic}`,
    'Training Tip': `One thing most athletes get wrong about ${topic}`,
    'Coach Tool': `How coaches are using Adaptiv for ${topic}`,
    'Film AI Demo': `Watch Adaptiv break down ${topic} in seconds`,
    'Athlete Result': `${topic} — real progress, tracked automatically`,
    'App Demo': `Inside Adaptiv: ${topic}`,
    'Behind the Scenes': `Behind the scenes: ${topic}`,
    'Testimonial': `What athletes are saying about ${topic}`,
    'Launch Post': `It's here: ${topic}`,
  };

  const hook = hooksByType[contentType] || `${contentType}: ${topic}`;

  const captionLines = [
    hook,
    '',
    contextLine || `A quick look at ${topic} and how Adaptiv makes it easier for athletes and coaches.`,
    '',
    'Adaptiv is an AI-powered training platform — personalized workouts, PR tracking, and coach tools in one app.',
  ];

  const ctaByPlatform = {
    Instagram: 'Link in bio to try Adaptiv.',
    TikTok: 'Follow for more — link in bio.',
    YouTube: 'Subscribe and check the description for the link.',
    X: 'Link below to learn more.',
  };

  return {
    hook,
    caption: captionLines.join('\n'),
    cta: ctaByPlatform[platform] || 'Learn more — link in bio.',
  };
}

function generateReplyDraft({ platform, sentiment, message, user } = {}) {
  const name = user && user.trim() ? user.trim() : 'there';

  const templatesBySentiment = {
    Positive: `Thanks so much, ${name}! Really glad it's helping — let us know if you ever want a hand with anything.`,
    Neutral: `Hey ${name}, thanks for the comment! Let us know if you have any questions about Adaptiv.`,
    Negative: `Hi ${name}, sorry to hear that — we'd love to make it right. Can you DM us a few details so we can help directly?`,
    Lead: `Hi ${name}, thanks for the interest! Feel free to DM us or check the link in our bio to get started with Adaptiv.`,
    'Support Issue': `Hi ${name}, thanks for flagging this — can you DM us so we can look into it and get you sorted?`,
    Spam: '',
  };

  return templatesBySentiment[sentiment] || templatesBySentiment.Neutral;
}

// ---------------------------------------------------------------------------
// Notion row builders — write shape (used with notion.pages.create)
// ---------------------------------------------------------------------------

// Social Metrics database row. Engagement Rate is always computed here from
// the provided numbers — never accepted as raw input, so it can't drift
// from the underlying likes/comments/shares/saves/views.
function buildSocialMetricsProperties(post = {}) {
  const engagementRate = computeEngagementRate(post);

  const properties = {
    Post: { title: [{ text: { content: post.postTitle } }] },
    Platform: { select: { name: post.platform } },
  };

  if (post.datePosted) properties['Date Posted'] = { date: { start: post.datePosted } };
  if (post.url) properties['URL'] = { url: post.url };
  if (typeof post.views === 'number') properties['Views'] = { number: post.views };
  if (typeof post.likes === 'number') properties['Likes'] = { number: post.likes };
  if (typeof post.comments === 'number') properties['Comments'] = { number: post.comments };
  if (typeof post.shares === 'number') properties['Shares'] = { number: post.shares };
  if (typeof post.saves === 'number') properties['Saves'] = { number: post.saves };
  if (typeof post.watchTime === 'number') properties['Watch Time'] = { number: post.watchTime };
  if (engagementRate !== null) properties['Engagement Rate'] = { number: engagementRate };
  if (post.notes) properties['Notes'] = { rich_text: [{ text: { content: post.notes } }] };

  return properties;
}

// Content Calendar database row. Always files as "Needs Approval" / not
// Approved — this module never posts or schedules anything.
function buildContentCalendarProperties({ platform, contentType, topic, owner, publishDate, draft } = {}) {
  const properties = {
    'Content Title': { title: [{ text: { content: draft.hook || topic || 'Untitled draft' } }] },
    Platform: { select: { name: platform } },
    // Safety rules: "All outbound content requires manual approval." /
    // "Create drafts, ideas, tasks, and reports only." Status always starts
    // at "Needs Approval" and Approved always starts false — no code path
    // in this module can change either.
    Status: { select: { name: 'Needs Approval' } },
    'Content Type': { select: { name: contentType } },
    Hook: { rich_text: [{ text: { content: draft.hook || '' } }] },
    Caption: { rich_text: [{ text: { content: draft.caption || '' } }] },
    CTA: { rich_text: [{ text: { content: draft.cta || '' } }] },
    Approved: { checkbox: false },
  };

  if (owner) properties['Owner'] = { rich_text: [{ text: { content: owner } }] };
  if (publishDate) properties['Publish Date'] = { date: { start: publishDate } };

  return properties;
}

// Social Inbox database row. Approved always starts false and Status is
// never written as "Replied" by this module — confirming a reply was
// actually sent is a manual, human-only edit made directly in Notion.
function buildSocialInboxProperties({ message, platform, user, url, sentiment, needsReply, draftReply } = {}) {
  const properties = {
    'Message/Comment': { title: [{ text: { content: message } }] },
    Platform: { select: { name: platform } },
    Sentiment: { select: { name: sentiment || 'Neutral' } },
    'Needs Reply': { checkbox: Boolean(needsReply) },
    Approved: { checkbox: false },
    // A drafted reply (if any) automatically bumps this to "Needs Approval"
    // so it surfaces for review — otherwise it stays "New".
    Status: { select: { name: draftReply ? 'Needs Approval' : 'New' } },
  };

  if (user) properties['User'] = { rich_text: [{ text: { content: user } }] };
  if (url) properties['URL'] = { url };
  if (draftReply) properties['Draft Reply'] = { rich_text: [{ text: { content: draftReply } }] };

  return properties;
}

// ---------------------------------------------------------------------------
// Notion read helpers — pages.query() returns a different property shape
// than pages.create() takes, so these unwrap the read format.
// ---------------------------------------------------------------------------
function readTitle(prop) {
  if (!prop || !prop.title || prop.title.length === 0) return '';
  return prop.title.map((t) => t.plain_text || '').join('');
}

function readSelect(prop) {
  return prop && prop.select ? prop.select.name : null;
}

function readRichText(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return '';
  return prop.rich_text.map((t) => t.plain_text || '').join('');
}

function readNumber(prop) {
  return prop && typeof prop.number === 'number' ? prop.number : null;
}

function readDate(prop) {
  return prop && prop.date ? prop.date.start : null;
}

function readCheckbox(prop) {
  return Boolean(prop && prop.checkbox);
}

function readUrl(prop) {
  return prop && prop.url ? prop.url : null;
}

// ---------------------------------------------------------------------------
// Social media summary — read-only. Queries Social Metrics, Content
// Calendar, Social Inbox, and (if provided) Social Ideas, and rolls
// everything up into a Green/Yellow/Red status. Never writes to any of
// these databases itself.
//
// Status rules (heuristic, mirrors the Green/Yellow/Red pattern used by
// the other Step 3-9 agents):
//   Red    — nothing tracked yet: no Social Metrics rows AND no Content
//            Calendar rows at all.
//   Yellow — some activity exists, but there's a gap: either no content is
//            queued (Approved/Posted) in the calendar, or the inbox has a
//            meaningful reply backlog (5+ items needing a reply).
//   Green  — at least one post is being tracked, at least one piece of
//            content is Approved or Posted in the calendar, and the inbox
//            reply backlog is manageable (fewer than 5 items).
// ---------------------------------------------------------------------------
const INBOX_BACKLOG_YELLOW_THRESHOLD = 5;

async function gatherSocialMediaSummary(notion, { metricsDbId, calendarDbId, inboxDbId, ideasDbId } = {}) {
  const [metricsResponse, calendarResponse, inboxResponse] = await Promise.all([
    metricsDbId ? notion.databases.query({ database_id: metricsDbId, page_size: 100 }) : Promise.resolve({ results: [] }),
    calendarDbId ? notion.databases.query({ database_id: calendarDbId, page_size: 100 }) : Promise.resolve({ results: [] }),
    inboxDbId ? notion.databases.query({ database_id: inboxDbId, page_size: 100 }) : Promise.resolve({ results: [] }),
  ]);

  const posts = metricsResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    postTitle: readTitle(page.properties['Post']),
    platform: readSelect(page.properties['Platform']),
    datePosted: readDate(page.properties['Date Posted']),
    postUrl: readUrl(page.properties['URL']),
    views: readNumber(page.properties['Views']),
    likes: readNumber(page.properties['Likes']),
    comments: readNumber(page.properties['Comments']),
    shares: readNumber(page.properties['Shares']),
    saves: readNumber(page.properties['Saves']),
    engagementRate: readNumber(page.properties['Engagement Rate']),
  }));

  const calendarItems = calendarResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    contentTitle: readTitle(page.properties['Content Title']),
    platform: readSelect(page.properties['Platform']),
    status: readSelect(page.properties['Status']) || 'Idea',
    contentType: readSelect(page.properties['Content Type']),
    publishDate: readDate(page.properties['Publish Date']),
    approved: readCheckbox(page.properties['Approved']),
  }));

  const inboxItems = inboxResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    message: readTitle(page.properties['Message/Comment']),
    platform: readSelect(page.properties['Platform']),
    sentiment: readSelect(page.properties['Sentiment']) || 'Neutral',
    needsReply: readCheckbox(page.properties['Needs Reply']),
    status: readSelect(page.properties['Status']) || 'New',
    approved: readCheckbox(page.properties['Approved']),
  }));

  let ideaBacklogCount = 0;
  if (ideasDbId) {
    const ideasResponse = await notion.databases.query({ database_id: ideasDbId, page_size: 100 });
    ideaBacklogCount = ideasResponse.results.filter((page) => {
      const status = readSelect(page.properties['Status']) || 'New';
      return status === 'New' || status === 'Considering';
    }).length;
  }

  // Platform totals + engagement leaderboard.
  const totalPosts = posts.length;
  const totalViews = posts.reduce((sum, p) => sum + (p.views || 0), 0);
  const postsWithRate = posts.filter((p) => typeof p.engagementRate === 'number');
  const avgEngagementRate =
    postsWithRate.length > 0
      ? Math.round((postsWithRate.reduce((sum, p) => sum + p.engagementRate, 0) / postsWithRate.length) * 100) / 100
      : null;
  const topPosts = [...postsWithRate].sort((a, b) => b.engagementRate - a.engagementRate).slice(0, 3);

  // Content Calendar rollup.
  const calendarByStatus = VALID_CALENDAR_STATUSES.reduce((acc, status) => {
    acc[status] = calendarItems.filter((c) => c.status === status).length;
    return acc;
  }, {});
  const upcomingApprovedCount = calendarByStatus['Approved'] || 0;
  const needsApprovalCount = calendarByStatus['Needs Approval'] || 0;

  // Social Inbox rollup.
  const needsReplyBacklog = inboxItems.filter(
    (i) => i.needsReply && i.status !== 'Replied' && i.status !== 'Ignore'
  );
  const leadCount = inboxItems.filter((i) => i.sentiment === 'Lead').length;
  const negativeCount = inboxItems.filter((i) => i.sentiment === 'Negative').length;
  const inboxDraftsAwaitingApproval = inboxItems.filter((i) => i.status === 'Needs Approval').length;

  let status = 'Red';
  if (totalPosts === 0 && calendarItems.length === 0) {
    status = 'Red';
  } else if (upcomingApprovedCount === 0 || needsReplyBacklog.length >= INBOX_BACKLOG_YELLOW_THRESHOLD) {
    status = 'Yellow';
  } else if (totalPosts > 0) {
    status = 'Green';
  } else {
    status = 'Yellow';
  }

  return {
    status,
    totalPosts,
    totalViews,
    avgEngagementRate,
    topPosts,
    calendarByStatus,
    upcomingApprovedCount,
    needsApprovalCount,
    totalCalendarItems: calendarItems.length,
    needsReplyBacklogCount: needsReplyBacklog.length,
    leadCount,
    negativeCount,
    inboxDraftsAwaitingApproval,
    totalInboxItems: inboxItems.length,
    ideaBacklogCount,
  };
}

// Notion blocks for the "Social Media" section of the Daily Brief.
function buildSocialMediaSummaryBlocks(summary) {
  return [
    heading2('Social Media'),
    paragraph(`Status: ${summary.status}`),
    paragraph(
      `Posts tracked: ${summary.totalPosts} / Total views: ${summary.totalViews} / ` +
        `Avg engagement rate: ${summary.avgEngagementRate !== null ? summary.avgEngagementRate + '%' : 'N/A'}`
    ),
    boldParagraph('Top Performing Posts:'),
    ...bulletedList(
      summary.topPosts.length > 0
        ? summary.topPosts.map((p) => `${p.postTitle || 'Untitled'} (${p.platform}) — ${p.engagementRate}% engagement`)
        : ['None yet — use POST /add-social-post to start tracking.']
    ),
    paragraph(
      `Content Calendar: ${summary.totalCalendarItems} total — ${summary.upcomingApprovedCount} approved/upcoming, ` +
        `${summary.needsApprovalCount} awaiting approval.`
    ),
    paragraph(
      `Social Inbox: ${summary.totalInboxItems} total — ${summary.needsReplyBacklogCount} need a reply ` +
        `(${summary.leadCount} leads, ${summary.negativeCount} negative), ${summary.inboxDraftsAwaitingApproval} draft reply(ies) awaiting approval.`
    ),
    paragraph(`Idea backlog: ${summary.ideaBacklogCount} idea(s) not yet queued into the calendar.`),
    paragraph('Nothing is posted, replied to, or scheduled automatically — review and approve everything in Notion.'),
  ];
}

// Builds the read-only social-media-report summary text used for an Agent
// Reports row (POST /run-social-review).
function buildSocialMediaReportSummary(summary) {
  const lines = [
    `Social Media status: ${summary.status}.`,
    `${summary.totalPosts} post(s) tracked, ${summary.totalViews} total views, ` +
      `avg engagement rate ${summary.avgEngagementRate !== null ? summary.avgEngagementRate + '%' : 'N/A'}.`,
    `Content Calendar: ${summary.totalCalendarItems} total (${summary.upcomingApprovedCount} approved/upcoming, ${summary.needsApprovalCount} awaiting approval).`,
    `Social Inbox: ${summary.totalInboxItems} total (${summary.needsReplyBacklogCount} need a reply, ${summary.leadCount} leads, ${summary.negativeCount} negative, ${summary.inboxDraftsAwaitingApproval} draft reply(ies) awaiting approval).`,
    `Idea backlog: ${summary.ideaBacklogCount}.`,
    'Nothing was posted, replied to, or scheduled by this review — read-only.',
  ];
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (same self-contained pattern as the other
// lib/*Agent.js modules)
// ---------------------------------------------------------------------------
function heading2(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function paragraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function boldParagraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true } }] },
  };
}

function bulletedList(items) {
  return items.map((item) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item } }] },
  }));
}

module.exports = {
  VALID_PLATFORMS,
  VALID_IDEA_PLATFORMS,
  VALID_CONTENT_TYPES,
  VALID_CALENDAR_STATUSES,
  VALID_SENTIMENTS,
  VALID_INBOX_STATUSES,
  VALID_IDEA_STATUSES,
  SAFETY_RULES,
  computeEngagementRate,
  validatePostInput,
  validateCommentInput,
  validateContentDraftInput,
  generateContentDraft,
  generateReplyDraft,
  buildSocialMetricsProperties,
  buildContentCalendarProperties,
  buildSocialInboxProperties,
  gatherSocialMediaSummary,
  buildSocialMediaSummaryBlocks,
  buildSocialMediaReportSummary,
};
