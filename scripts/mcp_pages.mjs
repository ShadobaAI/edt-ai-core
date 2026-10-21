export async function all_pages(client, method, key) {
  const items = [],
    seen = new Set(),
    cursors = new Set();
  let cursor;
  while (true) {
    let result;
    try {
      result = await client.request(
        method,
        cursor === undefined ? {} : { cursor },
      );
    } catch (error) {
      if (cursor !== undefined)
        throw new Error(`Incomplete ${method} pagination: ${error.message}`);
      throw error;
    }
    if (!Array.isArray(result?.[key]))
      throw new Error(`Invalid ${method} page`);
    for (const item of result[key]) {
      const identity =
        item?.[
          key === "resources"
            ? "uri"
            : key === "resourceTemplates"
              ? "uriTemplate"
              : "name"
        ];
      if (typeof identity !== "string" || seen.has(identity))
        throw new Error(`Invalid or duplicate ${method} entry`);
      seen.add(identity);
      items.push(item);
    }
    if (items.length > 2000) throw new Error(`${method} item limit exceeded`);
    cursor = result.nextCursor;
    if (cursor == null) return { [key]: items };
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
      throw new Error(`Invalid or repeated ${method} cursor`);
    cursors.add(cursor);
  }
}
