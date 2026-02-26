"""
Sync Lambda: Downloads a GitHub repo, indexes CSV files into DuckDB,
and stores everything in S3 for the Bedrock Agent to query.

Triggered weekly by EventBridge (or manually).
"""

import json
import os
import tarfile
import tempfile
import urllib.request

import boto3
import duckdb

GITHUB_REPO = os.environ["GITHUB_REPO"]
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")
S3_BUCKET = os.environ["S3_BUCKET"]

s3 = boto3.client("s3")


def handler(event, context):
    with tempfile.TemporaryDirectory() as tmpdir:
        # ── 1. Download repo tarball ─────────────────────────────────────
        tarball_url = (
            f"https://api.github.com/repos/{GITHUB_REPO}/tarball/{GITHUB_BRANCH}"
        )
        tarball_path = os.path.join(tmpdir, "repo.tar.gz")

        print(f"Downloading {tarball_url}")
        req = urllib.request.Request(
            tarball_url, headers={"User-Agent": "bedrock-agent-sync"}
        )
        with urllib.request.urlopen(req) as resp:
            with open(tarball_path, "wb") as f:
                f.write(resp.read())

        # ── 2. Extract tarball ───────────────────────────────────────────
        extract_dir = os.path.join(tmpdir, "repo")
        os.makedirs(extract_dir)
        with tarfile.open(tarball_path) as tar:
            tar.extractall(extract_dir, filter="data")

        # GitHub tarballs contain a single top-level directory (owner-repo-sha/)
        top_dirs = os.listdir(extract_dir)
        repo_root = os.path.join(extract_dir, top_dirs[0])

        # ── 3. Walk files, upload to S3, collect CSV paths ───────────────
        manifest = {"repo": GITHUB_REPO, "branch": GITHUB_BRANCH, "files": [], "tables": []}
        csv_files = []

        for root, dirs, files in os.walk(repo_root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fname in files:
                if fname.startswith("."):
                    continue
                full_path = os.path.join(root, fname)
                rel_path = os.path.relpath(full_path, repo_root)

                with open(full_path, "rb") as fh:
                    s3.put_object(
                        Bucket=S3_BUCKET, Key=f"repo/{rel_path}", Body=fh.read()
                    )
                manifest["files"].append(rel_path)

                if rel_path.lower().endswith(".csv"):
                    csv_files.append((rel_path, full_path))

        print(f"Uploaded {len(manifest['files'])} files to S3")

        # ── 4. Build DuckDB index from CSV files ────────────────────────
        db_path = os.path.join(tmpdir, "data.duckdb")
        con = duckdb.connect(db_path)

        for rel_path, full_path in csv_files:
            # Derive a clean table name from the filename
            table_name = os.path.splitext(os.path.basename(rel_path))[0]
            table_name = (
                table_name.replace("-", "_").replace(" ", "_").replace(".", "_").lower()
            )
            table_name = "".join(
                c if c.isalnum() or c == "_" else "_" for c in table_name
            )

            try:
                con.execute(
                    f"CREATE TABLE \"{table_name}\" AS "
                    f"SELECT * FROM read_csv_auto('{full_path}')"
                )
                row_count = con.execute(
                    f'SELECT COUNT(*) FROM "{table_name}"'
                ).fetchone()[0]
                manifest["tables"].append(
                    {"name": table_name, "source": rel_path, "row_count": row_count}
                )
                print(f"  Table '{table_name}' ← {rel_path} ({row_count} rows)")
            except Exception as e:
                print(f"  SKIP  {rel_path}: {e}")

        con.close()

        # ── 5. Upload DuckDB database + manifest to S3 ──────────────────
        s3.upload_file(db_path, S3_BUCKET, "index/data.duckdb")
        s3.put_object(
            Bucket=S3_BUCKET,
            Key="index/manifest.json",
            Body=json.dumps(manifest, indent=2),
            ContentType="application/json",
        )
        print(f"Index complete: {len(manifest['tables'])} tables")

    return {
        "statusCode": 200,
        "body": {
            "files_synced": len(manifest["files"]),
            "tables_created": len(manifest["tables"]),
            "tables": manifest["tables"],
        },
    }
