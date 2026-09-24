# Mutex Job Matrix Service

互斥作业矩阵服务：为"哪些作业类型不得并行运行"的判定矩阵提供 **草稿 → 发布 → 生效窗口 → 历史快照** 的完整版本化机制。

排定（schedule）或开工（start）决策在作出的瞬间**冻结**所适用的矩阵版本与冲突判断依据（规则快照 + 评估上下文）；此后对矩阵的任何修改只影响满足生效条件的**新决策**，绝不改写既有计划、回执或审计中的历史结论。

## 快速开始

```bash
pip install -r requirements.txt

# 运行测试（真实文件数据库集成测试）
./scripts/test.sh

# 启动服务（默认 sqlite:///./data/mutex_matrix.db）
./scripts/run.sh                 # 或 DATABASE_URL=... ./scripts/run.sh

# 导出 OpenAPI 规范
PYTHONPATH=. python3 scripts/export_openapi.py   # 生成 openapi.json
```

服务启动后访问 `http://localhost:8000/docs`（Swagger UI）或 `/openapi.json`。

## 领域模型

### 矩阵与版本

- **规则**：`{job_type_a, job_type_b, resources[], description}`。类型对按字典序规范化（无序对）；`resources` 为空表示任意时间重叠的同对类型作业都互斥，非空则仅当两作业共享所列资源时互斥。时间区间按半开 `[start, end)` 判定重叠。
- **草稿**（`matrix_drafts`）：单例可编辑工作副本，`PUT /matrix/draft` 全量替换。
- **已发布版本**（`matrix_versions`）：不可变快照，含 `version_no`、`rules`、`rules_hash`、半开生效窗口 `[effective_from, effective_to)`、`request_id`（幂等键）。最新版本 `effective_to = NULL`（开放窗口）。

### 安全迁移

启动时若版本表为空，把 `legacy_matrix_rules`（版本化之前的现存矩阵数据）整体迁移为**不可变基线 v1**：`effective_from = 0001-01-01 UTC`（纪元起点），保证任何历史决策时刻都落在 v1 窗口内 → 旧计划永远按 v1 回放。迁移幂等（唯一约束 + 冲突时跳过），遗留表保留备查。

### 发布规则

`POST /matrix/versions {effective_from, request_id?}`：

1. `effective_from` 不得早于当前时间（禁止追溯性改写历史）；
2. **重叠拒绝**：新 `effective_from` 必须严格晚于最新已发布版本的 `effective_from`，否则 `409 effective_window_overlap`（相同边界视为重叠，重复发布即被拒绝）；
3. 发布成功时把前一开放窗口关闭为 `[旧from, 新from)`；
4. **幂等**：相同 `request_id` 重试返回首次结果（HTTP 200）；同键不同载荷 → `409 idempotency_mismatch`；
5. **并发**：发布路径持写锁（SQLite `BEGIN IMMEDIATE` / 其他库 `SELECT ... FOR UPDATE`）串行化，配合 `effective_from`、`request_id`、`version_no` 唯一约束，并发发布只有一个有效结果。

### 决策与冻结

- `POST /jobs/schedule`：以**决策时刻**生效的版本评估冲突；无冲突则创建计划（`scheduled`），冲突则拒绝。决策记录（`job_decisions`）冻结：`matrix_version_no`、`matrix_rules_snapshot`、`matrix_rules_hash`、`frozen_context`（决策时刻的活动作业集合）、`conflicts`、`reason`。`request_id` 幂等；并发同键请求收敛到同一结果。
- `POST /jobs/{id}/start`：开工是**新的评估**（可能适用更新版本），每作业仅一次，不可改写。
- `POST /decisions/evaluate`：无副作用干跑（不写库）。
- `POST /decisions/{id}/replay`：**仅用冻结快照**重放判定，校验快照哈希完整性（`snapshot_intact`）并与原结论比对（`matches_original`）——重启后、后续发布后，历史冲突原因与版本快照均可复核。

### 跨生效边界选择

版本选择规则：满足 `effective_from <= t` 的最高 `effective_from` 版本（半开窗口，边界时刻归属新版本）。`GET /matrix/versions/effective?at=...` 可查询任意时刻的适用版本。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/matrix/draft` | 读取 / 全量替换草稿 |
| POST | `/matrix/versions` | 发布草稿为新版本（201；幂等重放 200） |
| GET | `/matrix/versions` | 版本列表（含窗口与哈希） |
| GET | `/matrix/versions/{no}` | 版本详情（规则快照） |
| GET | `/matrix/versions/effective?at=` | 某时刻适用版本 |
| POST | `/jobs/schedule` | 排定决策（201；幂等重放 200） |
| POST | `/jobs/{id}/start` | 开工决策（每作业一次） |
| POST | `/decisions/evaluate` | 无副作用冲突预检 |
| GET | `/decisions[?job_id=]` | 决策审计列表 |
| GET | `/decisions/{id}` | 决策详情（含冻结快照） |
| POST | `/decisions/{id}/replay` | 按冻结快照重放复核 |

错误格式统一为 `{"error": {"code", "message", "detail"}}`；`X-Actor` 请求头记录操作者。

## 测试与验收映射（28 项，全部基于真实文件数据库）

| 验收标准 | 测试 |
|---|---|
| 旧计划始终按 v1 回放 | `test_legacy_plan_always_replays_against_v1` |
| v2 发布后新计划按 v2 判定 | `test_new_plans_after_v2_use_v2` |
| 重叠生效窗口被明确拒绝 | `test_overlapping_equal_effective_from_is_rejected`、`test_effective_from_before_latest_is_rejected` |
| 同一发布请求重试幂等 | `test_publish_retry_is_idempotent`、`test_same_request_id_different_payload_rejected` |
| 并发发布只有一个有效结果 | `test_concurrent_publish_only_one_wins`、`test_concurrent_publish_same_request_id_collapses` |
| 重启后历史冲突原因与版本快照可复核 | `test_restart_preserves_snapshots_and_reasons`、`test_migration_is_idempotent_across_restarts` |
| 跨生效边界选择 | `test_effective_boundary_selection_half_open`、`test_decisions_straddling_boundary_freeze_distinct_versions` |
| 数据安全迁移 | `test_legacy_rows_migrate_into_baseline_v1` 等 |
| 快照篡改可检测 | `test_replay_flags_tampered_snapshot` |
| OpenAPI 契约 | `test_openapi_contains_all_endpoints` 等 |

## 结构

```
app/
  clock.py            # UTC 时钟抽象（测试可注入）
  models.py           # ORM：版本/草稿/计划/决策/遗留表；UTC ISO 时间戳类型
  db.py               # 引擎与会话（SQLite WAL + busy_timeout）
  errors.py           # 领域错误 → HTTP 映射
  schemas.py          # API 请求/响应模型
  api.py              # 路由
  main.py             # 应用工厂（建表 + 启动迁移）
  services/
    engine.py         # 纯函数冲突评估
    matrix.py         # 迁移、草稿、发布（锁/重叠/幂等）、版本选择
    jobs.py           # 排定/开工/预检/重放（冻结快照）
tests/                # pytest 集成测试（真实文件数据库）
scripts/              # run.sh / test.sh / export_openapi.py
openapi.json          # 导出的 OpenAPI 规范
```
