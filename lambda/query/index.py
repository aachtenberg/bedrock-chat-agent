"""
Query Lambda: Bedrock Agent action-group handler.

Provides five tools the agent can invoke:
  - query_data        Run arbitrary SQL against the DuckDB index
  - list_tables       Show every indexed table + row count
  - describe_table    Column types and a 5-row sample
  - list_repo_files   List files in the synced repo
  - read_repo_file    Return the text of a single repo file
"""

import json
import os

import boto3
import duckdb

S3_BUCKET = os.environ["S3_BUCKET"]
DB_LOCAL = "/tmp/data.duckdb"
MANIFEST_LOCAL = "/tmp/manifest.json"

s3 = boto3.client("s3")

# ── globals reused across warm invocations ───────────────────────────────
_con = None
_manifest = None


def _get_db():
    """Return a DuckDB connection, downloading from S3 on cold start."""
    global _con
    if _con is not None:
        try:
            _con.execute("SELECT 1")
            return _con
        except Exception:
            _con = None

    s3.download_file(S3_BUCKET, "index/data.duckdb", DB_LOCAL)
    _con = duckdb.connect(DB_LOCAL, read_only=True)
    return _con


def _get_manifest():
    """Return the file/table manifest, downloading from S3 on cold start."""
    global _manifest
    if _manifest is None:
        s3.download_file(S3_BUCKET, "index/manifest.json", MANIFEST_LOCAL)
        with open(MANIFEST_LOCAL) as fh:
            _manifest = json.load(fh)
    return _manifest


def _invalidate_cache():
    """Force re-download on next invocation (called if data looks stale)."""
    global _con, _manifest
    _con = None
    _manifest = None


# ── tool implementations ─────────────────────────────────────────────────

def query_data(sql: str) -> str:
    """Run a SQL query against the indexed CSV data."""
    con = _get_db()
    try:
        result = con.execute(sql)
        columns = [desc[0] for desc in result.description]
        rows = result.fetchall()

        if not rows:
            return f"Query returned 0 rows.\nColumns: {', '.join(columns)}"

        # Cap displayed rows at 100
        display, truncated = rows[:100], len(rows) > 100
        header = " | ".join(columns)
        sep = " | ".join("---" for _ in columns)
        body = "\n".join(" | ".join(str(v) for v in row) for row in display)
        tail = f"\n\n... ({len(rows) - 100} more rows)" if truncated else ""

        return (
            f"Rows returned: {len(rows)}\n\n"
            f"{header}\n{sep}\n{body}{tail}"
        )
    except Exception as exc:
        return f"SQL error: {exc}"


def list_tables() -> str:
    """List all available tables with row counts."""
    con = _get_db()
    manifest = _get_manifest()
    tables = con.execute("SHOW TABLES").fetchall()

    if not tables:
        return "No tables have been indexed yet."

    lines = []
    for (name,) in tables:
        count = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        source = next(
            (t["source"] for t in manifest.get("tables", []) if t["name"] == name),
            "unknown",
        )
        lines.append(f"- {name}  ({count:,} rows, source: {source})")

    return "Available tables:\n" + "\n".join(lines)


def describe_table(table_name: str) -> str:
    """Return columns + a 5-row sample for a table."""
    con = _get_db()
    try:
        cols = con.execute(f'DESCRIBE "{table_name}"').fetchall()
        sample = con.execute(f'SELECT * FROM "{table_name}" LIMIT 5').fetchall()
        col_names = [c[0] for c in cols]

        schema = f"Table: {table_name}\n\nColumns:\n"
        for col in cols:
            schema += f"  - {col[0]}: {col[1]}\n"

        header = " | ".join(col_names)
        sep = " | ".join("---" for _ in col_names)
        body = "\n".join(" | ".join(str(v) for v in row) for row in sample)
        schema += f"\nSample (first 5 rows):\n{header}\n{sep}\n{body}"
        return schema
    except Exception as exc:
        return f"Error: {exc}"


def list_repo_files(path_prefix: str = "") -> str:
    """List files that were synced from the GitHub repo."""
    manifest = _get_manifest()
    files = manifest.get("files", [])
    if path_prefix:
        files = [f for f in files if f.startswith(path_prefix)]
    if not files:
        return "No files found." + (f" (filter: {path_prefix})" if path_prefix else "")
    return "Repository files:\n" + "\n".join(f"- {f}" for f in sorted(files))


def read_repo_file(file_path: str) -> str:
    """Read the contents of a single file from the synced repo."""
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=f"repo/{file_path}")
        content = obj["Body"].read()
        try:
            text = content.decode("utf-8")
            if len(text) > 20_000:
                return text[:20_000] + f"\n\n... (truncated, total {len(text):,} chars)"
            return text
        except UnicodeDecodeError:
            return f"Binary file ({len(content):,} bytes). Cannot display as text."
    except s3.exceptions.NoSuchKey:
        return f"File not found: {file_path}"
    except Exception as exc:
        return f"Error reading file: {exc}"


# ── Bedrock Agent dispatcher ────────────────────────────────────────────

_TOOLS = {
    "query_data": lambda p: query_data(p.get("sql", "")),
    "list_tables": lambda p: list_tables(),
    "describe_table": lambda p: describe_table(p.get("table_name", "")),
    "list_repo_files": lambda p: list_repo_files(p.get("path_prefix", "")),
    "read_repo_file": lambda p: read_repo_file(p.get("file_path", "")),
}


def handler(event, context):
    function_name = event.get("function", "")
    action_group = event.get("actionGroup", "")
    parameters = {p["name"]: p["value"] for p in event.get("parameters", [])}

    tool = _TOOLS.get(function_name)
    if tool:
        result = tool(parameters)
    else:
        result = f"Unknown function: {function_name}"

    return {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": action_group,
            "function": function_name,
            "functionResponse": {
                "responseBody": {"TEXT": {"body": str(result)}}
            },
        },
    }
