"""Serializes paths and query strings exactly as ADR 0003 specifies."""

from __future__ import annotations

import re
from typing import Any, List, Mapping, Optional, Tuple
from urllib.parse import quote, urlencode

from .types import FILTER_OPERATORS, OperationSpec

_FIELD = re.compile(r"^[a-z_][a-z0-9_]*$")
_TEMPLATE = re.compile(r"\{([^}]+)\}")


def _scalar(value: Any, where: str) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    raise TypeError(f"{where} must be a string, a number or a boolean.")


def _listed(value: Any, where: str) -> str:
    if isinstance(value, str):
        return value
    return ",".join(_scalar(v, where) for v in value)


def filter_pairs(filter_: Mapping[str, Mapping[str, Any]]) -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    for field_name, ops in filter_.items():
        if not _FIELD.match(field_name):
            raise TypeError(f'Filter field "{field_name}" is not a field name.')
        for op, value in ops.items():
            if value is None:
                continue
            if op not in FILTER_OPERATORS:
                raise TypeError(f'Filter operator "{op}" on "{field_name}" is not one of {", ".join(FILTER_OPERATORS)}.')
            where = f"filter[{field_name}][{op}]"
            text = _listed(value, where) if isinstance(value, (list, tuple)) else _scalar(value, where)
            pairs.append((where, text))
    return pairs


def build_query(spec: OperationSpec, query: Optional[Mapping[str, Any]]) -> str:
    query = query or {}
    for name in spec.required_query_params:
        if query.get(name) is None:
            raise TypeError(f'{spec.id} requires the query parameter "{name}".')
    pairs: List[Tuple[str, str]] = []
    for name, value in query.items():
        if value is None:
            continue
        if name in ("limit", "cursor", "sort", "filter"):
            if not spec.paged:
                raise TypeError(f'{spec.id} is not a paged list; "{name}" does not apply.')
        elif name == "fields":
            if not spec.fields:
                raise TypeError(f"{spec.id} does not accept a sparse fieldset.")
        elif name not in spec.query_params:
            raise TypeError(f'{spec.id} has no query parameter "{name}".')
        if name == "filter":
            pairs.extend(filter_pairs(value))
        elif name in ("fields", "sort"):
            pairs.append((name, _listed(value, name)))
        else:
            pairs.append((name, _scalar(value, name)))
    return urlencode(pairs)


def build_path(spec: OperationSpec, path: Optional[Mapping[str, Any]]) -> str:
    path = path or {}

    def replace(match: "re.Match[str]") -> str:
        name = match.group(1)
        value = path.get(name)
        if value is None or value == "":
            raise TypeError(f'{spec.id} requires the path parameter "{name}".')
        return quote(str(value), safe="")

    return _TEMPLATE.sub(replace, spec.path)
