"""Types shared by the hand-written runtime and the generated resources."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Mapping, Optional, Sequence, Tuple, TypeVar, Union

T = TypeVar("T")

#: One filter value. Sequences are only meaningful for ``in``.
FilterValue = Union[str, int, float, bool]

#: ``{"field": {"op": value}}`` for the filter grammar ``filter[field][op]=value`` (ADR 0003).
#: Operators: eq, ne, lt, lte, gt, gte, in, is_null, contains. Conditions combine with AND.
Filter = Mapping[str, Mapping[str, Union[FilterValue, Sequence[FilterValue]]]]

#: Sparse fieldset: a sequence of field names or a comma-separated string. ``id`` is always returned.
FieldsArg = Optional[Union[str, Sequence[str]]]

#: Sort keys: a sequence or a comma-separated string; a leading ``-`` sorts descending.
SortArg = Optional[Union[str, Sequence[str]]]


class Headers(Dict[str, str]):
    """Response headers with case-insensitive lookup."""

    def __init__(self, items: Any = ()) -> None:
        super().__init__()
        for key, value in dict(items).items():
            self[key] = value

    def __setitem__(self, key: str, value: str) -> None:
        super().__setitem__(key.lower(), value)

    def __getitem__(self, key: str) -> str:
        return super().__getitem__(key.lower())

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and super().__contains__(key.lower())

    def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
        return super().get(key.lower(), default)


FILTER_OPERATORS: Tuple[str, ...] = ("eq", "ne", "lt", "lte", "gt", "gte", "in", "is_null", "contains")


@dataclass(frozen=True)
class OperationSpec:
    """Static description of one API operation, generated from the OpenAPI document."""

    id: str
    resource: str
    verb: str
    method: str
    path: str
    path_params: Tuple[str, ...]
    query_params: Tuple[str, ...]
    required_query_params: Tuple[str, ...]
    paged: bool
    fields: bool
    idempotent: bool
    if_match: bool
    body: Optional[str]
    body_required: bool
    success_status: int
    response: Optional[str]
    item: Optional[str]
    tag: str
    summary: str
    capability: Optional[str]
    scopes: Tuple[str, ...]


@dataclass(frozen=True)
class RequestOptions:
    """Per-request overrides."""

    #: Extra headers for this request. Authentication headers are set by the client.
    headers: Mapping[str, str] = field(default_factory=dict)
    #: Overrides the client timeout for this request, in seconds.
    timeout: Optional[float] = None


@dataclass(frozen=True)
class RateLimit:
    limit: int
    remaining: int
    #: Seconds until the window resets.
    reset: int


@dataclass(frozen=True)
class ApiResponse(Generic[T]):
    """A successful response. ``etag`` is the value to pass as ``if_match`` on the next update."""

    data: T
    status: int
    etag: Optional[str]
    rate_limit: Optional[RateLimit]
    headers: Dict[str, str]


@dataclass(frozen=True)
class Page(Generic[T]):
    """One page of a cursor-paginated list."""

    data: List[T]
    #: Cursor for the next page; None on the last page.
    next_cursor: Optional[str]
    status: int
    rate_limit: Optional[RateLimit]
    headers: Dict[str, str]
