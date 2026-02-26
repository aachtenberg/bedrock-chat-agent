"""
Chat API Lambda: HTTP endpoint for the web chat UI.

Invokes the Bedrock Agent and returns responses.
Supports conversation sessions via session_id.
"""

import json
import os
import uuid

import boto3

AGENT_ID = os.environ["AGENT_ID"]
AGENT_ALIAS_ID = os.environ["AGENT_ALIAS_ID"]

bedrock_agent = boto3.client("bedrock-agent-runtime")


def handler(event, context):
    # Handle CORS preflight
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": "",
        }

    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return error_response(400, "Invalid JSON body")

    message = body.get("message", "").strip()
    if not message:
        return error_response(400, "Missing 'message' field")

    # Session ID for conversation continuity (optional)
    session_id = body.get("session_id") or str(uuid.uuid4())

    try:
        response = bedrock_agent.invoke_agent(
            agentId=AGENT_ID,
            agentAliasId=AGENT_ALIAS_ID,
            sessionId=session_id,
            inputText=message,
        )

        # Collect the streamed response
        completion = ""
        for event_chunk in response.get("completion", []):
            if "chunk" in event_chunk:
                chunk_bytes = event_chunk["chunk"].get("bytes", b"")
                completion += chunk_bytes.decode("utf-8")

        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({
                "response": completion,
                "session_id": session_id,
            }),
        }

    except Exception as e:
        print(f"Error invoking agent: {e}")
        return error_response(500, f"Agent error: {str(e)}")


def cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def error_response(status_code, message):
    return {
        "statusCode": status_code,
        "headers": cors_headers(),
        "body": json.dumps({"error": message}),
    }
