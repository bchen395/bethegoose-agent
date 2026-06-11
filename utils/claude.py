"""utils/claude.py — shared Claude API access for the three agents.

Every agent talks to the model through this module, never the SDK directly, so
that:
  - the API key and client are created once (lazily, from .env),
  - structured output is forced via tool-use and parsed defensively with one
    retry, then raised as AgentError on final failure (SPEC § Output reliability)
    so the caller writes nothing half-baked to SQLite,
  - web search is a separate, cost-capped call (each search is billable; the
    Strategy Agent runs 2-3 per weekly run, max).

Output mechanism: the installed SDK exposes tool-use, so `call_json` forces a
single output tool whose `input_schema` is the caller's JSON schema and reads
the model's tool-call arguments back as a dict — no free-text JSON to coax. The
fence-stripping fallback covers the rare case where arguments arrive as a string.

Model ids come from SPEC § Stack decisions and are passed in by each agent.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path

import anthropic
from dotenv import load_dotenv

# --- Models (SPEC § Stack decisions) -----------------------------------------

STRATEGY_MODEL = "claude-sonnet-4-6"               # editorial judgment
CONTENT_MODEL = "claude-haiku-4-5-20251001"        # hashtags / hooks / CTA
DISTRIBUTION_MODEL = "claude-haiku-4-5-20251001"   # logic + formatting

# Each web search is a billable line item; the Strategy Agent runs 2-3 per run.
MAX_WEB_SEARCHES = 3

# Current web-search tool version (server-side; the model searches and returns
# a synthesis in one turn).
_WEB_SEARCH_TOOL = "web_search_20260209"

_SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
_client = None


class AgentError(RuntimeError):
    """A model call could not produce usable output.

    On this error the caller writes nothing to SQLite and surfaces the message
    to the UI (SPEC § Output reliability).
    """


# --- Client ------------------------------------------------------------------

def get_client():
    """Return the shared Anthropic client, creating it from .env on first use."""
    global _client
    if _client is None:
        load_dotenv(_ENV_PATH)
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key or key == "your_key_here":
            raise AgentError(
                "ANTHROPIC_API_KEY is not set — add your real key to .env"
            )
        _client = anthropic.Anthropic(api_key=key)
    return _client


# --- Content helpers ---------------------------------------------------------

def image_block(path):
    """Build a base64 image content block for a local file.

    The Content Agent attaches the post's art (an image, or a frame it extracts
    from a video) so the model's hashtags and reel hooks reference what's really
    in the post.
    """
    p = Path(path)
    media_type = mimetypes.guess_type(p.name)[0]
    if media_type == "image/jpg":  # mimetypes never returns this, but be safe
        media_type = "image/jpeg"
    if media_type not in _SUPPORTED_IMAGE_TYPES:
        raise AgentError(
            f"Unsupported image type for {p.name!r}: {media_type or 'unknown'} "
            f"(supported: {sorted(_SUPPORTED_IMAGE_TYPES)})"
        )
    data = base64.standard_b64encode(p.read_bytes()).decode("utf-8")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


# --- JSON parsing ------------------------------------------------------------

def _strip_fences(text):
    """Drop a surrounding ```json ... ``` (or bare ``` ... ```) fence if present."""
    t = text.strip()
    if not t.startswith("```"):
        return t
    lines = t.splitlines()[1:]                      # drop opening ``` / ```json
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]                          # drop closing ```
    return "\n".join(lines).strip()


def _parse_json_object(text):
    """Parse `text` into a JSON object, tolerating fences and stray prose."""
    candidate = _strip_fences(text)
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start == -1 or end <= start:
            raise
        data = json.loads(candidate[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("model returned JSON that is not an object")
    return data


def _extract_tool_result(resp, tool_name):
    """Pull the forced tool call's arguments out of a response as a dict."""
    if resp.stop_reason == "refusal":
        detail = getattr(resp.stop_details, "explanation", None)
        raise AgentError(f"Model refused the request: {detail or 'no detail given'}")

    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            args = block.input
            if isinstance(args, dict):
                return args
            if isinstance(args, str):           # defensive: arguments as a string
                return _parse_json_object(args)
            raise ValueError(f"tool arguments were {type(args).__name__}, not an object")

    if resp.stop_reason == "max_tokens":
        raise ValueError("output hit max_tokens before the tool call completed")
    raise ValueError(f"no '{tool_name}' tool call in the response")


# --- Forced-JSON call --------------------------------------------------------

def call_json(*, model, system, content, schema,
              tool_name="record", tool_description="Record the structured result.",
              max_tokens=2048):
    """Call the model and return a dict matching `schema`.

    Forces a single output tool so the model must return structured arguments;
    parses them defensively and, on failure, retries once with a stricter
    instruction before raising AgentError.

    Args:
      model: a model id constant from this module.
      system: the agent's system prompt (defines the schema's meaning).
      content: a user-turn string, or a list of content blocks (text + images).
      schema: JSON Schema for the output object (the tool's input_schema).
      tool_name / tool_description: surfaced to the model as the output tool.
      max_tokens: output cap; small for these structured payloads.
    """
    client = get_client()
    tool = {"name": tool_name, "description": tool_description, "input_schema": schema}
    last_error = None

    for attempt in range(2):                        # initial try + one retry
        sys_prompt = system if attempt == 0 else (
            system + f"\n\nCall the `{tool_name}` tool exactly once with a single "
            "complete argument object that matches the schema. Do not include any "
            "other text."
        )
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=sys_prompt,
                messages=[{"role": "user", "content": content}],
                tools=[tool],
                tool_choice={"type": "tool", "name": tool_name},
            )
        except anthropic.APIError as e:             # SDK already retried transients
            raise AgentError(f"Claude API call failed: {e}") from e

        try:
            return _extract_tool_result(resp, tool_name)
        except (json.JSONDecodeError, ValueError) as e:
            last_error = e                          # fall through to the retry

    raise AgentError(f"Could not get valid JSON from the model after a retry: {last_error}")


# --- Web search --------------------------------------------------------------

def web_search(*, prompt, model=STRATEGY_MODEL, system=None,
               max_searches=MAX_WEB_SEARCHES, max_tokens=4096):
    """Run up to `max_searches` web searches and return synthesized findings.

    Returns {"text": <model's synthesis>, "queries": [<search queries run>]}.
    The Strategy Agent feeds the text into `call_json` as supplementary context
    — it does not loop. Each search is billable, so `max_searches` is hard-capped
    at MAX_WEB_SEARCHES.
    """
    client = get_client()
    capped = max(1, min(int(max_searches), MAX_WEB_SEARCHES))
    tools = [{"type": _WEB_SEARCH_TOOL, "name": "web_search", "max_uses": capped}]
    kwargs = {"model": model, "max_tokens": max_tokens, "tools": tools}
    if system:
        kwargs["system"] = system

    messages = [{"role": "user", "content": prompt}]
    queries, text_parts = [], []

    for _ in range(5):                              # bounded: handle pause_turn
        try:
            resp = client.messages.create(messages=messages, **kwargs)
        except anthropic.APIError as e:
            raise AgentError(f"Web search call failed: {e}") from e

        for block in resp.content:
            btype = getattr(block, "type", None)
            if btype == "server_tool_use" and getattr(block, "name", None) == "web_search":
                query = getattr(block, "input", {}).get("query") if isinstance(getattr(block, "input", None), dict) else None
                if query:
                    queries.append(query)
            elif btype == "text":
                text_parts.append(block.text)

        if resp.stop_reason == "pause_turn":        # server tool loop paused; resume
            messages.append({"role": "assistant", "content": resp.content})
            continue
        break

    return {"text": "\n".join(p for p in text_parts if p).strip(), "queries": queries}
