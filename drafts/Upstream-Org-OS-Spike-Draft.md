# 上流組織 OS スパイク — 草案（叩き台）

**Status:** DRAFT / 叩き台  
**Axis:** OWATA 本体とは別軸（統合しない）  
**Horizon:** M365 ビジネスプラン無料枠を利用（〜2026-09-20 目安）  
**Purpose:** 組織向け Microsoft スタックを、複数エージェントで跨いだときの機能検証

---

## 0. この文書の位置づけ

これは **OWATA Genesis Charter の一部ではない**。

- OWATA の WP / DEC / evidence を変更しない
- Control Core / Model Router / ハンドオフ実装に接続しない
- 「統合」ではなく **別軸の機能検証スパイク**

新しいチャットやエージェントは、OWATA 正本とこの草案を混同しないこと。

---

## 1. 三段モデル（暫定正本）

| 層 | 問い | 役割 | 正本の置き場（仮説） |
|---|---|---|---|
| **TFO** | **何を**回すか | 対象・意図・完成定義 | Thought Flow Observatory（プロダクト／観測対象） |
| **M365 軸** | **どう**回すか | 役割・承認・手配・組織上の現在地 | Entra / Graph / Dataverse or Boards / Teams・メール |
| **OWATA** | **実際に**回す | 実装・検証・再開・証拠で完成へ収束 | Git / Control Core / WP / evidence |

### 差別化の一言

- **TFO** = 何をやるか（対象）
- **M365 軸** = 組織としてどう回すか（上流オペ）
- **OWATA** = 未完成の仕事を実際に完了させる（下流エンジン）

「どう回すか」を M365 と OWATA で奪い合わない。

- M365 = **組織の回し方**（誰に振るか、承認、依頼の流れ）
- OWATA = **仕事の回し方**（claim、build、review、failover、完成収束）

---

## 2. コア技術仮説

コアは個別 SaaS 機能ではなく、**組織の OS** である。

1. **Identity** — Entra ID（誰がどの役割で動けるか）
2. **Nervous system** — Microsoft Graph / 通知・イベント
3. **State** — Dataverse または DevOps Boards / Lists（仕事の現在地）
4. **Execution** — Agents / Power Automate / Pipelines（手足）

M365・Azure DevOps・Dataverse・Azure はアプリ群。  
検証の本丸は次の一文に集約する。

> 複数エージェントが同じ組織身分モデルの上で、止まらずに仕事を引き継げるか。

---

## 3. 成功条件（スパイク）

最小成功は次で足りる。

1. 依頼が組織チャネル（Teams / メール等）で投入される
2. 役割（Program Control / Builder / Reviewer / Human）に振り分けられる
3. 作業の現在地がチャット履歴以外の正本に残る
4. Human Gate（承認）だけ人が担う
5. 中断後に「今どこで、次は誰か」を正本から復元できる

**やらないこと（このスパイク）**

- OWATA リポジトリへの自動配線
- Model Router / Control Core との統合
- 本番課金・本番顧客データの投入
- 全 M365 サービス総当たり

---

## 4. 最小構成案（9/20 まで）

優先度順。上から足す。

### P0 — 必須

- Entra ID 上の役割（最低 4: PC / Builder / Reviewer / Human）
- 依頼投入口（Teams チャネル or 共有メール のどちらか一方）
- 現在地の正本（**どちらか一方**）
  - 軽量: DevOps Boards / SharePoint Lists
  - 本格: Dataverse
- 承認 1 経路（Teams 承認 or Outlook）

### P1 — あると検証が深い

- Azure DevOps Repos + Pipeline（「開発プロセスとしての回し方」）
- Graph 経由の機械可読イベント
- エージェント用アプリ登録（委任／アプリ権限の境界確認）

### P2 — 後回し

- Dataverse 本格エンティティ設計
- Copilot Studio multi-agent 本採用
- Purview / 高度な監査ダッシュボード
- 異種エージェント（Cursor 等）の本格接続

**初期推奨:** P0 を Boards/Lists で先に通し、散らばりが出てから Dataverse を検討する。

---

## 5. 擬似組織の役割（仮説）

暫定 Champion（交換可能）:

| 論理役割 | 上流（M365 軸）での仕事 | 下流（OWATA）との関係 |
|---|---|---|
| Program Control | 依頼分解、次ロール指定、現在地更新 | 接続しない（参照比較のみ可） |
| Builder | 成果物リンクを正本へ返す | OWATA Builder とは別インスタンス想定 |
| Independent Reviewer | 承認前チェック／差し戻し | 同上 |
| Human | 制約・認証・不可逆承認 | 両軸で共通の Reality Boundary |

---

## 6. 検証シナリオ（最初の 1 本）

名前: **SC-01 One Request Resume**

```text
Human が「小さい依頼」を投入
  → PC が Work Item / 行を作成
  → Builder に振り分け
  → Builder が成果リンクを記録
  → Reviewer が PASS / REWORK
  → Human が最終承認（必要な場合のみ）
  → 途中で一度プロセスを止めても、正本から Next Authority を復元できる
```

合格条件:

- チャットを読まなくても現在地が分かる
- 次ロールが曖昧にならない
- 承認待ちと作業中が混同されない

---

## 7. OWATA / TFO との関係（非統合）

```text
TFO ─────────────── 何を回すか（対象）
   │
   ▼（意図・完成定義の供給。自動統合はしない）
M365 軸 ─────────── どう回すか（組織オペ / 上流）
   │
   ▼（比較・人手ブリッジは可。API 統合はスパイク外）
OWATA ───────────── 実際に回す（完成エンジン / 下流）
```

- TFO は本スパイクの **題材候補**
- OWATA は本スパイクの **対照実験（downstream reference）**
- 同一テナント／同一 Git に同居しても、**正本と WP は分離**

---

## 8. 未決事項（要 Human）

- [ ] 現在地の正本を Boards/Lists にするか Dataverse にするか
- [ ] 依頼投入口を Teams にするか メールにするか
- [ ] テナントは新規試用か既存 M365 か
- [ ] Azure DevOps を P0 に含めるか P1 か
- [ ] スパイク用のリポジトリを OWATA 外に切るか（推奨: 外）
- [ ] 9/20 以降に残す成果物の定義（設計メモのみ / 再現手順 / 破棄）

---

## 9. 次アクション案

1. この草案の文言合意（特に三段モデルと非統合）
2. P0 の正本選択（Boards vs Dataverse）
3. SC-01 を 1 本通す
4. 学びを短く evidence 化し、OWATA 本体にはマージしない

---

## 10. 参考（既存の近い事例）

企業・公式には近い取り組みがある（Copilot Studio multi-agent、Dataverse 状態管理、Entra による Agent 身分など）。  
一方、**「TFO = 何 / M365 = どう / OWATA = 実際」を分けた上流組織 OS スパイク**としての公開実験はまだ薄い、という前提で進める。
