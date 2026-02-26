import * as cdk from "aws-cdk-lib";
import { ChatAgentStack } from "../lib/chat-agent-stack.js";

const app = new cdk.App();

new ChatAgentStack(app, "BedrockChatAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
