#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为标注网站的 corrected_text 重新生成字符级 BERT 疑错标记。

输出：
  1. sample_id,bert_alerts 两列的增量 CSV（适合更新 Supabase tasks.bert_alerts）
  2. 保留输入全部列、替换 bert_alerts 后的完整 CSV

特点：
  - 使用 zhuoning/ocr-error-detector-sikubert 的 v3_base 模型
  - 阈值默认 0.8（模型 README 推荐值）
  - 长文本采用重叠窗口，选择上下文最充分窗口的字符概率
  - 输出 offset 是原 corrected_text 的 Unicode 字符偏移，与网站 Array.from(text) 一致
  - “=”按重文符在模型上下文中展开为前一个汉字，但不会把“=”本身标红
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import torch

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f]")


@dataclass
class Unit:
    char: str
    raw_offset: Optional[int]


@dataclass
class Chunk:
    sample_id: int
    start: int
    units: list[Unit]


def text_units(text: str) -> list[Unit]:
    """抽取模型输入汉字；= 在上下文中展开，但不对应可标红的原文位置。"""
    units: list[Unit] = []
    previous_cjk = ""
    for offset, char in enumerate(text):
        if CJK_RE.fullmatch(char):
            units.append(Unit(char, offset))
            previous_cjk = char
        elif char == "=" and previous_cjk:
            units.append(Unit(previous_cjk, None))
    return units


def chunk_starts(length: int, size: int, overlap: int) -> list[int]:
    if length <= size:
        return [0]
    stride = size - overlap
    starts = list(range(0, length - size + 1, stride))
    final = length - size
    if starts[-1] != final:
        starts.append(final)
    return starts


def load_model_class(model_dir: Path):
    spec = importlib.util.spec_from_file_location("ocr_detector_modeling", model_dir / "modeling.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {model_dir / 'modeling.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SikuBertMlmAwareClassifier


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    project = Path(__file__).resolve().parents[2]
    default_model = Path.home() / ".cache/modelscope/hub/models/zhuoning/ocr-error-detector-sikubert"
    parser = argparse.ArgumentParser(description="重新生成古籍标注 corrected_text 的 BERT 疑错标记")
    parser.add_argument("--input", type=Path, default=project / "1008整理.csv")
    parser.add_argument("--model-dir", type=Path, default=default_model)
    parser.add_argument("--alerts-output", type=Path, default=project / "guji-ocr-annotation/supabase/bert_alerts_new.csv")
    parser.add_argument("--scores-output", type=Path, default=project / "guji-ocr-annotation/supabase/bert_scores_new.csv")
    parser.add_argument("--full-output", type=Path, default=project / "1008整理_bert.csv")
    parser.add_argument("--threshold", type=float, default=0.8)
    parser.add_argument("--chunk-size", type=int, default=510)
    parser.add_argument("--overlap", type=int, default=128)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps", "cuda"])
    args = parser.parse_args()

    if not 0 <= args.overlap < args.chunk_size:
        parser.error("overlap 必须满足 0 <= overlap < chunk-size")
    if not args.input.exists():
        parser.error(f"输入不存在：{args.input}")
    if not (args.model_dir / "ocr_error_detector_best.pt").exists():
        parser.error(f"模型权重不存在：{args.model_dir}")

    with args.input.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    if "sample_id" not in fieldnames or "corrected_text" not in fieldnames:
        parser.error("输入 CSV 必须包含 sample_id、corrected_text")
    if "bert_alerts" not in fieldnames:
        fieldnames.append("bert_alerts")

    chunks: list[Chunk] = []
    units_by_id: dict[int, list[Unit]] = {}
    for row in rows:
        sample_id = int(row["sample_id"])
        units = text_units(row.get("corrected_text", ""))
        units_by_id[sample_id] = units
        for start in chunk_starts(len(units), args.chunk_size, args.overlap):
            chunks.append(Chunk(sample_id, start, units[start:start + args.chunk_size]))

    device = resolve_device(args.device)
    print(f"输入：{args.input}（{len(rows)} 页，{sum(len(x) for x in units_by_id.values())} 个模型字符）")
    print(f"模型：{args.model_dir}")
    print(f"设备：{device}；阈值：{args.threshold}；窗口：{args.chunk_size}/{args.overlap}；批量：{args.batch_size}")

    from transformers import BertConfig, BertTokenizerFast

    model_class = load_model_class(args.model_dir)
    config = BertConfig.from_pretrained(args.model_dir)
    model = model_class(config)
    state_dict = torch.load(args.model_dir / "ocr_error_detector_best.pt", map_location=device)
    model.load_state_dict(state_dict)
    model.to(device).eval()
    tokenizer = BertTokenizerFast.from_pretrained(args.model_dir)

    # sample_id -> unit index -> (context_margin, error_probability)
    best: dict[int, dict[int, tuple[int, float]]] = {sample_id: {} for sample_id in units_by_id}
    started = time.time()
    for batch_start in range(0, len(chunks), args.batch_size):
        batch = chunks[batch_start:batch_start + args.batch_size]
        texts = [list("".join(unit.char for unit in chunk.units)) for chunk in batch]
        enc = tokenizer(
            texts,
            is_split_into_words=True,
            add_special_tokens=True,
            truncation=True,
            max_length=args.chunk_size + 2,
            padding=True,
            return_tensors="pt",
        )
        input_ids = enc["input_ids"].to(device)
        attention_mask = enc["attention_mask"].to(device)
        with torch.inference_mode():
            logits = model(input_ids, attention_mask)
            probabilities = torch.softmax(logits.float(), dim=-1)[:, :, 1].cpu()

        for row_idx, chunk in enumerate(batch):
            valid_len = int(enc["attention_mask"][row_idx].sum())
            inner = probabilities[row_idx, 1:valid_len - 1].tolist()
            if len(inner) != len(chunk.units):
                raise RuntimeError(
                    f"token/字符未一一对应：sample={chunk.sample_id}, token={len(inner)}, char={len(chunk.units)}"
                )
            for local_idx, probability in enumerate(inner):
                global_idx = chunk.start + local_idx
                margin = min(local_idx, len(chunk.units) - 1 - local_idx)
                previous = best[chunk.sample_id].get(global_idx)
                if previous is None or margin > previous[0]:
                    best[chunk.sample_id][global_idx] = (margin, float(probability))

        done = min(batch_start + len(batch), len(chunks))
        if done == len(chunks) or done % 40 == 0:
            elapsed = time.time() - started
            print(f"进度 {done}/{len(chunks)}（{done / len(chunks):.1%}），{elapsed:.1f}s", flush=True)

    alerts_by_id: dict[int, list[dict]] = {}
    for sample_id, units in units_by_id.items():
        alerts = []
        for unit_idx, unit in enumerate(units):
            probability = best[sample_id].get(unit_idx, (0, 0.0))[1]
            if unit.raw_offset is not None and probability >= args.threshold:
                alerts.append({
                    "offset": unit.raw_offset,
                    "char": unit.char,
                    "error_prob": round(probability, 4),
                })
        alerts_by_id[sample_id] = alerts

    args.alerts_output.parent.mkdir(parents=True, exist_ok=True)
    with args.alerts_output.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["sample_id", "bert_alerts"], lineterminator="\n")
        writer.writeheader()
        for row in rows:
            sample_id = int(row["sample_id"])
            writer.writerow({
                "sample_id": sample_id,
                "bert_alerts": json.dumps(alerts_by_id[sample_id], ensure_ascii=False, separators=(",", ":")),
            })

    # 与历史 eval_bert_reward_batch.py 相同的 reference-free BERT reward，另存逐页结果。
    args.scores_output.parent.mkdir(parents=True, exist_ok=True)
    score_rows = []
    row_by_id = {int(row["sample_id"]): row for row in rows}
    for sample_id, units in units_by_id.items():
        actual = [
            best[sample_id][idx][1]
            for idx, unit in enumerate(units)
            if unit.raw_offset is not None and idx in best[sample_id]
        ]
        if len(actual) < 5:
            mean_prob, hi_rate, reward = 0.0, 0.0, 0.2
        else:
            mean_prob = sum(actual) / len(actual)
            hi_rate = sum(prob >= 0.95 for prob in actual) / len(actual)
            reward = max(0.05, 1.0 - hi_rate * 4.0 - mean_prob * 1.5)
        score_rows.append({
            "sample_id": sample_id,
            "batch": row_by_id[sample_id].get("batch", ""),
            "hanzi_count": len(actual),
            "alert_count": len(alerts_by_id[sample_id]),
            "mean_error_prob": round(mean_prob, 6),
            "high_error_rate_ge_0.95": round(hi_rate, 6),
            "bert_reward": round(reward, 6),
        })
    with args.scores_output.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(score_rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(score_rows)

    args.full_output.parent.mkdir(parents=True, exist_ok=True)
    with args.full_output.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            sample_id = int(row["sample_id"])
            row["bert_alerts"] = json.dumps(alerts_by_id[sample_id], ensure_ascii=False)
            writer.writerow(row)

    page_count = sum(bool(v) for v in alerts_by_id.values())
    alert_count = sum(len(v) for v in alerts_by_id.values())
    avg_reward = sum(row["bert_reward"] for row in score_rows) / len(score_rows)
    print(f"完成：{alert_count} 个疑错字符，分布于 {page_count}/{len(rows)} 页")
    print(f"平均 BERT reward：{avg_reward:.4f}")
    print(f"增量 CSV：{args.alerts_output}")
    print(f"逐页分数：{args.scores_output}")
    print(f"完整 CSV：{args.full_output}")


if __name__ == "__main__":
    main()
