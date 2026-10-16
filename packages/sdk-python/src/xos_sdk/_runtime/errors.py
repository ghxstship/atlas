"""Typed errors. Every non-2xx response raises an ``XosApiError`` subclass carrying the
RFC 9457 problem details; transport failures raise ``XosNetworkError``."""

from __future__ import annotations

import email.utils
import math
import time
from typing import Any, Dict, List, Mapping, Optional

from .types import Headers

REFUSALS = ("NO_ANSWER", "UNRATIFIED", "REFUSE")


class XosError(Exception):
    """Base class of every error the SDK raises."""


class XosNetworkError(XosError):
    """The request never produced an HTTP response: DNS, connection, TLS or timeout."""

    def __init__(self, operation_id: str, cause: BaseException, timed_out: bool) -> None:
        message = (
            f"{operation_id} timed out before the API answered."
            if timed_out
            else f"{operation_id} could not reach the API: {cause}"
        )
        super().__init__(message)
        self.operation_id = operation_id
        self.timed_out = timed_out
        self.__cause__ = cause


class XosApiError(XosError):
    """The API answered with an error status."""

    def __init__(self, operation_id: str, problem: Mapping[str, Any], headers: Mapping[str, str]) -> None:
        detail = problem.get("detail")
        super().__init__(
            f"{operation_id} failed with {problem.get('status')} {problem.get('title')}"
            + (f": {detail}" if detail else "")
        )
        self.operation_id = operation_id
        self.problem: Dict[str, Any] = dict(problem)
        self.status: int = int(problem.get("status", 0))
        self.headers: Headers = Headers(headers)


class XosBadRequestError(XosApiError):
    """400: the request is malformed."""


class XosAuthenticationError(XosApiError):
    """401: the credential is missing, expired or revoked."""


class XosNotFoundError(XosApiError):
    """404: the resource does not exist or the caller may not see it."""


class XosConflictError(XosApiError):
    """409: for example an idempotency key reused with a different body."""


class XosPreconditionFailedError(XosApiError):
    """412: ``if_match`` named a stale version. Read the row again and retry with the new ETag."""


class XosPreconditionRequiredError(XosApiError):
    """428: the update was sent without ``If-Match``."""


class XosValidationError(XosApiError):
    """422 with field errors: one JSON Pointer per invalid member."""

    @property
    def errors(self) -> List[Dict[str, str]]:
        return list(self.problem.get("errors") or [])


class XosRefusalError(XosApiError):
    """422 refusal (Section 3.7): the system declines to answer or act, and says why."""

    @property
    def refusal(self) -> str:
        return str(self.problem.get("refusal"))

    @property
    def reason(self) -> str:
        return str(self.problem.get("reason") or "")

    @property
    def rule(self) -> Optional[str]:
        """The separation of duties or policy rule that refused the request, when one did."""
        rule = self.problem.get("rule")
        return str(rule) if rule is not None else None


class XosRateLimitError(XosApiError):
    """429: rate limited after the client exhausted its retries."""

    @property
    def retry_after_seconds(self) -> Optional[int]:
        return parse_retry_after(self.headers.get("Retry-After"), time.time())


class XosServerError(XosApiError):
    """5xx: the API failed."""


_BY_STATUS = {
    400: XosBadRequestError,
    401: XosAuthenticationError,
    404: XosNotFoundError,
    409: XosConflictError,
    412: XosPreconditionFailedError,
    428: XosPreconditionRequiredError,
    429: XosRateLimitError,
}


def error_for_problem(operation_id: str, problem: Mapping[str, Any], headers: Mapping[str, str]) -> XosApiError:
    status = int(problem.get("status", 0))
    if status == 422:
        if problem.get("refusal") in REFUSALS:
            return XosRefusalError(operation_id, problem, headers)
        return XosValidationError(operation_id, problem, headers)
    cls = _BY_STATUS.get(status)
    if cls is not None:
        return cls(operation_id, problem, headers)
    if status >= 500:
        return XosServerError(operation_id, problem, headers)
    return XosApiError(operation_id, problem, headers)


def parse_retry_after(value: Optional[str], now: float) -> Optional[int]:
    """Seconds from a ``Retry-After`` header, which is either delta seconds or an HTTP date."""
    if value is None or value.strip() == "":
        return None
    try:
        return max(0, int(float(value)))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0, math.ceil(when.timestamp() - now))
