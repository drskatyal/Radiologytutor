#!/usr/bin/env python3
"""Local Orthanc-shaped archive for the downloaded LIDC CT.

Speaks the two things the app asks for: Orthanc REST (study/series lookup)
and WADO-RS metadata + frames. Axial slices are ordered along the slice
normal so stack index 34 is the mid-chest the teaching case describes.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pydicom

DICOM_DIR = Path("/workspace/data/lidc-ct")
META_PATH = Path("/workspace/data/lidc-ct/metadata.json")
STUDY = "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159"
SERIES = "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463"
STUDY_ID = "study-lidc"
SERIES_ID = "series-lidc"


def sort_meta(items: list[dict]) -> list[dict]:
    def key(item: dict) -> float:
        pos = item.get("00200032", {}).get("Value") or [0, 0, 0]
        iop = item.get("00200037", {}).get("Value") or [1, 0, 0, 0, 1, 0]
        rx, ry, rz, cx, cy, cz = (float(v) for v in iop[:6])
        normal = (ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx)
        return sum(float(pos[i]) * normal[i] for i in range(3))

    return sorted(items, key=key, reverse=True)


def without_pixels(items: list[dict]) -> list[dict]:
    cleaned = []
    for item in items:
        copy = {key: value for key, value in item.items() if key != "7FE00010"}
        cleaned.append(copy)
    return cleaned


META = without_pixels(sort_meta(json.loads(META_PATH.read_text())))
SOPS = [item["00080018"]["Value"][0] for item in META]
PIXELS: dict[str, bytes] = {}


def load_pixels() -> None:
    original = json.loads(META_PATH.read_text())
    file_for = {}
    for index, item in enumerate(original):
        file_for[item["00080018"]["Value"][0]] = DICOM_DIR / f"{index:03d}.dcm"
    for sop in SOPS:
        ds = pydicom.dcmread(file_for[sop])
        PIXELS[sop] = bytes(ds.PixelData)


load_pixels()
print(f"loaded {len(PIXELS)} frames", flush=True)


def frame_body(pixels: bytes) -> bytes:
    boundary = "radlearn-frame"
    head = (
        f"--{boundary}\r\n"
        "Content-Type: application/octet-stream\r\n"
        "\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + pixels + tail


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        if args and str(args[1]).startswith("4"):
            print(fmt % args, flush=True)

    def _dicom_json(self, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/dicom+json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            body = {}
        if self.path.rstrip("/") == "/tools/find":
            query = body.get("Query") or {}
            level = body.get("Level")
            if level == "Study" and query.get("StudyInstanceUID") == STUDY:
                self._json([STUDY_ID])
                return
            if level == "Series" and query.get("SeriesInstanceUID") == SERIES:
                self._json([SERIES_ID])
                return
            self._json([])
            return
        self._json({"error": "unsupported"}, 404)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == f"/studies/{STUDY_ID}":
            self._json({"Series": [SERIES_ID], "MainDicomTags": {"StudyInstanceUID": STUDY}})
            return
        if path == f"/series/{SERIES_ID}":
            self._json(
                {
                    "MainDicomTags": {
                        "SeriesInstanceUID": SERIES,
                        "Modality": "CT",
                        "SeriesDescription": "CAP 5.0 B30s",
                        "SeriesNumber": "1",
                    },
                    "Instances": [f"inst-{i:03d}" for i in range(len(SOPS))],
                }
            )
            return
        if path.startswith("/instances/inst-") and path.endswith("/file"):
            index = int(path.split("/")[2].split("-")[1])
            self._send(PIXELS[SOPS[index]], "application/dicom")
            return
        if path.startswith("/instances/inst-"):
            index = int(path.split("/")[2].split("-")[1])
            self._json({"MainDicomTags": {"SOPInstanceUID": SOPS[index], "InstanceNumber": str(index + 1)}})
            return
        prefix = f"/dicom-web/studies/{STUDY}/series/{SERIES}"
        if path == f"{prefix}/metadata":
            self._dicom_json(META)
            return
        if path == f"{prefix}/instances":
            from urllib.parse import parse_qs, urlparse

            query = parse_qs(urlparse(self.path).query)
            offset = int((query.get("offset") or ["0"])[0] or 0)
            limit = int((query.get("limit") or [str(len(META))])[0] or len(META))
            self._dicom_json(META[offset : offset + limit])
            return
        if path.startswith(prefix) and path.endswith("/metadata") and "/instances/" in path:
            sop = path.split("/instances/", 1)[1].split("/", 1)[0]
            item = next((row for row in META if row["00080018"]["Value"][0] == sop), None)
            if item is None:
                self.send_error(404)
                return
            self._dicom_json([item])
            return
        marker = "/instances/"
        if path.startswith(prefix) and "/frames/" in path and marker in path:
            sop = path.split(marker, 1)[1].split("/", 1)[0]
            pixels = PIXELS.get(sop)
            if pixels is None:
                self.send_error(404)
                return
            body = frame_body(pixels)
            self.send_response(200)
            self.send_header(
                "content-type",
                'multipart/related; type="application/octet-stream"; boundary=radlearn-frame; transfer-syntax=1.2.840.10008.1.2',
            )
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8042), Handler)
    print("local CT archive on http://127.0.0.1:8042", flush=True)
    server.serve_forever()
