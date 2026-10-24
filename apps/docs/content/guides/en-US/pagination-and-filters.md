---
title: Pagination and filters
summary: Cursor pages, sparse fieldsets, the filter grammar and sorting, with the order coded lists always keep.
section: api
order: 3
---

Every list operation returns a page, takes the same query parameters, and keeps a documented default order.

## Cursor pages

A page has `data` and `next_cursor`. Pass `next_cursor` back as `cursor` for the next page; it is `null` on the last page.

| Parameter | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `limit`   | Page size, 1 to 200. The default is 50.                                   |
| `cursor`  | The `next_cursor` of the previous page. Opaque: never build one yourself. |

Cursors stay correct while rows are added, unlike offsets. The SDKs iterate every page for you:

```ts
for await (const record of xos.records.listAll({ filter: { record_state: { eq: "Blocked" } } })) {
  console.log(record.title);
}
```

```python
for record in xos.records.list_all(filter={"record_state": {"eq": "Blocked"}}):
    print(record["title"])
```

## Sparse fieldsets

`fields=id,title,record_state` returns only those top-level fields. `id` is always returned. Smaller responses are faster on large lists.

## Filters

Filters use `filter[field][op]=value`. Conditions on different fields combine with AND.

| Operator                 | Matches                                    |
| ------------------------ | ------------------------------------------ |
| `eq`, `ne`               | Equal, not equal                           |
| `lt`, `lte`, `gt`, `gte` | Less than, at most, greater than, at least |
| `in`                     | Any of a comma-separated list              |
| `is_null`                | `true` for empty, `false` for set          |
| `contains`               | Text containing the value                  |

```bash
curl -G "$XOS_BASE_URL/records" -H "Authorization: Bearer $XOS_API_KEY" \
  --data-urlencode "filter[record_state][eq]=Blocked" \
  --data-urlencode "filter[due_at][lte]=2026-11-01T00:00:00Z"
```

With the CLI, write `--filter record_state.eq=Blocked --filter due_at.lte=2026-11-01T00:00:00Z`.

## Sorting

`sort=starts_at,-updated_at` sorts by each key in turn; a leading `-` sorts descending. Without `sort`, each list uses the default order stated in its reference entry. Coded lists, such as departments, phases and GL accounts, always return in numeric code order.

## Canon caching

Canon changes only when a new canon generation ships, so canon reads can be cached for good. Every `GET /canon/...` response carries `XOS-Canon-Generation`. Add `generation=<n>` to the same request and the response is cached with `Cache-Control: private, max-age=31536000, immutable`: a URL with a generation always means that generation. A request for any other generation is redirected (307) to the same URL at the current generation, so a cache never serves stale canon. Without `generation`, the response is revalidated on every use, and `Content-Location` names the cacheable URL.

```bash
curl -i -G "$XOS_BASE_URL/canon/departments" -H "Authorization: Bearer $XOS_API_KEY" \
  --data-urlencode "generation=1"
```
