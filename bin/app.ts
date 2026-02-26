import * as cdk from "aws-cdk-lib";
import { ChatAgentStack } from "../lib/chat-agent-stack.js";

const app = new cdk.App();

const githubRepo = app.node.tryGetContext("githubRepo");
if (!githubRepo) {
  throw new Error(
    'Missing required context: -c githubRepo=owner/repo  (e.g. -c githubRepo=awesome-org/data-repo)'
  );
}

new ChatAgentStack(app, "BedrockChatAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  githubRepo,
  githubBranch: app.node.tryGetContext("githubBranch") ?? "main",
});
