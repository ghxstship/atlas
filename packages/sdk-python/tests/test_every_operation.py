"""Every operation is reachable through the generated Python client and its response validates."""

from __future__ import annotations

import unittest

from xos_sdk import OPERATIONS, XosClient

from .contract import ContractServer, snake

SHADOWED = {"self", "body", "filter", "limit", "cursor", "fields", "sort", "options", "idempotency_key", "if_match"}


def ident(name: str) -> str:
    s = snake(name)
    return s + "_" if s in SHADOWED and not s.endswith("_") else s


class EveryOperationTest(unittest.TestCase):
    def test_calls_every_operation(self) -> None:
        server = ContractServer(seed_on_miss=True, with_inputs=True)
        failures = []
        try:
            client = XosClient(server.base_url, api_key=server.api_key, max_retries=0)
            self.assertEqual(len(OPERATIONS), len(server.inputs))
            for op_id, spec in OPERATIONS.items():
                given = server.inputs[op_id]
                resource = getattr(client, snake(spec.resource))
                method = getattr(resource, snake(spec.verb))
                args = [given["path"][p] for p in spec.path_params]
                body = given.get("body")
                if spec.verb == "transition":
                    row = resource.get(*args).data
                    state = next(k for k in row if k.endswith("_state"))
                    body = {**body, "expected_state": row[state], "to_state": row[state]}
                if spec.body is not None:
                    args.append(body)
                kwargs = {ident(k): v for k, v in given["query"].items()}
                if spec.if_match:
                    kwargs["if_match"] = resource.get(*args[: len(spec.path_params)]).etag
                try:
                    method(*args, **kwargs)
                except Exception as error:  # noqa: BLE001 (collected and asserted below)
                    failures.append(f"{op_id}: {error!r}")
        finally:
            violations = server.close()
        self.assertEqual(failures, [])
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
