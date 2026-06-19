#!/usr/bin/env python3
"""
Helmio event listener for Supervisor.

Runs as a `[eventlistener:helmio]` subprocess of supervisord. It speaks the
Supervisor event-listener protocol on stdin/stdout and forwards every event to
the Helmio backend over HTTP, giving the panel instant, push-based updates
instead of polling.

Pure standard library — no pip installs. Works with any Python 3 (which is
always present on a supervisord host, since supervisord itself is Python).

Configuration comes from the environment (set via `environment=` in the
eventlistener config that Helmio generates):

    HELMIO_INGEST_URL   Base ingest URL, e.g. http://panel-host:3001/api/ingest
    HELMIO_SERVER_ID    The server id this supervisord is registered as in Helmio
    HELMIO_TOKEN        Per-server ingest token (machine-to-machine auth)
    HELMIO_TIMEOUT      HTTP timeout seconds (default 5)

Protocol reference: http://supervisord.org/events.html
"""
import json
import os
import sys
import urllib.request
import urllib.error

INGEST_URL = os.environ.get("HELMIO_INGEST_URL", "").rstrip("/")
SERVER_ID = os.environ.get("HELMIO_SERVER_ID", "")
TOKEN = os.environ.get("HELMIO_TOKEN", "")
TIMEOUT = float(os.environ.get("HELMIO_TIMEOUT", "5"))

ENDPOINT = "{0}/{1}/events".format(INGEST_URL, SERVER_ID) if INGEST_URL and SERVER_ID else ""


def write_stdout(s):
    # Only the protocol tokens (READY / RESULT) may go to stdout.
    sys.stdout.write(s)
    sys.stdout.flush()


def write_stderr(s):
    sys.stderr.write(s)
    sys.stderr.flush()


def parse_tokens(text):
    """Parse 'key:value key:value' header/payload lines into a dict."""
    out = {}
    for tok in text.split():
        if ":" in tok:
            k, v = tok.split(":", 1)
            out[k] = v
    return out


def forward(event):
    """POST a single event to Helmio. Never raise — listener must stay alive."""
    if not ENDPOINT:
        write_stderr("helmio: HELMIO_INGEST_URL / HELMIO_SERVER_ID not set\n")
        return False
    body = json.dumps(event).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as e:
        write_stderr("helmio: ingest HTTP {0}\n".format(e.code))
    except Exception as e:  # noqa: BLE001 - best effort, keep listening
        write_stderr("helmio: ingest failed: {0}\n".format(e))
    return False


def main():
    while True:
        # 1. Tell supervisord we are ready for an event.
        write_stdout("READY\n")

        # 2. Read the event header line.
        line = sys.stdin.readline()
        if not line:
            break
        headers = parse_tokens(line)
        try:
            payload_len = int(headers.get("len", "0"))
        except ValueError:
            payload_len = 0

        # 3. Read exactly payload_len bytes of payload.
        payload_raw = sys.stdin.read(payload_len) if payload_len else ""

        # Payload = 'key:val key:val' optionally followed by '\n<additional data>'
        # (PROCESS_LOG / PROCESS_COMMUNICATION events carry a data chunk).
        meta_part, sep, data_part = payload_raw.partition("\n")
        payload = parse_tokens(meta_part)
        if sep and data_part:
            payload["data"] = data_part

        event = {
            "eventname": headers.get("eventname"),
            "serial": headers.get("serial"),
            "pool": headers.get("pool"),
            "poolserial": headers.get("poolserial"),
            "payload": payload,
        }
        forward(event)

        # 4. Acknowledge so supervisord moves on. We always OK — a transport
        #    failure is logged to stderr, not pushed back onto supervisord.
        write_stdout("RESULT 2\nOK")


if __name__ == "__main__":
    main()
