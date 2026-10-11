#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 bert_alerts CSV 安全同步到线上 Supabase tasks 表。

默认会先备份线上 bert_alerts，再逐行 PATCH（不会插入或覆盖其他字段）。
密钥未放入命令行或环境变量时，会以隐藏输入方式询问。
"""
from __future__ import annotations

import argparse
import csv
import getpass
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_URL = "https://srbaqffmprctgiadklzc.supabase.co"


def request_json(url: str, key: str, method: str = "GET", body=None, extra_headers=None):
    headers = {
        "apikey": key,
        "Accept": "application/json",
    }
    # 旧 service_role 是 JWT；新版 sb_secret_* 仅作为 apikey 使用。
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {key}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    else:
        data = None
    if extra_headers:
        headers.update(extra_headers)
    req = Request(url, data=data, headers=headers, method=method)
    last_error = None
    for attempt in range(6):
        try:
            with urlopen(req, timeout=45) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            # 权限/参数错误重试无益；限流或服务端错误可以重试。
            retryable_http = {301, 302, 307, 308, 408, 429}
            if exc.code < 500 and exc.code not in retryable_http:
                raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
            last_error = RuntimeError(f"HTTP {exc.code}: {detail}")
        except Exception as exc:
            last_error = exc
        if attempt < 5:
            time.sleep(min(0.5 * (2 ** attempt), 8.0))
    raise RuntimeError(f"请求重试 6 次仍失败：{last_error}") from last_error


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="同步 BERT alerts 到 Supabase")
    parser.add_argument("--input", type=Path, default=project / "supabase/bert_alerts_new.csv")
    parser.add_argument("--url", default=os.getenv("SUPABASE_URL", DEFAULT_URL))
    parser.add_argument("--workers", type=int, default=1, help="并发数；默认 1 以避免 macOS TLS 并发错误")
    parser.add_argument("--yes", action="store_true", help="跳过确认（不建议交互运行时使用）")
    args = parser.parse_args()

    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        key = getpass.getpass("粘贴 Supabase service_role/secret key（输入不会显示）：").strip()
    if not key:
        parser.error("未提供 Supabase service role key")
    if key.startswith("sb_publishable_"):
        parser.error("publishable key 没有写入权限；请使用 sb_secret_* 或旧 service_role key")

    with args.input.open(encoding="utf-8-sig", newline="") as f:
        source = list(csv.DictReader(f))
    updates = {}
    for row in source:
        sample_id = int(row["sample_id"])
        alerts = json.loads(row["bert_alerts"])
        if not isinstance(alerts, list):
            raise ValueError(f"sample_id={sample_id} 的 bert_alerts 不是数组")
        updates[sample_id] = alerts
    if len(updates) != len(source):
        raise ValueError("输入中存在重复 sample_id")

    endpoint = args.url.rstrip("/") + "/rest/v1/tasks"
    query = urlencode({"select": "sample_id,bert_alerts", "order": "sample_id.asc"})
    live = request_json(f"{endpoint}?{query}", key) or []
    live_by_id = {int(row["sample_id"]): row.get("bert_alerts") or [] for row in live}
    missing = sorted(set(updates) - set(live_by_id))
    if len(missing) == len(updates):
        raise RuntimeError("无法读取任何 tasks；很可能使用了 publishable/anon key，请改用 secret/service_role key")
    if missing:
        raise RuntimeError(f"线上缺少 {len(missing)} 个 sample_id，已中止：{missing[:20]}")
    pending = {sample_id: alerts for sample_id, alerts in updates.items() if live_by_id[sample_id] != alerts}

    backup_dir = project / "supabase/backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f"bert_alerts_before_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    with backup.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["sample_id", "bert_alerts"], lineterminator="\n")
        writer.writeheader()
        for row in live:
            writer.writerow({
                "sample_id": row["sample_id"],
                "bert_alerts": json.dumps(row.get("bert_alerts") or [], ensure_ascii=False, separators=(",", ":")),
            })
    print(f"线上备份：{backup}")
    print(f"已是最新：{len(updates) - len(pending)} 页；仍需更新：{len(pending)} 页。")
    if not pending:
        print(f"线上数据已经全部同步：{len(updates)} 页。")
        return
    print(f"待写入疑错标记共 {sum(map(len, pending.values()))} 个。")
    if not args.yes:
        answer = input(f"请输入 UPDATE {len(pending)} 继续：").strip()
        if answer != f"UPDATE {len(pending)}":
            print("已取消，线上数据未修改。")
            return

    def patch(item):
        sample_id, alerts = item
        url = f"{endpoint}?{urlencode({'sample_id': f'eq.{sample_id}'})}"
        request_json(
            url,
            key,
            method="PATCH",
            body={"bert_alerts": alerts},
            extra_headers={"Prefer": "return=minimal"},
        )
        return sample_id

    failures = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(patch, item): item[0] for item in pending.items()}
        for future in as_completed(futures):
            sample_id = futures[future]
            try:
                future.result()
            except Exception as exc:
                failures.append((sample_id, str(exc)))
            done += 1
            if done % 50 == 0 or done == len(pending):
                print(f"进度：{done}/{len(pending)}", flush=True)

    if failures:
        print(f"失败 {len(failures)} 页；可用备份恢复。", file=sys.stderr)
        for sample_id, message in failures[:20]:
            print(f"  {sample_id}: {message}", file=sys.stderr)
        raise SystemExit(1)

    # 回读核验，不输出任何密钥。
    verified = request_json(f"{endpoint}?{query}", key)
    got = {int(row["sample_id"]): row.get("bert_alerts") or [] for row in verified}
    mismatches = [sample_id for sample_id, alerts in updates.items() if got.get(sample_id) != alerts]
    if mismatches:
        raise RuntimeError(f"回读核验失败 {len(mismatches)} 页：{mismatches[:20]}")
    print(f"同步成功并通过回读核验：{len(updates)} 页。")


if __name__ == "__main__":
    main()
