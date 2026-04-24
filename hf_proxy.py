"""
Footy Cards — HF Portrait Proxy
Forwards image generation requests to Hugging Face, adding CORS headers.

Usage:
  python hf_proxy.py

Runs on http://localhost:8001
Leave this running alongside your main python -m http.server 8000
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request, json, sys

HF_URL = "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell"
PORT   = 8001

class ProxyHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"[proxy] {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")

    # Handle preflight
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length   = int(self.headers.get("Content-Length", 0))
        body     = self.rfile.read(length)
        auth     = self.headers.get("Authorization", "")

        req = urllib.request.Request(
            HF_URL,
            data    = body,
            method  = "POST",
            headers = {
                "Authorization": auth,
                "Content-Type":  "application/json",
                "Accept":        "image/jpeg",
            }
        )

        try:
            with urllib.request.urlopen(req) as resp:
                img_data    = resp.read()
                content_type = resp.headers.get("Content-Type", "image/jpeg")

            self.send_response(200)
            self._cors()
            self.send_header("Content-Type",   content_type)
            self.send_header("Content-Length", str(len(img_data)))
            self.end_headers()
            self.wfile.write(img_data)

        except urllib.error.HTTPError as e:
            err = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(err)
            print(f"[proxy] HF error {e.code}: {err[:200]}")

        except Exception as e:
            self.send_response(500)
            self._cors()
            self.end_headers()
            print(f"[proxy] Exception: {e}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"✅  HF proxy running on http://0.0.0.0:{PORT} (accessible on all network interfaces)")
    print(f"    Forwarding to: {HF_URL}")
    print(f"    Press Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nProxy stopped.")
        sys.exit(0)
