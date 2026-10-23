"""``python -m ort`` — start the OpenRealtime server (default 0.0.0.0:8787)."""
from __future__ import annotations

import argparse
import logging
import os

from aiohttp import web


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m ort", description="OpenRealtime: self-hosted OpenAI-Realtime-compatible server")
    ap.add_argument("--host", default=None, help="bind host (env ORT_HOST, default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=None, help="port (env ORT_PORT, default 8787)")
    ap.add_argument("--llm", default=None, help="openrouter | mock (env OPENREALTIME_LLM)")
    ap.add_argument("--no-warmup", action="store_true", help="load models lazily on the first session")
    ap.add_argument("--log-level", default=os.environ.get("ORT_LOG_LEVEL", "INFO"))
    args = ap.parse_args()
    if args.llm:
        os.environ["OPENREALTIME_LLM"] = args.llm
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("aiortc").setLevel(logging.WARNING)

    from .config import Config
    from .server import create_app

    cfg = Config.from_env()
    if args.host:
        cfg.host = args.host
    if args.port:
        cfg.port = args.port
    app = create_app(cfg, warmup=not args.no_warmup)
    logging.getLogger("ort").info("OpenRealtime on http://%s:%d (llm=%s)", cfg.host, cfg.port, cfg.llm)
    web.run_app(app, host=cfg.host, port=cfg.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
