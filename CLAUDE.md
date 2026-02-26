# Bedrock Chat Agent

AWS CDK project that deploys an Amazon Bedrock Agent with DuckDB-powered CSV querying and a web chat UI.

## Project Structure

```
bin/app.ts                  CDK app entrypoint
lib/chat-agent-stack.ts     Main stack — Agent, Lambdas, API Gateway, CloudFront
cdk.json                    CDK config (uses tsx to run TypeScript directly)
data/                       Sample CSV data (sales, customers, products, inventory)
lambda/
  sync/index.py             Weekly sync: pulls GitHub repo → indexes CSVs in DuckDB
  query/index.py            Bedrock Agent tools: SQL queries, file browsing
  chat-api/index.py         HTTP API for web chat UI
web/index.html              Lightweight chat interface
```

## Tech Stack

- **Language:** TypeScript (ES2023, NodeNext modules, ESM via `"type": "module"`)
- **IaC:** AWS CDK v2 (`aws-cdk-lib` 2.240.0)
- **Bedrock:** `@aws-cdk/aws-bedrock-alpha` 2.240.0-alpha.0
- **Lambdas:** Python 3.12 with DuckDB
- **Runtime:** Node.js >= 22.12.0
- **Package Manager:** pnpm 10.23.0

## Commands

```bash
pnpm build        # tsc — compile TypeScript
pnpm synth        # cdk synth — synthesize CloudFormation
pnpm deploy       # cdk deploy
pnpm destroy      # cdk destroy
pnpm diff         # cdk diff
```

## Deploy

```bash
# Deploy with your GitHub repo (required)
npx cdk deploy -c githubRepo=owner/repo-name

# Optional: specify branch
npx cdk deploy -c githubRepo=owner/repo-name -c githubBranch=develop

# Trigger initial data sync after deploy
aws lambda invoke --function-name <SyncFunctionName from outputs> /dev/null
```

## Testing with This Repo

This repo includes sample CSV data in `data/` for testing:
- **sales.csv** — 36 rows of sales transactions by region/product
- **customers.csv** — 15 customers with plans and spend
- **products.csv** — 10 products with pricing and suppliers
- **inventory.csv** — 40 rows of warehouse stock levels

To test:
1. Push this repo to GitHub
2. Deploy: `npx cdk deploy -c githubRepo=YOUR_USERNAME/bedrock-chat-agent`
3. Trigger sync: `aws lambda invoke --function-name <SyncFunctionName> /dev/null`
4. Open the `WebUiUrl` from outputs

Example queries to try:
- "What tables are available?"
- "Show me total revenue by region"
- "Which products have inventory below reorder level?"
- "What's the average monthly spend by customer plan?"
- "Read the README file"

## Agent Tools

| Tool | Description |
|------|-------------|
| `list_tables` | Show all indexed CSV tables with row counts |
| `describe_table` | Column types and 5-row sample for a table |
| `query_data` | Run SQL (DuckDB dialect) against indexed data |
| `list_repo_files` | List files in the synced GitHub repo |
| `read_repo_file` | Read contents of a specific file |

## Infrastructure

- **Bedrock Agent:** Claude 3.5 Sonnet v2 with data analyst instructions
- **Sync Lambda:** Downloads repo weekly (Sunday 02:00 UTC), indexes CSVs to DuckDB
- **Query Lambda:** Executes agent tool calls against DuckDB + S3
- **Chat API:** HTTP API Gateway → Lambda for web UI
- **Web UI:** CloudFront + S3 static hosting
- **S3 Bucket:** Stores synced repo files + DuckDB database

## Outputs

| Output | Description |
|--------|-------------|
| `AgentId` | Bedrock Agent ID |
| `AgentAliasId` | Agent alias ID (live) |
| `DataBucketName` | S3 bucket with data and index |
| `SyncFunctionName` | Lambda to trigger manual sync |
| `ChatApiUrl` | API endpoint for chat |
| `WebUiUrl` | CloudFront URL for web chat UI |

## Notes

- The `@aws-cdk/aws-bedrock-alpha` package is alpha — API may change across CDK versions
- `shouldPrepareAgent: true` auto-prepares the agent after creation
- CDK app runs via `npx tsx` (no separate build step needed for synth/deploy)
- Sync runs weekly; invoke the sync Lambda manually after first deploy
