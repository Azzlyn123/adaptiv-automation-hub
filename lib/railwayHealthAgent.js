// Adaptiv Athletics — Railway Health Agent
//
// Read-only Railway app health tracking. This module never restarts a
// service, never triggers a redeploy, never changes a variable, and never
// touches a database. If something looks like it needs action, it builds a
// Notion Approval item instead — a human decides and acts from there.
//
// Uses Railway's public GraphQL API (https://docs.railway.com/integrations/api)
// with a *project* token, which authenticates via the `Project-Access-Token`
// header (not `Authorization: Bearer`, which is for account/workspace
// tokens). A project token is already scoped to one project + environment,
// so this module resolves the project/environment straight from the token
// via the `projectToken` query — it never looks anything up by
// RAILWAY_PROJECT_NAME, which sidesteps that variable's known name mismatch
// entirely. Only RAILWAY_FRONTEND_SERVICE / RAILWAY_BACKEND_SERVICE (exact
// service names) are used to find services within the scoped project.

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';

// Step 4G status rules.
const RESPONSE_TIME_GREEN_MS = 750;
const RESPONSE_TIME_YELLOW_MS = 2000;

// Severity used to compute the single Overall Status from every component.
// MISSING and RED both force the overall status to Red; YELLOW and UNKNOWN
// both force it to (at least) Yellow; GREEN never overrides anything.
const SEVERITY = { GREEN: 0, UNKNOWN: 1, YELLOW: 1, MISSING: 3, RED: 3 };

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

async function railwayQuery(token, query, variables) {
  const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Project-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    // fall through — handled below
  }

  if (!res.ok) {
    const err = new Error(`Railway API request failed with HTTP ${res.status}`);
    err.railwayStatus = res.status;
    err.railwayBody = body;
    throw err;
  }

  if (!body) {
    throw new Error('Railway API returned a non-JSON response.');
  }

  if (body.errors && body.errors.length > 0) {
    const err = new Error(body.errors.map((e) => e.message).join('; '));
    err.railwayErrors = body.errors;
    throw err;
  }

  return body.data;
}

// Resolves the project + environment scoped to this project token, and
// lists every service in that project so callers can match by name.
async function getScopedProjectAndServices(token) {
  const tokenInfo = await railwayQuery(token, 'query { projectToken { projectId environmentId } }');
  const { projectId, environmentId } = tokenInfo.projectToken;

  const projectData = await railwayQuery(
    token,
    `query project($id: String!) {
      project(id: $id) {
        id
        name
        services {
          edges { node { id name } }
        }
      }
    }`,
    { id: projectId }
  );

  const services = projectData.project.services.edges.map((edge) => edge.node);

  return {
    projectId,
    environmentId,
    projectName: projectData.project.name,
    services,
  };
}

function findServiceByName(services, name) {
  return services.find((s) => s.name === name) || null;
}

async function getLatestDeployment(token, projectId, serviceId, environmentId) {
  const data = await railwayQuery(
    token,
    `query deployments($input: DeploymentListInput!, $first: Int) {
      deployments(input: $input, first: $first) {
        edges { node { id status createdAt url staticUrl } }
      }
    }`,
    { input: { projectId, serviceId, environmentId }, first: 1 }
  );

  const edges = data.deployments.edges;
  return edges.length > 0 ? edges[0].node : null;
}

// Maps a Railway deployment status onto our five-color scale.
function deployStatusToColor(status) {
  switch (status) {
    case 'SUCCESS':
      return 'GREEN';
    case 'FAILED':
    case 'CRASHED':
      return 'RED';
    case 'BUILDING':
    case 'DEPLOYING':
    case 'QUEUED':
    case 'WAITING':
    case 'SLEEPING':
    case 'REMOVED':
    case 'SKIPPED':
      return 'YELLOW';
    default:
      // No deployment history at all for a service that does exist.
      return 'YELLOW';
  }
}

// Finds a service by name and checks its latest deployment status.
async function checkService(token, projectId, environmentId, services, serviceName) {
  const service = findServiceByName(services, serviceName);
  if (!service) {
    return { name: serviceName, found: false, color: 'MISSING', deployStatus: null };
  }

  try {
    const deployment = await getLatestDeployment(token, projectId, service.id, environmentId);
    return {
      name: serviceName,
      found: true,
      color: deployStatusToColor(deployment ? deployment.status : null),
      deployStatus: deployment ? deployment.status : null,
    };
  } catch (err) {
    // The service exists but we couldn't read its deployments — report
    // this as a data gap (Yellow) rather than crashing the whole check.
    return { name: serviceName, found: true, color: 'YELLOW', deployStatus: null, error: err.message };
  }
}

// Checks BACKEND_HEALTH_URL with a plain read-only GET request.
async function checkHealthUrl(url) {
  if (!url) {
    return {
      url: null,
      checked: false,
      ok: false,
      statusCode: null,
      responseTimeMs: null,
      color: 'MISSING',
      error: 'BACKEND_HEALTH_URL not set',
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const responseTimeMs = Date.now() - start;
    const ok = res.status >= 200 && res.status < 400;

    let color;
    if (!ok || responseTimeMs > RESPONSE_TIME_YELLOW_MS) color = 'RED';
    else if (responseTimeMs > RESPONSE_TIME_GREEN_MS) color = 'YELLOW';
    else color = 'GREEN';

    return {
      url,
      checked: true,
      ok,
      statusCode: res.status,
      responseTimeMs,
      color,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    return {
      url,
      checked: true,
      ok: false,
      statusCode: null,
      responseTimeMs,
      color: 'RED',
      error: err.name === 'AbortError' ? 'Request timed out after 10s' : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function worstOverallColor(colors) {
  let worstSeverity = 0;
  let worst = 'GREEN';
  for (const c of colors) {
    const sev = SEVERITY[c] ?? 1;
    if (sev > worstSeverity) {
      worstSeverity = sev;
      worst = c;
    }
  }
  // Overall Status only ever reports Green/Yellow/Red per Step 4G — Missing
  // collapses into Red, Unknown collapses into Yellow, at the overall level.
  // Individual component fields (Frontend/Backend/Database) keep their
  // original Missing/Unknown value.
  if (worst === 'MISSING') return 'RED';
  if (worst === 'UNKNOWN') return 'YELLOW';
  return worst;
}

// Steps 2-7: the single entry point for gathering all Railway health data.
async function gatherRailwayHealth({ railwayToken, frontendServiceName, backendServiceName, backendHealthUrl }) {
  const { projectId, environmentId, services } = await getScopedProjectAndServices(railwayToken);

  const [frontend, backend, healthCheck] = await Promise.all([
    checkService(railwayToken, projectId, environmentId, services, frontendServiceName),
    checkService(railwayToken, projectId, environmentId, services, backendServiceName),
    checkHealthUrl(backendHealthUrl),
  ]);

  // Railway database service monitoring isn't wired up in this build (the
  // Step 4 spec lists it as "unknown/pending") — always Unknown for now.
  const database = { color: 'UNKNOWN' };

  const overallColor = worstOverallColor([frontend.color, backend.color, healthCheck.color, database.color]);

  const errors = [];
  if (!frontend.found) errors.push(`Frontend service "${frontendServiceName}" not found in the Railway project.`);
  if (!backend.found) errors.push(`Backend service "${backendServiceName}" not found in the Railway project.`);
  if (frontend.found && frontend.color === 'RED') errors.push(`Frontend latest deployment status: ${frontend.deployStatus}.`);
  if (backend.found && backend.color === 'RED') errors.push(`Backend latest deployment status: ${backend.deployStatus}.`);
  if (healthCheck.checked && !healthCheck.ok) errors.push(`Backend health check failed: ${healthCheck.error}.`);
  if (healthCheck.checked && healthCheck.ok && healthCheck.responseTimeMs > RESPONSE_TIME_YELLOW_MS) {
    errors.push(`Backend health check responded in ${healthCheck.responseTimeMs}ms (over the ${RESPONSE_TIME_YELLOW_MS}ms threshold).`);
  }

  return { overallColor, frontend, backend, database, healthCheck, errors };
}

// Step 7 + 4H: decide which Notion Approval items (if any) this run needs.
// Only creates an approval when something actually needs a human decision.
function determineApprovals(health) {
  const approvals = [];

  if (health.healthCheck.checked && !health.healthCheck.ok) {
    approvals.push({
      type: 'backend_outage',
      properties: {
        Action: { title: [{ text: { content: 'Investigate backend outage' } }] },
        Agent: { select: { name: 'Railway Health Agent' } },
        Risk: { select: { name: 'High' } },
        Status: { select: { name: 'Needs Approval' } },
        Notes: {
          rich_text: [
            {
              text: {
                content: `Backend health check failed: ${health.healthCheck.error || 'unknown error'}. Checked ${health.healthCheck.url} at ${new Date().toISOString()}.`,
              },
            },
          ],
        },
      },
    });
  } else if (health.healthCheck.checked && health.healthCheck.ok && health.healthCheck.responseTimeMs > RESPONSE_TIME_YELLOW_MS) {
    // Only flag slow-performance separately when the check actually
    // succeeded but was slow — an outright failure is already covered above.
    approvals.push({
      type: 'slow_backend',
      properties: {
        Action: { title: [{ text: { content: 'Review backend performance' } }] },
        Agent: { select: { name: 'Railway Health Agent' } },
        Risk: { select: { name: 'Medium' } },
        Status: { select: { name: 'Needs Approval' } },
        Notes: {
          rich_text: [
            { text: { content: `Backend health check responded in ${health.healthCheck.responseTimeMs}ms, over the ${RESPONSE_TIME_YELLOW_MS}ms threshold.` } },
          ],
        },
      },
    });
  }

  if (!health.frontend.found || !health.backend.found) {
    const missing = [];
    if (!health.frontend.found) missing.push(`frontend ("${health.frontend.name}")`);
    if (!health.backend.found) missing.push(`backend ("${health.backend.name}")`);

    approvals.push({
      type: 'service_mapping',
      properties: {
        Action: { title: [{ text: { content: 'Verify Railway service mapping' } }] },
        Agent: { select: { name: 'Railway Health Agent' } },
        Risk: { select: { name: 'Medium' } },
        Status: { select: { name: 'Needs Approval' } },
        Notes: {
          rich_text: [
            {
              text: {
                content: `Could not find these services by name in the Railway project: ${missing.join(', ')}. Check RAILWAY_FRONTEND_SERVICE / RAILWAY_BACKEND_SERVICE against the actual service names in Railway.`,
              },
            },
          ],
        },
      },
    });
  }

  const failedDeploys = [];
  if (health.frontend.found && health.frontend.color === 'RED') failedDeploys.push(`frontend (${health.frontend.deployStatus})`);
  if (health.backend.found && health.backend.color === 'RED') failedDeploys.push(`backend (${health.backend.deployStatus})`);
  if (failedDeploys.length > 0) {
    approvals.push({
      type: 'failed_deploy',
      properties: {
        Action: { title: [{ text: { content: 'Review failed deploy logs' } }] },
        Agent: { select: { name: 'Railway Health Agent' } },
        Risk: { select: { name: 'Medium' } },
        Status: { select: { name: 'Needs Approval' } },
        Notes: { rich_text: [{ text: { content: `Latest deployment status looks bad for: ${failedDeploys.join(', ')}.` } }] },
      },
    });
  }

  return approvals;
}

// Step 8: Notion Railway Health database row.
function buildRailwayHealthRowProperties(health) {
  const dateLabel = new Date().toISOString().split('T')[0];
  const latestDeployText = `Frontend: ${health.frontend.deployStatus || (health.frontend.found ? 'no deployments' : 'service not found')} | Backend: ${health.backend.deployStatus || (health.backend.found ? 'no deployments' : 'service not found')}`;

  return {
    Name: { title: [{ text: { content: `Railway Health — ${dateLabel}` } }] },
    Date: { date: { start: dateLabel } },
    'Overall Status': { select: { name: capitalize(health.overallColor) } },
    Frontend: { select: { name: capitalize(health.frontend.color) } },
    Backend: { select: { name: capitalize(health.backend.color) } },
    Database: { select: { name: capitalize(health.database.color) } },
    'Latest Deploy': { rich_text: [{ text: { content: latestDeployText } }] },
    'Health URL': { url: health.healthCheck.url || null },
    'Response Time': { number: health.healthCheck.responseTimeMs },
    Errors: { rich_text: [{ text: { content: health.errors.length > 0 ? health.errors.join(' ') : 'None' } }] },
    Notes: { rich_text: [{ text: { content: 'Auto-generated by the Railway Health Agent. Read-only check — no restarts, redeploys, or variable changes performed.' } }] },
  };
}

// Step 9 + 4F: Notion blocks for the "Railway Health" section of the Daily
// Brief, formatted to match the Step 4F layout.
function buildHealthSummaryBlocks(health, approvals) {
  const approvalLabels = approvals.map((a) => a.properties.Action.title[0].text.content);

  return [
    heading2('Railway Health'),
    paragraph(`Overall Status: ${capitalize(health.overallColor)}`),
    boldParagraph('Frontend:'),
    ...bulletedList([
      `Service: ${health.frontend.name}`,
      `Status: ${health.frontend.found ? capitalize(health.frontend.color) : 'Missing'}`,
      `Latest deploy: ${health.frontend.deployStatus || 'n/a'}`,
    ]),
    boldParagraph('Backend:'),
    ...bulletedList([
      `Service: ${health.backend.name}`,
      `Status: ${health.backend.found ? capitalize(health.backend.color) : 'Missing'}`,
      `Health check: ${!health.healthCheck.checked ? 'Not checked' : health.healthCheck.ok ? `OK (HTTP ${health.healthCheck.statusCode})` : `Failed (${health.healthCheck.error})`}`,
      `Response time: ${health.healthCheck.responseTimeMs != null ? `${health.healthCheck.responseTimeMs}ms` : 'n/a'}`,
    ]),
    boldParagraph('Database:'),
    ...bulletedList([
      `Status: ${capitalize(health.database.color)}`,
      'Notes: Railway database monitoring is not wired up yet in this build.',
    ]),
    boldParagraph('Issues:'),
    ...bulletedList(health.errors.length > 0 ? health.errors : ['None']),
    boldParagraph('Approval Needed:'),
    ...bulletedList(approvalLabels.length > 0 ? approvalLabels : ['None']),
  ];
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (kept self-contained in this module rather
// than shared with server.js, same pattern as stripeRevenueAgent.js).
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
  RESPONSE_TIME_GREEN_MS,
  RESPONSE_TIME_YELLOW_MS,
  gatherRailwayHealth,
  determineApprovals,
  buildRailwayHealthRowProperties,
  buildHealthSummaryBlocks,
};
