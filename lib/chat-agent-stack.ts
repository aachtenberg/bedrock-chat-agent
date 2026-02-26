import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfront_origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import * as bedrock from "@aws-cdk/aws-bedrock-alpha";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ChatAgentStackProps extends cdk.StackProps {
  /** GitHub repository in "owner/repo" format */
  readonly githubRepo: string;
  /** Branch to sync (default: "main") */
  readonly githubBranch?: string;
}

export class ChatAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ChatAgentStackProps) {
    super(scope, id, props);

    const githubBranch = props.githubBranch ?? "main";

    // ── S3 bucket for synced repo data + DuckDB index ─────────────────
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          // Clean up incomplete multipart uploads
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    // ── Shared bundling options for Python + DuckDB ───────────────────
    const pythonBundling: cdk.BundlingOptions = {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      command: [
        "bash",
        "-c",
        "pip install -r requirements.txt -t /asset-output && cp -au . /asset-output",
      ],
    };

    // ── Sync Lambda — downloads repo & builds DuckDB index ────────────
    const syncFn = new lambda.Function(this, "SyncFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/sync", { bundling: pythonBundling }),
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      environment: {
        GITHUB_REPO: props.githubRepo,
        GITHUB_BRANCH: githubBranch,
        S3_BUCKET: dataBucket.bucketName,
      },
      description: `Sync ${props.githubRepo} (${githubBranch}) → DuckDB index`,
    });
    dataBucket.grantReadWrite(syncFn);

    // ── EventBridge rule — run sync weekly (Sunday 02:00 UTC) ─────────
    new events.Rule(this, "WeeklySyncRule", {
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2",
        weekDay: "SUN",
      }),
      targets: [new targets.LambdaFunction(syncFn)],
      description: `Weekly sync of ${props.githubRepo}`,
    });

    // ── Query Lambda — Bedrock Agent action-group handler ─────────────
    const queryFn = new lambda.Function(this, "QueryFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/query", { bundling: pythonBundling }),
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      environment: {
        S3_BUCKET: dataBucket.bucketName,
      },
      description: "Bedrock Agent action-group: query DuckDB index & repo files",
    });
    dataBucket.grantRead(queryFn);

    // ── Bedrock Agent ─────────────────────────────────────────────────
    const inferenceProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: bedrock.BedrockFoundationModel.ANTHROPIC_CLAUDE_3_5_SONNET_V2_0,
    });

    const agent = new bedrock.Agent(this, "ChatAgent", {
      agentName: "bedrock-data-agent",
      foundationModel: inferenceProfile,
      instruction:
        "You are a data analyst assistant with access to indexed CSV data " +
        `from the GitHub repository ${props.githubRepo}. ` +
        "The data is refreshed weekly and stored in a DuckDB database.\n\n" +
        "Available tools:\n" +
        "- list_tables: see all indexed tables and row counts\n" +
        "- describe_table: inspect column types and sample data for a table\n" +
        "- query_data: run SQL queries (DuckDB SQL dialect) against the data\n" +
        "- list_repo_files: browse files in the GitHub repository\n" +
        "- read_repo_file: read the contents of a specific file\n\n" +
        "When answering data questions:\n" +
        "1. First call list_tables to understand what data is available\n" +
        "2. Use describe_table to understand schema before writing queries\n" +
        "3. Write precise SQL — prefer aggregations and filters to reduce output\n" +
        "4. Explain your findings clearly, citing specific numbers\n" +
        "If you are unsure about something, say so rather than guessing.",
      userInputEnabled: true,
      shouldPrepareAgent: true,
    });

    // ── Action Group — data tools ─────────────────────────────────────
    const dataTools = new bedrock.AgentActionGroup({
      name: "DataTools",
      description:
        "Tools for querying indexed CSV data and browsing the source GitHub repository",
      executor: bedrock.ActionGroupExecutor.fromLambda(queryFn),
      functionSchema: new bedrock.FunctionSchema({
        functions: [
          {
            name: "query_data",
            description:
              "Run a SQL query (DuckDB dialect) against the indexed CSV data. " +
              "Returns column names and up to 100 rows.",
            parameters: {
              sql: {
                type: bedrock.ParameterType.STRING,
                required: true,
                description:
                  "The SQL query to execute, e.g. SELECT * FROM sales LIMIT 10",
              },
            },
          },
          {
            name: "list_tables",
            description:
              "List all available tables with row counts and source CSV file paths.",
          },
          {
            name: "describe_table",
            description:
              "Show the column names, types, and a 5-row sample for a specific table.",
            parameters: {
              table_name: {
                type: bedrock.ParameterType.STRING,
                required: true,
                description: "The name of the table to describe",
              },
            },
          },
          {
            name: "list_repo_files",
            description:
              "List files in the synced GitHub repository. Optionally filter by path prefix.",
            parameters: {
              path_prefix: {
                type: bedrock.ParameterType.STRING,
                required: false,
                description:
                  'Optional path prefix to filter files, e.g. "data/" to list only files under data/',
              },
            },
          },
          {
            name: "read_repo_file",
            description:
              "Read the text contents of a specific file from the GitHub repository.",
            parameters: {
              file_path: {
                type: bedrock.ParameterType.STRING,
                required: true,
                description:
                  "Relative path to the file, e.g. data/sales.csv or README.md",
              },
            },
          },
        ],
      }),
    });

    agent.addActionGroup(dataTools);

    // ── Alias ─────────────────────────────────────────────────────────
    const alias = new bedrock.AgentAlias(this, "ChatAgentAlias", {
      agent,
      agentAliasName: "live",
      description: `Live alias. Updated at ${agent.lastUpdated}`,
    });

    // ── Chat API Lambda — web UI backend ──────────────────────────────
    const chatApiFn = new lambda.Function(this, "ChatApiFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/chat-api"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        AGENT_ID: agent.agentId,
        AGENT_ALIAS_ID: alias.aliasId,
      },
      description: "Chat API for web UI — invokes Bedrock Agent",
    });

    // Grant permission to invoke the Bedrock Agent
    chatApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeAgent"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:agent/${agent.agentId}`,
          `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${agent.agentId}/${alias.aliasId}`,
        ],
      })
    );

    // ── HTTP API Gateway ──────────────────────────────────────────────
    const httpApi = new apigatewayv2.HttpApi(this, "ChatApi", {
      apiName: "bedrock-chat-api",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ["Content-Type"],
      },
    });

    httpApi.addRoutes({
      path: "/chat",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration(
        "ChatIntegration",
        chatApiFn
      ),
    });

    // ── S3 bucket for static web UI ───────────────────────────────────
    const webBucket = new s3.Bucket(this, "WebBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ── CloudFront distribution ───────────────────────────────────────
    const s3Origin =
      cloudfront_origins.S3BucketOrigin.withOriginAccessControl(webBucket);

    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

    // ── Deploy web UI with API URL injected ───────────────────────────
    // Read the HTML template and inject the API URL using CDK Lazy values
    const htmlTemplate = fs.readFileSync(
      path.join(__dirname, "..", "web", "index.html"),
      "utf-8"
    );

    new s3deploy.BucketDeployment(this, "WebDeployment", {
      sources: [
        s3deploy.Source.data(
          "index.html",
          cdk.Lazy.string({
            produce: () =>
              htmlTemplate.replace("{{API_URL}}", `${httpApi.apiEndpoint}/chat`),
          })
        ),
      ],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // ── Outputs ───────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "AgentId", {
      value: agent.agentId,
      description: "Bedrock Agent ID",
    });

    new cdk.CfnOutput(this, "AgentAliasId", {
      value: alias.aliasId,
      description: "Bedrock Agent Alias ID",
    });

    new cdk.CfnOutput(this, "DataBucketName", {
      value: dataBucket.bucketName,
      description: "S3 bucket storing synced repo data and DuckDB index",
    });

    new cdk.CfnOutput(this, "SyncFunctionName", {
      value: syncFn.functionName,
      description: "Invoke this Lambda to trigger a manual sync",
    });

    new cdk.CfnOutput(this, "ChatApiUrl", {
      value: `${httpApi.apiEndpoint}/chat`,
      description: "Chat API endpoint URL",
    });

    new cdk.CfnOutput(this, "WebUiUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Web chat UI URL (CloudFront)",
    });
  }
}
