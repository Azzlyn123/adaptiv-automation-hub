// Adaptiv Athletics — Stripe Revenue Agent
//
// Read-only Stripe reporting. This module never creates charges, never
// refunds, never cancels subscriptions, and never updates customers — it
// only reads Stripe data and shapes it into Notion-ready payloads. The
// Stripe client passed into these functions should be built from
// STRIPE_RESTRICTED_KEY, a restricted key scoped to read-only access on
// Customers, Subscriptions, Checkout Sessions, Invoices, Prices, Products,
// and Balance Transactions (see README for exact setup steps).
//
// MVP scope / known limitations (documented rather than hidden):
//   - Every Stripe list call paginates fully (no silent 100-item cap), so
//     results stay correct as the account grows.
//   - "New subs" and "canceled subs" are counted over a rolling 24h window,
//     intended for a once-daily run. If /run-revenue-sync is called more
//     than once inside the same 24h window, those two counts will overlap
//     between runs. MRR and the past_due list are always live snapshots,
//     so they're unaffected by run frequency.
//   - "Past due" is a live snapshot of subscriptions currently in Stripe's
//     `past_due` status — not a 24h window count.

const WINDOW_HOURS = 24;

function getWindowStartUnix() {
  return Math.floor(Date.now() / 1000) - WINDOW_HOURS * 60 * 60;
}

// Normalizes a subscription item's price to a monthly amount (in cents), so
// weekly/yearly/daily plans all roll up into one comparable MRR figure.
function normalizeToMonthlyCents(price, quantity) {
  const amount = (price.unit_amount || 0) * (quantity || 1);
  const interval = price.recurring ? price.recurring.interval : 'month';
  const intervalCount = price.recurring ? price.recurring.interval_count || 1 : 1;

  switch (interval) {
    case 'day':
      return (amount / intervalCount) * 30.44; // avg days/month
    case 'week':
      return (amount / intervalCount) * 4.345; // avg weeks/month
    case 'month':
      return amount / intervalCount;
    case 'year':
      return amount / intervalCount / 12;
    default:
      return amount;
  }
}

// Step 2 + 3 + 4: fetch active subscriptions, group by price ID, and
// calculate MRR + per-plan active subscription counts.
async function computeMrrAndPlanCounts(stripe, planPriceIds) {
  let mrrCents = 0;
  const planCounts = { athlete: 0, coachSchool: 0, coachTeam: 0 };

  let page = await stripe.subscriptions.list({
    status: 'active',
    limit: 100,
    expand: ['data.items.data.price'],
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const sub of page.data) {
      for (const item of sub.items.data) {
        const price = item.price;
        mrrCents += normalizeToMonthlyCents(price, item.quantity);

        if (price.id === planPriceIds.athlete) planCounts.athlete += 1;
        else if (price.id === planPriceIds.coachSchool) planCounts.coachSchool += 1;
        else if (price.id === planPriceIds.coachTeam) planCounts.coachTeam += 1;
      }
    }

    if (!page.has_more || page.data.length === 0) break;
    const lastId = page.data[page.data.length - 1].id;
    page = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      starting_after: lastId,
      expand: ['data.items.data.price'],
    });
  }

  return { mrrCents, planCounts };
}

// New subscriptions in the last 24 hours, regardless of current status —
// this counts sign-ups, not "still active right now".
async function countNewSubs(stripe, windowStartUnix) {
  let count = 0;
  let page = await stripe.subscriptions.list({
    status: 'all',
    created: { gte: windowStartUnix },
    limit: 100,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    count += page.data.length;
    if (!page.has_more || page.data.length === 0) break;
    const lastId = page.data[page.data.length - 1].id;
    page = await stripe.subscriptions.list({
      status: 'all',
      created: { gte: windowStartUnix },
      limit: 100,
      starting_after: lastId,
    });
  }

  return count;
}

// Canceled subscriptions in the last 24 hours. Stripe's list endpoint
// filters on `created`, not `canceled_at`, so this lists canceled
// subscriptions and filters client-side on canceled_at falling in-window.
async function countCanceledSubs(stripe, windowStartUnix) {
  let count = 0;
  let page = await stripe.subscriptions.list({ status: 'canceled', limit: 100 });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    count += page.data.filter((sub) => sub.canceled_at && sub.canceled_at >= windowStartUnix).length;
    if (!page.has_more || page.data.length === 0) break;
    const lastId = page.data[page.data.length - 1].id;
    page = await stripe.subscriptions.list({
      status: 'canceled',
      limit: 100,
      starting_after: lastId,
    });
  }

  return count;
}

// Live snapshot of every subscription currently past_due. Returns full
// records (not just a count) so a failed-payment follow-up approval can
// reference the specific customers.
async function getPastDueSubscriptions(stripe) {
  const results = [];
  let page = await stripe.subscriptions.list({ status: 'past_due', limit: 100 });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const sub of page.data) {
      results.push({ id: sub.id, customerId: sub.customer });
    }
    if (!page.has_more || page.data.length === 0) break;
    const lastId = page.data[page.data.length - 1].id;
    page = await stripe.subscriptions.list({
      status: 'past_due',
      limit: 100,
      starting_after: lastId,
    });
  }

  return results;
}

// Steps 2-4: the single entry point for gathering all revenue metrics.
// Runs every Stripe read in parallel since they're independent queries.
async function gatherRevenueMetrics(stripe, planPriceIds) {
  const windowStart = getWindowStartUnix();

  const [mrrResult, newSubs, canceledSubs, pastDueSubs] = await Promise.all([
    computeMrrAndPlanCounts(stripe, planPriceIds),
    countNewSubs(stripe, windowStart),
    countCanceledSubs(stripe, windowStart),
    getPastDueSubscriptions(stripe),
  ]);

  return {
    windowHours: WINDOW_HOURS,
    mrrCents: Math.round(mrrResult.mrrCents),
    mrrDollars: Math.round(mrrResult.mrrCents) / 100,
    athleteSubs: mrrResult.planCounts.athlete,
    coachSchoolSubs: mrrResult.planCounts.coachSchool,
    coachTeamSubs: mrrResult.planCounts.coachTeam,
    newSubs,
    canceledSubs,
    pastDueSubs, // array of { id, customerId }
    pastDueCount: pastDueSubs.length,
  };
}

// Step 5: Notion Sales database row (Date, MRR, Athlete Subs, Coach Team
// Subs, Coach School Subs, New Subs, Canceled Subs, Past Due, Notes).
function buildSalesRowProperties(metrics) {
  const dateLabel = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const notes =
    metrics.pastDueCount > 0
      ? `${metrics.pastDueCount} subscription(s) past due — approval item created for follow-up.`
      : 'No past due subscriptions.';

  return {
    Name: {
      title: [{ text: { content: `Revenue Report — ${dateLabel}` } }],
    },
    Date: {
      date: { start: dateLabel },
    },
    MRR: {
      number: metrics.mrrDollars,
    },
    'Athlete Subs': {
      number: metrics.athleteSubs,
    },
    'Coach Team Subs': {
      number: metrics.coachTeamSubs,
    },
    'Coach School Subs': {
      number: metrics.coachSchoolSubs,
    },
    'New Subs': {
      number: metrics.newSubs,
    },
    'Canceled Subs': {
      number: metrics.canceledSubs,
    },
    'Past Due': {
      number: metrics.pastDueCount,
    },
    Notes: {
      rich_text: [{ text: { content: notes } }],
    },
  };
}

// Step 7: Notion Approvals database row, only created when past_due
// subscriptions exist. Caps the customer list in Notes so it stays
// readable if a lot of accounts are past due at once.
function buildApprovalProperties(metrics) {
  const shown = metrics.pastDueSubs.slice(0, 10);
  const shownText = shown.map((s) => `${s.id} (${s.customerId})`).join(', ');
  const remainder = metrics.pastDueSubs.length - shown.length;
  const notes =
    `${metrics.pastDueCount} subscription(s) past due: ${shownText}` +
    (remainder > 0 ? `, +${remainder} more` : '') +
    '. Generated by Stripe Revenue Agent — read-only, no follow-up sent yet.';

  return {
    Action: {
      title: [{ text: { content: 'Draft failed-payment follow-up' } }],
    },
    Agent: {
      select: { name: 'Revenue Agent' },
    },
    Risk: {
      select: { name: 'Medium' },
    },
    Status: {
      select: { name: 'Needs Approval' },
    },
    Notes: {
      rich_text: [{ text: { content: notes } }],
    },
  };
}

// Step 6: Notion blocks for embedding a sales summary section inside the
// Daily Brief page body.
function buildSalesSummaryBlocks(metrics) {
  const summaryLines = [
    `MRR: $${metrics.mrrDollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Active subs — Athlete: ${metrics.athleteSubs}, Coach/School: ${metrics.coachSchoolSubs}, Coach/Team: ${metrics.coachTeamSubs}`,
    `New subs (last ${metrics.windowHours}h): ${metrics.newSubs}`,
    `Canceled subs (last ${metrics.windowHours}h): ${metrics.canceledSubs}`,
    `Past due (live): ${metrics.pastDueCount}${metrics.pastDueCount > 0 ? ' — approval item created' : ''}`,
  ];

  return [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Sales Summary (Stripe)' } }] },
    },
    ...summaryLines.map((line) => ({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line } }] },
    })),
  ];
}

module.exports = {
  WINDOW_HOURS,
  gatherRevenueMetrics,
  buildSalesRowProperties,
  buildApprovalProperties,
  buildSalesSummaryBlocks,
};
