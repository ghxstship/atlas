"""The transport core: authentication, idempotency keys, ETags, retries, problem errors and
cursor pagination, on the standard library's ``urllib``. Generated resource classes call into
it; it knows nothing about individual resources."""

from __future__ import annotations

import json
import socket
import time
import uuid
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import XosNetworkError, error_for_problem, parse_retry_after
from .query import build_path, build_query
from .types import ApiResponse, Headers, OperationSpec, Page, RateLimit, RequestOptions

RETRY_STATUSES = frozenset({429, 502, 503, 504})
MAX_BACKOFF_SECONDS = 8.0
PROBLEM_MEDIA = "application/problem+json"
_UNSET: Any = object()


def _rate_limit(headers: Headers) -> Optional[RateLimit]:
    try:
        return RateLimit(
            limit=int(headers["RateLimit-Limit"]),
            remaining=int(headers["RateLimit-Remaining"]),
            reset=int(headers["RateLimit-Reset"]),
        )
    except (KeyError, ValueError):
        return None


class XosClientCore:
    """Transport for the generated ``XosClient``. Use ``XosClient``; this class has no resources."""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        access_token: Optional[str] = None,
        get_token: Optional[Callable[[], str]] = None,
        max_retries: int = 2,
        timeout: float = 30.0,
        default_headers: Optional[Mapping[str, str]] = None,
        idempotency_key: Optional[Callable[[], str]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Create a client.

        ``base_url`` includes the version, for example ``https://api.ghxstship.tech/v1``.
        Pass one of ``api_key`` (an org-scoped ``xos_live_...`` key), ``access_token`` (a
        session JWT or OAuth token) or ``get_token`` (called before every request, for
        refreshing short-lived tokens).
        """
        if not base_url:
            raise ValueError("XosClient needs a base_url such as https://api.ghxstship.tech/v1.")
        if sum(c is not None for c in (api_key, access_token, get_token)) > 1:
            raise ValueError("Pass only one of api_key, access_token or get_token.")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._access_token = access_token
        self._get_token = get_token
        self._max_retries = max_retries
        self._timeout = timeout
        self._default_headers = dict(default_headers or {})
        self._new_key = idempotency_key or (lambda: str(uuid.uuid4()))
        self._sleep = sleep

    def _authorization(self) -> Optional[str]:
        token = self._api_key or self._access_token or (self._get_token() if self._get_token else None)
        return f"Bearer {token}" if token else None

    def _send(
        self, spec: OperationSpec, url: str, data: Optional[bytes], headers: Dict[str, str], timeout: float
    ) -> Tuple[int, Headers, Any]:
        request = Request(url, data=data, headers=headers, method=spec.method)
        try:
            with urlopen(request, timeout=timeout) as response:  # noqa: S310 (the base URL is caller-supplied)
                status, raw_headers, raw = response.status, Headers(response.headers.items()), response.read()
        except HTTPError as error:
            status, raw_headers, raw = error.code, Headers(error.headers.items()), error.read()
        except (socket.timeout, TimeoutError) as error:
            raise XosNetworkError(spec.id, error, True) from error
        except URLError as error:
            timed_out = isinstance(error.reason, (socket.timeout, TimeoutError))
            raise XosNetworkError(spec.id, error, timed_out) from error
        text = raw.decode("utf-8") if raw else ""
        body: Any = None
        if text:
            if "json" in raw_headers.get("Content-Type", ""):
                try:
                    body = json.loads(text)
                except ValueError as error:
                    raise XosNetworkError(spec.id, ValueError(f"The API sent malformed JSON: {error}"), False) from error
            else:
                body = text
        return status, raw_headers, body

    def _execute(
        self,
        spec: OperationSpec,
        path: Optional[Mapping[str, Any]],
        query: Optional[Mapping[str, Any]],
        body: Any,
        idempotency_key: Optional[str],
        if_match: Optional[str],
        options: Optional[RequestOptions],
    ) -> Tuple[int, Headers, Any]:
        qs = build_query(spec, query)
        url = f"{self.base_url}{build_path(spec, path)}{'?' + qs if qs else ''}"
        headers: Dict[str, str] = {"Accept": f"application/json, {PROBLEM_MEDIA}", **self._default_headers}
        if options is not None:
            headers.update(options.headers)
        auth = self._authorization()
        if auth:
            headers["Authorization"] = auth
        if spec.idempotent:
            headers["Idempotency-Key"] = idempotency_key or self._new_key()
        if spec.if_match:
            if not if_match:
                raise TypeError(f"{spec.id} requires if_match: pass the ETag from the row you read.")
            headers["If-Match"] = if_match
        data: Optional[bytes] = None
        if body is not _UNSET and body is not None:
            if spec.body is None:
                raise TypeError(f"{spec.id} takes no request body.")
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        elif spec.body_required:
            raise TypeError(f"{spec.id} requires a request body ({spec.body}).")
        timeout = options.timeout if options is not None and options.timeout is not None else self._timeout

        attempt = 0
        while True:
            try:
                status, response_headers, response_body = self._send(spec, url, data, headers, timeout)
            except XosNetworkError:
                if attempt < self._max_retries:
                    self._sleep(min(MAX_BACKOFF_SECONDS, 0.5 * 2**attempt))
                    attempt += 1
                    continue
                raise
            if 200 <= status < 300:
                return status, response_headers, response_body
            if status in RETRY_STATUSES and attempt < self._max_retries:
                wait = parse_retry_after(response_headers.get("Retry-After"), time.time())
                self._sleep(float(wait) if wait is not None else min(MAX_BACKOFF_SECONDS, 0.5 * 2**attempt))
                attempt += 1
                continue
            if isinstance(response_body, dict) and isinstance(response_body.get("title"), str):
                problem = {**response_body, "status": status}
            else:
                problem = {"type": "about:blank", "title": f"HTTP {status}", "status": status}
                if isinstance(response_body, str) and response_body:
                    problem["detail"] = response_body[:500]
            raise error_for_problem(spec.id, problem, response_headers)

    def request(
        self,
        spec: OperationSpec,
        *,
        path: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = _UNSET,
        idempotency_key: Optional[str] = None,
        if_match: Optional[str] = None,
        options: Optional[RequestOptions] = None,
    ) -> ApiResponse[Any]:
        """Call one operation. Generated resource methods use this; it is public for tools."""
        status, headers, data = self._execute(spec, path, query, body, idempotency_key, if_match, options)
        return ApiResponse(data=data, status=status, etag=headers.get("ETag"), rate_limit=_rate_limit(headers), headers=headers)

    def request_page(
        self,
        spec: OperationSpec,
        *,
        path: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Page[Any]:
        """Fetch one page of a paged list."""
        if not spec.paged:
            raise TypeError(f"{spec.id} is not a paged list.")
        status, headers, data = self._execute(spec, path, query, _UNSET, None, None, options)
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise XosNetworkError(spec.id, ValueError("The API returned a page without a data array."), False)
        cursor = data.get("next_cursor")
        return Page(
            data=data["data"],
            next_cursor=cursor if isinstance(cursor, str) else None,
            status=status,
            rate_limit=_rate_limit(headers),
            headers=headers,
        )

    def paginate(
        self,
        spec: OperationSpec,
        *,
        path: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Iterator[Any]:
        """Yield every item of a paged list, following ``next_cursor`` until the last page."""
        cursor: Optional[str] = None
        while True:
            page_query = dict(query or {})
            if cursor is not None:
                page_query["cursor"] = cursor
            page = self.request_page(spec, path=path, query=page_query, options=options)
            yield from page.data
            cursor = page.next_cursor
            if cursor is None:
                return


class Resource:
    """Base class of the generated resource groups."""

    def __init__(self, client: XosClientCore) -> None:
        self._client = client
