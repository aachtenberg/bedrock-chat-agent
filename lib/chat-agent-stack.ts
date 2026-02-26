import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as bedrock from "@aws-cdk/aws-bedrock-alpha";

export class ChatAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const agent = new bedrock.Agent(this, "ChatAgent", {
      agentName: "bedrock-chat-agent",
      foundationModel:
        bedrock.BedrockFoundationModel.ANTHROPIC_CLAUDE_3_5_SONNET_V2_0,
      instruction:
        "You are a helpful, friendly, and knowledgeable assistant. " +
        "Answer questions clearly and concisely. " +
        "If you are unsure about something, say so rather than guessing. " +
        "When appropriate, provide examples to illustrate your points.",
      userInputEnabled: true,
      shouldPrepareAgent: true,
    });

    const alias = new bedrock.AgentAlias(this, "ChatAgentAlias", {
      agent,
      agentAliasName: "live",
      description: `Live alias. Updated at ${agent.lastUpdated}`,
    });

    new cdk.CfnOutput(this, "AgentId", {
      value: agent.agentId,
      description: "Bedrock Agent ID",
    });

    new cdk.CfnOutput(this, "AgentAliasId", {
      value: alias.aliasId,
      description: "Bedrock Agent Alias ID",
    });
  }
}
