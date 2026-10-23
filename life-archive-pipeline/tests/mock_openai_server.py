#!/usr/bin/env python3
"""本地 mock OpenAI 兼容服务，用来在没有真实 API Key 的情况下验证 LLM 后端链路。"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

RECEIVED: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        RECEIVED.append({"path": self.path, "body": body, "auth": self.headers.get("Authorization")})
        prompt = body.get("messages", [{}])[-1].get("content", "")
        reply = f"【MOCK】已收到 {len(prompt)} 字提示词，模型={body.get('model')}，示例摘要。"
        payload = {"choices": [{"message": {"role": "assistant", "content": reply}}]}
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"mock server on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
