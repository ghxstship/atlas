"""Starts the shared contract test server (packages/sdk-ts/test/contract) as a child process."""

from __future__ import annotations

import json
import keyword
import os
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

SDK_TS = Path(__file__).resolve().parents[2] / "sdk-ts"


class ContractServer:
    def __init__(self, seed_on_miss: bool = False, with_inputs: bool = False) -> None:
        self.inputs: Dict[str, Any] = {}
        self._inputs_file: Optional[str] = None
        args = ["node", "--experimental-strip-types", "--no-warnings", "test/contract/serve.ts"]
        if seed_on_miss:
            args.append("--seed-on-miss")
        if with_inputs:
            handle, self._inputs_file = tempfile.mkstemp(suffix=".json")
            os.close(handle)
            args += ["--inputs", self._inputs_file]
        self._process = subprocess.Popen(
            args, cwd=SDK_TS, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        assert self._process.stdout is not None
        line = self._process.stdout.readline()
        if not line:
            raise RuntimeError(f"The contract server did not start: {self._process.stderr.read() if self._process.stderr else ''}")
        info = json.loads(line)
        self.base_url: str = info["baseUrl"]
        self.api_key: str = info["apiKey"]
        if self._inputs_file:
            self.inputs = json.loads(Path(self._inputs_file).read_text("utf-8"))

    def fail_next(self, status: int, headers: Optional[Dict[str, str]] = None, body: Any = None) -> None:
        """Answer the next API request with this response instead of handling it."""
        root = self.base_url.rsplit("/api/v1", 1)[0]
        payload = {"status": status, "headers": headers or {}}
        if body is not None:
            payload["body"] = body
        request = urllib.request.Request(
            f"{root}/__contract/fail-next", data=json.dumps(payload).encode(), method="POST", headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(request, timeout=10).close()

    def close(self) -> list:
        """Stop the server and return the schema violations it recorded."""
        stdout, stderr = self._process.communicate(input="", timeout=30)
        if self._inputs_file:
            os.unlink(self._inputs_file)
        lines = [line for line in stderr.splitlines() if line.startswith("{")]
        return json.loads(lines[-1])["violations"] if lines else [f"no report: {stderr}"]


def snake(name: str) -> str:
    """The generator's snake_case, with a trailing underscore for keywords."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = re.sub(r"([A-Z])([A-Z][a-z])", r"\1_\2", s)
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).lower()
    return s + "_" if keyword.iskeyword(s) else s
