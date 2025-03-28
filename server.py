from pathlib import Path
from mokuro.manga_page_ocr import MangaPageOcr, InvalidImage
from mokuro import __version__
from mokuro.utils import NumpyEncoder
import cv2
import numpy as np
from PIL import Image
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import hashlib


# https://github.com/kha-white/mokuro/blob/master/mokuro/manga_page_ocr.py
class OCRD(MangaPageOcr):
    def __call__(self, image_bytes):
        img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise InvalidImage()
        H, W, *_ = img.shape
        result = {"version": __version__, "img_width": W, "img_height": H, "blocks": []}

        if self.disable_ocr:
            return result

        mask, mask_refined, blk_list = self.text_detector(img, refine_mode=1, keep_undetected_mask=True)
        for blk_idx, blk in enumerate(blk_list):
            result_blk = {
                "box": list(blk.xyxy),
                "vertical": blk.vertical,
                "font_size": blk.font_size,
                "lines_coords": [],
                "lines": [],
            }

            for line_idx, line in enumerate(blk.lines_array()):
                if blk.vertical:
                    max_ratio = self.max_ratio_vert
                else:
                    max_ratio = self.max_ratio_hor

                line_crops, cut_points = self.split_into_chunks(
                    img,
                    mask_refined,
                    blk,
                    line_idx,
                    textheight=self.text_height,
                    max_ratio=max_ratio,
                    anchor_window=self.anchor_window,
                )

                line_text = ""
                for line_crop in line_crops:
                    if blk.vertical:
                        line_crop = cv2.rotate(line_crop, cv2.ROTATE_90_CLOCKWISE)
                    line_text += self.mocr(Image.fromarray(line_crop))

                result_blk["lines_coords"].append(line.tolist())
                result_blk["lines"].append(line_text)

            result["blocks"].append(result_blk)

        return result


class OCR:
    def __init__(self):
        self.mpocr = None
        self.init_models()

    def init_models(self):
        if self.mpocr is None:
            self.mpocr = OCRD(
                "kha-white/manga-ocr-base",
            )

    def ocr(self, image_bytes):
        result = self.mpocr(image_bytes)
        return result


ocr = OCR()


class OCRHandler(BaseHTTPRequestHandler):
    cache_location = Path("_cache")

    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        image_bytes = self.rfile.read(content_length)

        try:
            sha256 = hashlib.sha256(image_bytes).hexdigest()
            size = len(image_bytes)
            cache_path = self.cache_location / f"{sha256}_{size}.json"
            if cache_path.exists():
                with open(cache_path, "r", encoding="utf-8") as f:
                    result = json.load(f)
                    result = json.dumps(result, ensure_ascii=False, cls=NumpyEncoder)
                print("Cache hit")
            else:
                result = ocr.ocr(image_bytes)
                result = json.dumps(result, ensure_ascii=False, cls=NumpyEncoder)
                if not self.cache_location.exists():
                    self.cache_location.mkdir()
                with open(cache_path, "w", encoding="utf-8") as f:
                    f.write(result)
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(result.encode("utf-8"))
        except InvalidImage:
            self.send_error(400, "Invalid image")
        except Exception as e:
            self.send_error(500, str(e))


def run_server(port=4527):
    server_address = ("", port)
    httpd = HTTPServer(server_address, OCRHandler)
    print(f"Server running on port {port}")
    httpd.serve_forever()


if __name__ == "__main__":
    run_server()
