"""Bounded discovery; never repeats a mutation or accepts an incomplete page as all."""


def all_pages(client, method, key):
    items, seen, cursors = [], set(), set()
    cursor = None
    while True:
        try:
            result = client.request(method, {"cursor": cursor} if cursor is not None else {})
        except Exception as error:
            if cursor is not None:
                raise RuntimeError(f"Incomplete {method} pagination: {error}") from error
            raise
        if not isinstance(result.get(key), list):
            raise RuntimeError(f"Invalid {method} page")
        for item in result[key]:
            identity = item.get("uri" if key == "resources" else "uriTemplate" if key == "resourceTemplates" else "name")
            if not isinstance(identity, str) or identity in seen:
                raise RuntimeError(f"Invalid or duplicate {method} entry")
            seen.add(identity); items.append(item)
        if len(items) > 2000:
            raise RuntimeError(f"{method} item limit exceeded")
        cursor = result.get("nextCursor")
        if cursor is None:
            return {key: items}
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise RuntimeError(f"Invalid or repeated {method} cursor")
        cursors.add(cursor)
