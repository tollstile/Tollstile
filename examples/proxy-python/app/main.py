"""An ordinary FastAPI service with an MCP server, and no payment code at all.

Tollstile's proxy runs in front of it and charges for the routes and tools listed in
tollstile.proxy.ts. Run this app on a private address that only the proxy can reach.
"""

import contextlib

from fastapi import FastAPI, Request, Response
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("images")


@mcp.tool()
def generate_image(prompt: str) -> str:
    """Generate an image for a prompt. Priced by the proxy."""
    return f"https://images.example.com/{abs(hash(prompt))}.png"


@mcp.tool()
def list_styles() -> list[str]:
    """List available styles. Free."""
    return ["photo", "sketch", "watercolor"]


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/weather")
def weather(request: Request, city: str = "Tokyo") -> dict[str, str]:
    # The proxy tells the service who paid; trust these headers only from the proxy.
    return {"city": city, "forecast": "clear", "paid_by": request.headers.get("tollstile-payer", "")}


@app.post("/summarize")
async def summarize(request: Request, response: Response) -> dict[str, str]:
    text = (await request.body()).decode()
    words = len(text.split())
    # Priced up to $0.50: report what this call actually used, $0.001 per word.
    response.headers["tollstile-fulfill-amount"] = f"${min(words, 500) / 1000:.3f}"
    return {"summary": " ".join(text.split()[:12]), "words": str(words)}


# The MCP endpoint is POST /mcp. Mounted last so the routes above take precedence.
app.mount("/", mcp.streamable_http_app(streamable_http_path="/mcp", stateless_http=True))
