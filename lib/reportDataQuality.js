function richText(property) {
  return (property?.rich_text || []).map((part) => part.plain_text || '').join('');
}

// These signatures come from the repository's documented sample inputs.
// Avoid publishing private Notion page IDs in this public repository.
function isSyntheticPage(page, title = '') {
  const name = title.trim();
  const program = richText(page.properties?.['School / Program']).trim();
  return (
    /^\[(?:test|qa|synthetic)\](?:\s|$)/i.test(name) ||
    (name === 'Test Coach' && program === 'Phoenix Test High School') ||
    /^Outreach to Test Coach\s+—\s+/i.test(name) ||
    name === 'Founder story test reel'
  );
}

module.exports = { isSyntheticPage };
