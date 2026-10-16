"""``xos-sdk``: the Python SDK for the XOS public API.

The runtime (transport, errors, pagination, webhooks) is hand-written; everything under
``_generated`` is produced from ``packages/api/openapi/v1.json`` and never edited by hand.
"""

from ._generated.client import XosClient
from ._generated.operations import API_TITLE, API_VERSION, OPERATIONS, RESOURCES
from ._runtime.client import Resource, XosClientCore
from ._runtime.errors import (
    XosApiError,
    XosAuthenticationError,
    XosBadRequestError,
    XosConflictError,
    XosError,
    XosNetworkError,
    XosNotFoundError,
    XosPreconditionFailedError,
    XosPreconditionRequiredError,
    XosRateLimitError,
    XosRefusalError,
    XosServerError,
    XosValidationError,
    error_for_problem,
    parse_retry_after,
)
from ._runtime.types import (
    FILTER_OPERATORS,
    ApiResponse,
    Headers,
    OperationSpec,
    Page,
    RateLimit,
    RequestOptions,
)
from ._runtime.webhooks import (
    DEFAULT_TOLERANCE_SECONDS,
    SIGNATURE_HEADER,
    WebhookVerification,
    parse_signature_header,
    sign_webhook_payload,
    verify_webhook_signature,
)

__version__ = "0.0.0"

__all__ = [
    "API_TITLE",
    "API_VERSION",
    "DEFAULT_TOLERANCE_SECONDS",
    "FILTER_OPERATORS",
    "OPERATIONS",
    "RESOURCES",
    "SIGNATURE_HEADER",
    "ApiResponse",
    "Headers",
    "OperationSpec",
    "Page",
    "RateLimit",
    "RequestOptions",
    "Resource",
    "WebhookVerification",
    "XosApiError",
    "XosAuthenticationError",
    "XosBadRequestError",
    "XosClient",
    "XosClientCore",
    "XosConflictError",
    "XosError",
    "XosNetworkError",
    "XosNotFoundError",
    "XosPreconditionFailedError",
    "XosPreconditionRequiredError",
    "XosRateLimitError",
    "XosRefusalError",
    "XosServerError",
    "XosValidationError",
    "error_for_problem",
    "parse_retry_after",
    "parse_signature_header",
    "sign_webhook_payload",
    "verify_webhook_signature",
]
