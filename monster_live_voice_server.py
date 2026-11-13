import os
import json
import asyncio
import base64
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

try:
    from google import genai
    from google.genai import types
except Exception as exc:
    genai = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env.live"
load_dotenv(ENV_FILE)

HOST = "127.0.0.1"
PORT = 8020
LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

BASE_SYSTEM_INSTRUCTION = os.getenv(
    "MONSTER_LIVE_SYSTEM",
    "You are MONSTER AI in live voice mode.\n"
    "Respond naturally, directly, and concisely.\n"
    "Do not repeat the user unless necessary.\n"
    "You are a voice assistant, not a narrator.\n"
)


# Gemini Live can request only this narrow task-creation operation.
# It cannot select an arbitrary agent, grant tools, or execute shell commands.
MONSTER_TASK_TOOL = {
    "function_declarations": [
        {
            "name": "create_monster_task",
            "description": (
                "Create a MONSTER research task when the user explicitly asks you "
                "to search, investigate, compare, or research something. "
                "Do not say the task was created unless the function returns ok=true."
            ),
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "title": {
                        "type": "STRING",
                        "description": "A short task title, 1 to 160 characters.",
                    },
                    "description": {
                        "type": "STRING",
                        "description": "Research instructions, 1 to 8000 characters.",
                    },
                },
                "required": ["title", "description"],
            },
        }
    ]
}


def _post_voice_task_sync(title: str, description: str) -> dict:
    """Call the loopback-only Next.js voice task endpoint without exposing secrets."""
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse

    token = os.environ.get("MONSTER_VOICE_TASK_TOKEN", "").strip()
    if len(token) < 40:
        raise RuntimeError("MONSTER_VOICE_TASK_TOKEN is missing or too short.")

    endpoint = os.environ.get(
        "MONSTER_TASK_API_URL",
        "http://127.0.0.1:3000/api/tasks/voice",
    ).strip()
    parsed = urlparse(endpoint)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.port not in {None, 3000}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/api/tasks/voice"
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("MONSTER_TASK_API_URL must be the local /api/tasks/voice endpoint.")

    payload = json.dumps(
        {"title": title, "description": description},
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        },
    )

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=12) as response:
            raw = response.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                raise RuntimeError("MONSTER task API response exceeded the size limit.")
            result = json.loads(raw.decode("utf-8"))
            if (
                response.status != 201
                or not isinstance(result, dict)
                or result.get("ok") is not True
                or not isinstance(result.get("task"), dict)
            ):
                raise RuntimeError("MONSTER task API did not confirm task creation.")
            return result
    except urllib.error.HTTPError as exc:
        # Never include request headers or the bearer token in logs/errors.
        detail = exc.read(1000).decode("utf-8", errors="replace")
        raise RuntimeError(f"MONSTER task API returned HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"MONSTER task API is unavailable: {exc.reason}") from None


async def create_monster_task(title: str, description: str) -> dict:
    title = title.strip() if isinstance(title, str) else ""
    description = description.strip() if isinstance(description, str) else ""
    if not title or len(title) > 160:
        raise ValueError("title must contain 1-160 characters.")
    if not description or len(description) > 8000:
        raise ValueError("description must contain 1-8000 characters.")
    return await asyncio.to_thread(_post_voice_task_sync, title, description)


async def handle_monster_live_tool_call(session, response) -> bool:
    """Execute Gemini's task tool and return the result to the same Live session."""
    tool_call = getattr(response, "tool_call", None)
    if tool_call is None:
        return False

    function_responses = []
    for function_call in getattr(tool_call, "function_calls", []) or []:
        if function_call.name != "create_monster_task":
            tool_result = {"ok": False, "error": "Unknown function."}
        else:
            try:
                args = function_call.args or {}
                result = await create_monster_task(
                    args.get("title", ""),
                    args.get("description", ""),
                )
                task = result["task"]
                tool_result = {
                    "ok": True,
                    "task_id": task.get("id"),
                    "status": task.get("status"),
                    "message": "Task accepted by MONSTER Task Queue.",
                }
            except Exception as exc:
                tool_result = {"ok": False, "error": str(exc)[:600]}

        function_responses.append(
            types.FunctionResponse(
                name=function_call.name,
                id=function_call.id,
                response=tool_result,
            )
        )

    if function_responses:
        await session.send_tool_response(function_responses=function_responses)
        return True
    return False

def language_instruction(lang: str) -> str:
    lang = (lang or "ar-DZ").lower()
    if lang.startswith("en"):
        return "Speak and respond ONLY in English unless the user explicitly asks for another language."
    if lang.startswith("fr"):
        return "Speak and respond ONLY in French unless the user explicitly asks for another language."
    return (
        "Speak and respond ONLY in Algerian Arabic (Darija), using Arabic script, "
        "unless the user explicitly asks for another language. Keep technical product "
        "names, code, APIs, and model names in their original form when needed."
    )

app = FastAPI(title="MONSTER Live Voice Gateway")


def make_client():
    if genai is None:
        raise RuntimeError(f"google-genai import failed: {IMPORT_ERROR}")
    if not GEMINI_API_KEY:
        raise RuntimeError(
            f"GEMINI_API_KEY is missing. Put it in {ENV_FILE}"
        )
    return genai.Client(api_key=GEMINI_API_KEY)


@app.get("/health")
async def health():
    ok = bool(GEMINI_API_KEY) and genai is not None
    return JSONResponse({
        "ok": ok,
        "configured": bool(GEMINI_API_KEY),
        "model": LIVE_MODEL,
        "service": "monster-live-voice",
        "port": PORT,
        "import_error": None if genai is not None else str(IMPORT_ERROR),
    })


@app.websocket("/live")
async def live(websocket: WebSocket):
    await websocket.accept()
    try:
        client = make_client()
        query = parse_qs(urlparse(str(websocket.url)).query)
        lang = (query.get("lang", ["ar-DZ"])[0] or "ar-DZ").strip()
        system_instruction = (
            BASE_SYSTEM_INSTRUCTION
            + "\n"
            + language_instruction(lang)
            + "\n"
            + "When the user explicitly asks you to create a research task in MONSTER, "
              "call create_monster_task. Do not claim it was created unless the tool "
              "response says ok=true. A queued task is not a completed task."
        )
        config = {
            "response_modalities": ["AUDIO"],
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "system_instruction": system_instruction,
            "tools": [MONSTER_TASK_TOOL],
            "realtime_input_config": {
                "automatic_activity_detection": {
                    "disabled": False,
                }
            },
        }

        async with client.aio.live.connect(model=LIVE_MODEL, config=config) as session:
            await websocket.send_json({
                "type": "ready",
                "model": LIVE_MODEL,
                "language": lang,
            })

            async def browser_to_gemini():
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break

                    if message.get("bytes") is not None:
                        pcm = message["bytes"]
                        if pcm:
                            await session.send_realtime_input(
                                audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
                            )
                        continue

                    text = message.get("text")
                    if not text:
                        continue
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        continue

                    event = payload.get("type")
                    if event == "audio_end":
                        await session.send_realtime_input(audio_stream_end=True)
                    elif event == "close":
                        return

            async def gemini_to_browser():
                # A Gemini Live turn can complete without ending the live session.
                # Keep the browser WebSocket alive for the next turn.
                while True:
                    saw_any = False
                    async for response in session.receive():
                        saw_any = True

                        # Function calls arrive as a separate Live server event.
                        # Execute the approved task bridge and return FunctionResponse
                        # before continuing to process any audio/transcription parts.
                        if getattr(response, "tool_call", None) is not None:
                            await handle_monster_live_tool_call(session, response)

                        server_content = getattr(response, "server_content", None)
                        if server_content is None:
                            continue

                        if getattr(server_content, "interrupted", False):
                            await websocket.send_json({"type": "interrupted"})
                            continue

                        input_tx = getattr(server_content, "input_transcription", None)
                        if input_tx is not None:
                            text = getattr(input_tx, "text", None)
                            if text:
                                await websocket.send_json({
                                    "type": "input_transcript",
                                    "text": text,
                                    "final": True,
                                })

                        interim_tx = getattr(server_content, "interim_input_transcription", None)
                        if interim_tx is not None:
                            text = getattr(interim_tx, "text", None)
                            if text:
                                await websocket.send_json({
                                    "type": "input_transcript",
                                    "text": text,
                                    "final": False,
                                })

                        output_tx = getattr(server_content, "output_transcription", None)
                        if output_tx is not None:
                            text = getattr(output_tx, "text", None)
                            if text:
                                await websocket.send_json({
                                    "type": "output_transcript",
                                    "text": text,
                                })

                        model_turn = getattr(server_content, "model_turn", None)
                        if model_turn is not None:
                            for part in getattr(model_turn, "parts", []) or []:
                                inline = getattr(part, "inline_data", None)
                                if inline is None:
                                    continue
                                data = getattr(inline, "data", None)
                                if data:
                                    if isinstance(data, str):
                                        data = base64.b64decode(data)
                                    await websocket.send_bytes(data)

                        if getattr(server_content, "turn_complete", False):
                            await websocket.send_json({"type": "turn_complete"})

                    if not saw_any:
                        await asyncio.sleep(0.01)

            forward_task = asyncio.create_task(browser_to_gemini())
            receive_task = asyncio.create_task(gemini_to_browser())
            try:
                # The browser task owns the WebSocket lifetime. A completed Gemini
                # turn must NOT tear down the session; only browser disconnect/close does.
                await forward_task
            finally:
                if not receive_task.done():
                    receive_task.cancel()
                    try:
                        await receive_task
                    except asyncio.CancelledError:
                        pass
                elif receive_task.exception():
                    raise receive_task.exception()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
        print("LIVE VOICE ERROR:", repr(exc))
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    print("=" * 64)
    print("MONSTER LIVE VOICE GATEWAY")
    print("=" * 64)
    print("Model:", LIVE_MODEL)
    print("Env  :", ENV_FILE)
    print("URL  :", f"ws://{HOST}:{PORT}/live")
    print("Health:", f"http://{HOST}:{PORT}/health")
    uvicorn.run(app, host=HOST, port=PORT)
