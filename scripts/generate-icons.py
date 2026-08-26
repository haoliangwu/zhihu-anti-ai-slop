#!/usr/bin/env python3
"""知乎照妖镜 — 生成扩展图标（16/48/128 PNG，纯标准库，4x 超采样抗锯齿）。

图案：深色圆角底 + 青色照妖镜（圆 + 手柄）+ 白色镜眼。
运行：python3 scripts/generate-icons.py
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')
SIZES = [16, 48, 128]
SS = 4  # 超采样倍数


def png_chunk(tag, data):
    chunk = tag + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xFFFFFFFF)


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + row for row in rows)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(png_chunk(b'IDAT', zlib.compress(raw)))
        f.write(png_chunk(b'IEND', b''))


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0:
        return math.hypot(px - ax, py - ay)
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return math.hypot(px - bx, py - by)
    t = c1 / c2
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def inside_round_rect(u, v, x0, y0, x1, y1, r):
    cx = min(max(u, x0 + r), x1 - r)
    cy = min(max(v, y0 + r), y1 - r)
    return math.hypot(u - cx, v - cy) <= r if (u < x0 + r or u > x1 - r) and (v < y0 + r or v > y1 - r) else (
        x0 <= u <= x1 and y0 <= v <= y1
    )


def pixel(u, v):
    """返回 (r, g, b, a)，u/v ∈ [0,1]。"""
    if not inside_round_rect(u, v, 0.06, 0.06, 0.94, 0.94, 0.14):
        return (0, 0, 0, 0)
    col = (31, 35, 41, 255)  # 深色底 #1f2329
    # 手柄（先画，被镜身覆盖）
    if dist_to_segment(u, v, 0.60, 0.62, 0.78, 0.80) <= 0.075:
        col = (64, 201, 255, 255)
    # 镜身
    if math.hypot(u - 0.50, v - 0.44) <= 0.27:
        col = (64, 201, 255, 255)
    # 镜眼（白）
    if math.hypot(u - 0.50, v - 0.44) <= 0.11:
        col = (255, 255, 255, 255)
    # 瞳孔
    if math.hypot(u - 0.52, v - 0.46) <= 0.05:
        col = (24, 34, 45, 255)
    return col


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) / (size * SS)
                    v = (y * SS + sy + 0.5) / (size * SS)
                    pr, pg, pb, pa = pixel(u, v)
                    r += pr
                    g += pg
                    b += pb
                    a += pa
            n = SS * SS
            row += bytes((r // n, g // n, b // n, a // n))
        rows.append(bytes(row))
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f'icon-{size}.png')
        write_png(path, size, size, render(size))
        print(f'Created {path} ({size}x{size})')


if __name__ == '__main__':
    main()
