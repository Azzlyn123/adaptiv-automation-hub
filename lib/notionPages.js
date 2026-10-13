async function queryAllDatabasePages(notion, databaseId) {
  const pages = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...response.results);
    if (!response.has_more) break;
    if (!response.next_cursor) throw new Error(`Notion pagination stopped early for ${databaseId}`);
    cursor = response.next_cursor;
  } while (cursor);

  return pages;
}

module.exports = { queryAllDatabasePages };
