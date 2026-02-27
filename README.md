# Bedrock Chat Agent

AWS CDK project that deploys an Amazon Bedrock Agent with DuckDB-powered CSV querying and a web chat UI.

![Architecture](https://img.shields.io/badge/AWS-Bedrock%20Agent-orange) ![CDK](https://img.shields.io/badge/CDK-v2-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Overview

This project creates a conversational AI agent that can:
- **Query CSV data** indexed in DuckDB using natural language
- **Browse repository files** from a synced GitHub repo
- **Auto-sync weekly** to keep data fresh
- **Web chat interface** for easy interaction

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   CloudFront    │────▶│   API Gateway    │────▶│   Chat Lambda   │
│   (Web UI)      │     │   (HTTP API)     │     │                 │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   EventBridge   │────▶│   Sync Lambda    │────▶│   S3 Bucket     │
│   (Weekly)      │     │   (Index CSVs)   │     │   (Data+Index)  │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌──────────────────┐              │
                        │  Bedrock Agent   │◀─────────────┘
                        │  (Nova Pro)      │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  Query Lambda    │
                        │  (Agent Tools)   │
                        └──────────────────┘
```

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

| Component | Technology |
|-----------|------------|
| **Language** | TypeScript (ES2023, NodeNext modules) |
| **IaC** | AWS CDK v2 (`aws-cdk-lib` 2.240.0) |
| **Bedrock** | `@aws-cdk/aws-bedrock-alpha` 2.240.0-alpha.0 |
| **Model** | Amazon Nova Pro |
| **Lambdas** | Python 3.12 with DuckDB |
| **Runtime** | Node.js >= 22.12.0 |
| **Package Manager** | pnpm 10.23.0 |

## Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 22.12.0+
- pnpm 10.23.0+
- Model access enabled for Amazon Nova Pro in your AWS account

### Installation

```bash
# Clone the repository
git clone https://github.com/aachtenberg/bedrock-chat-agent.git
cd bedrock-chat-agent

# Install dependencies
pnpm install
```

### Deploy

```bash
# Deploy with your GitHub repo (required)
npx cdk deploy -c githubRepo=owner/repo-name

# Optional: specify branch
npx cdk deploy -c githubRepo=owner/repo-name -c githubBranch=develop

# Trigger initial data sync after deploy
aws lambda invoke --function-name <SyncFunctionName from outputs> /dev/null
```

### Test with Sample Data

This repo includes sample CSV data in `data/` for testing:

| File | Description |
|------|-------------|
| `sales.csv` | 36 rows of sales transactions by region/product |
| `customers.csv` | 15 customers with plans and spend |
| `products.csv` | 10 products with pricing and suppliers |
| `inventory.csv` | 40 rows of warehouse stock levels |

**Steps:**
1. Push this repo to GitHub
2. Deploy: `npx cdk deploy -c githubRepo=YOUR_USERNAME/bedrock-chat-agent`
3. Trigger sync: `aws lambda invoke --function-name <SyncFunctionName> /dev/null`
4. Open the `WebUiUrl` from outputs

**Example queries to try:**
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

## Stack Outputs

| Output | Description |
|--------|-------------|
| `AgentId` | Bedrock Agent ID |
| `AgentAliasId` | Agent alias ID (live) |
| `DataBucketName` | S3 bucket with data and index |
| `SyncFunctionName` | Lambda to trigger manual sync |
| `ChatApiUrl` | API endpoint for chat |
| `WebUiUrl` | CloudFront URL for web chat UI |

## Commands

```bash
pnpm build        # tsc — compile TypeScript
pnpm synth        # cdk synth — synthesize CloudFormation
pnpm deploy       # cdk deploy
pnpm destroy      # cdk destroy
pnpm diff         # cdk diff
```

## Notes

- The `@aws-cdk/aws-bedrock-alpha` package is alpha — API may change across CDK versions
- `shouldPrepareAgent: true` auto-prepares the agent after creation
- CDK app runs via `npx tsx` (no separate build step needed for synth/deploy)
- Sync runs weekly (Sunday 02:00 UTC); invoke the sync Lambda manually after first deploy

## License

MIT
