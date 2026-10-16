"""Runtime behavior against the contract test server: the ADR 0003 conventions."""

from __future__ import annotations

import unittest
from typing import List

from xos_sdk import (
    OPERATIONS,
    Headers,
    RequestOptions,
    XosApiError,
    XosAuthenticationError,
    XosBadRequestError,
    XosClient,
    XosConflictError,
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

from .contract import ContractServer

PROJECT = {
    "name": "Harborfront Summer Series",
    "project_key": "HSS-26",
    "time_zone": "America/New_York",
    "tier_code": "04",
    "currency": "USD",
}


class ClientTest(unittest.TestCase):
    server: ContractServer

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ContractServer()

    @classmethod
    def tearDownClass(cls) -> None:
        violations = cls.server.close()
        if violations:
            raise AssertionError(violations)

    def setUp(self) -> None:
        self.sleeps: List[float] = []
        self.client = XosClient(self.server.base_url + "/", api_key=self.server.api_key, sleep=self.sleeps.append)

    def test_construction_rules(self) -> None:
        with self.assertRaisesRegex(ValueError, "base_url"):
            XosClient("")
        with self.assertRaisesRegex(ValueError, "only one"):
            XosClient("http://x", api_key="a", access_token="b")
        self.assertEqual(self.client.base_url, self.server.base_url)

    def test_get_token_is_called_per_request(self) -> None:
        calls = []

        def token() -> str:
            calls.append(1)
            return self.server.api_key

        client = XosClient(self.server.base_url, get_token=token)
        client.projects.list()
        client.projects.list()
        self.assertEqual(len(calls), 2)

    def test_crud_with_etags(self) -> None:
        created = self.client.projects.create(PROJECT)
        self.assertEqual(created.status, 201)
        self.assertTrue(created.etag and created.etag.startswith("W/"))
        self.assertEqual(created.rate_limit.limit if created.rate_limit else None, 600)
        project_id = created.data["id"]
        read = self.client.projects.get(project_id)
        updated = self.client.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=read.etag or "")
        self.assertEqual(updated.data["name"], "Harborfront Fall Series")
        with self.assertRaises(XosPreconditionFailedError):
            self.client.projects.update(project_id, {"name": "Stale"}, if_match=read.etag or "")
        calendar = self.client.calendars.create({"name": "Venue Working Days", "time_zone": "America/New_York"})
        self.assertEqual(self.client.calendars.delete(calendar.data["id"]).status, 204)
        with self.assertRaises(XosNotFoundError):
            self.client.calendars.get(calendar.data["id"])

    def test_sparse_fieldset(self) -> None:
        project_id = self.client.projects.create(PROJECT).data["id"]
        read = self.client.projects.get(project_id, fields=["name"])
        self.assertEqual(sorted(read.data), ["id", "name"])

    def test_missing_if_match(self) -> None:
        with self.assertRaisesRegex(TypeError, "if_match"):
            self.client.projects.update("x", {}, if_match="")
        project_id = self.client.projects.create(PROJECT).data["id"]
        spec = OPERATIONS["projects.update"].__class__(**{**OPERATIONS["projects.update"].__dict__, "if_match": False})
        with self.assertRaises(XosPreconditionRequiredError):
            self.client.request(spec, path={"id": project_id}, body={})

    def test_idempotency_key_survives_retries(self) -> None:
        client = XosClient(self.server.base_url, api_key=self.server.api_key, idempotency_key=lambda: "py-fixed-key-1", sleep=self.sleeps.append)
        first = client.projects.create(PROJECT)
        replay = client.projects.create(PROJECT)
        self.assertEqual(replay.data["id"], first.data["id"])
        self.assertEqual(replay.headers.get("idempotent-replayed"), "true")
        with self.assertRaises(XosConflictError):
            client.projects.create({**PROJECT, "name": "Other"})
        explicit = self.client.projects.create(PROJECT, idempotency_key="py-row-0000001")
        self.assertEqual(self.client.projects.create(PROJECT, idempotency_key="py-row-0000001").data["id"], explicit.data["id"])

    def test_pagination_and_filters(self) -> None:
        for i in range(5):
            self.client.projects.create({**PROJECT, "name": f"PyPaging {i}"})
        first = self.client.projects.list(limit=2, filter={"name": {"contains": "PyPaging"}})
        self.assertEqual(len(first.data), 2)
        self.assertIsNotNone(first.next_cursor)
        names = [p["name"] for p in self.client.projects.list_all(limit=2, filter={"name": {"contains": "PyPaging"}}, sort=["-name"])]
        self.assertEqual(names, [f"PyPaging {i}" for i in range(4, -1, -1)])
        listed = self.client.projects.list(
            filter={"name": {"in": ["PyPaging 1", "PyPaging 2"], "eq": None}, "description": {"is_null": False}}, fields="id,name", sort="name"
        )
        self.assertEqual(listed.status, 200)

    def test_query_validation(self) -> None:
        with self.assertRaisesRegex(TypeError, "field name"):
            self.client.projects.list(filter={"Bad Field": {"eq": "x"}})
        with self.assertRaisesRegex(TypeError, "operator"):
            self.client.projects.list(filter={"name": {"like": "x"}})
        with self.assertRaisesRegex(TypeError, "string"):
            self.client.projects.list(filter={"name": {"eq": object()}})
        with self.assertRaisesRegex(TypeError, "not a paged"):
            self.client.request(OPERATIONS["projects.get"], path={"id": "x"}, query={"limit": 1})
        with self.assertRaisesRegex(TypeError, "fieldset"):
            self.client.request(OPERATIONS["projects.create"], query={"fields": "id"}, body=PROJECT)
        with self.assertRaisesRegex(TypeError, "no query parameter"):
            self.client.request(OPERATIONS["projects.list"], query={"bogus": 1})
        with self.assertRaisesRegex(TypeError, "path parameter"):
            self.client.request(OPERATIONS["projects.get"])
        with self.assertRaisesRegex(TypeError, "requires the query parameter"):
            self.client.request(OPERATIONS["canonElements.resolve"])
        with self.assertRaisesRegex(TypeError, "no request body"):
            self.client.request(OPERATIONS["calendars.delete"], path={"id": "x"}, body={})
        with self.assertRaisesRegex(TypeError, "requires a request body"):
            self.client.request(OPERATIONS["projects.create"])
        with self.assertRaisesRegex(TypeError, "not a paged list"):
            self.client.request_page(OPERATIONS["projects.get"], path={"id": "x"})
        self.assertEqual(self.client.canon_elements.resolve(query="stage deck").status, 200)

    def test_refusal_and_validation_errors(self) -> None:
        project_id = self.client.projects.create(PROJECT).data["id"]
        with self.assertRaises(XosRefusalError) as refused:
            self.client.projects.transition(project_id, {"expected_state": "Closed", "to_state": "Active"})
        self.assertEqual(refused.exception.refusal, "REFUSE")
        self.assertIn("not Closed", refused.exception.reason)
        self.assertIsNone(refused.exception.rule)
        with self.assertRaises(XosValidationError) as invalid:
            self.client.projects.create({**PROJECT, "name": "", "currency": "usd"})
        self.assertEqual(sorted(e["pointer"] for e in invalid.exception.errors), ["/currency", "/name"])

    def test_auth_and_bad_request(self) -> None:
        with self.assertRaises(XosAuthenticationError):
            XosClient(self.server.base_url, api_key="xos_live_wrong").projects.list()
        with self.assertRaises(XosBadRequestError):
            self.client.projects.list(limit=500)

    def test_retries_reuse_the_idempotency_key(self) -> None:
        self.server.fail_next(503)
        created = self.client.projects.create(PROJECT)
        self.assertEqual(created.status, 201)
        self.assertEqual(self.sleeps, [0.5])

    def test_rate_limit_honors_retry_after(self) -> None:
        for _ in range(3):
            self.server.fail_next(429, {"Retry-After": "2"})
        with self.assertRaises(XosRateLimitError) as limited:
            self.client.projects.list()
        self.assertEqual(limited.exception.retry_after_seconds, 2)
        self.assertEqual(self.sleeps, [2.0, 2.0])

    def test_non_problem_error_and_malformed_json(self) -> None:
        client = XosClient(self.server.base_url, api_key=self.server.api_key, max_retries=0)
        self.server.fail_next(500)
        with self.assertRaises(XosServerError):
            client.projects.list()
        self.server.fail_next(418, {"Content-Type": "text/plain"}, "short and stout")
        with self.assertRaises(XosApiError) as odd:
            client.projects.list()
        self.assertEqual(odd.exception.problem["detail"], "short and stout")
        self.server.fail_next(200, {"Content-Type": "application/json"}, "{not json")
        with self.assertRaisesRegex(XosNetworkError, "malformed JSON"):
            client.me.get()
        self.server.fail_next(200, {"Content-Type": "application/json"}, {"items": []})
        with self.assertRaisesRegex(XosNetworkError, "without a data array"):
            client.projects.list()
        self.server.fail_next(200, {"Content-Type": "text/plain"}, "plain")
        self.assertEqual(client.me.get().data, "plain")

    def test_network_failures(self) -> None:
        down = XosClient("http://127.0.0.1:9/api/v1", api_key="k", sleep=self.sleeps.append)
        with self.assertRaises(XosNetworkError) as failed:
            down.projects.list()
        self.assertFalse(failed.exception.timed_out)
        self.assertEqual(self.sleeps, [0.5, 1.0])

    def test_timeout_option(self) -> None:
        options = RequestOptions(headers={"X-Trace": "py"}, timeout=10)
        self.assertEqual(self.client.me.get(options=options).status, 200)

    def test_error_mapping(self) -> None:
        def p(status: int, **extra: object) -> dict:
            return {"type": "/problems/x", "title": "X", "status": status, **extra}

        h = Headers({"Retry-After": "3"})
        self.assertIsInstance(error_for_problem("o", p(401), h), XosAuthenticationError)
        self.assertIsInstance(error_for_problem("o", p(409), h), XosConflictError)
        self.assertIsInstance(error_for_problem("o", p(428), h), XosPreconditionRequiredError)
        refusal = error_for_problem("o", p(422, refusal="UNRATIFIED", reason="r", rule="sod.po"), h)
        self.assertIsInstance(refusal, XosRefusalError)
        self.assertEqual(refusal.rule, "sod.po")  # type: ignore[attr-defined]
        self.assertEqual(error_for_problem("o", p(422), h).errors, [])  # type: ignore[attr-defined]
        limited = error_for_problem("o", p(429), h)
        self.assertEqual(limited.retry_after_seconds, 3)  # type: ignore[attr-defined]
        self.assertIsInstance(error_for_problem("o", p(503), h), XosServerError)
        generic = error_for_problem("o", p(418, detail="teapot"), h)
        self.assertIs(type(generic), XosApiError)
        self.assertEqual(str(generic), "o failed with 418 X: teapot")

    def test_retry_after_parsing(self) -> None:
        self.assertIsNone(parse_retry_after(None, 0))
        self.assertIsNone(parse_retry_after(" ", 0))
        self.assertEqual(parse_retry_after("5", 0), 5)
        self.assertEqual(parse_retry_after("Thu, 01 Jan 1970 00:00:10 GMT", 0), 10)
        self.assertIsNone(parse_retry_after("soon", 0))

    def test_headers_are_case_insensitive(self) -> None:
        h = Headers({"ETag": "W/1"})
        self.assertEqual(h["etag"], "W/1")
        self.assertIn("ETAG", h)
        self.assertNotIn(1, h)


if __name__ == "__main__":
    unittest.main()
