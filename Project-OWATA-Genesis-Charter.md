# Project OWATA — Genesis Charter

**Status:** Genesis / Project bootstrap  
**Former working title:** SEA  
**Project type:** Autonomous AI Development Platform  
**Purpose:** Human-operated semi-automatic AI development → policy-driven autonomous multi-agent development  
**First proving ground:** Thought Flow Observatory (TFO)

---

## 0. この文書の使い方

このMarkdownを **Project OWATA の初期正本** とする。

新しいチャットやエージェントは、過去チャットの会話履歴ではなく、まずこの文書とOWATAリポジトリ内の正本を読んで現在地を復元すること。

このプロジェクトでは、モデル名・製品名そのものを設計の中心に置かない。

中心に置くのは次の論理役割である。

- **Program Control / Design Orchestration**
- **Builder**
- **Independent Reviewer**
- **Human / Reality Boundary**

現在の暫定Championは以下。

- Program Control = **ChatGPT**
- Builder = **Cursor**
- Independent Reviewer = **Codex**
- Reality / Approval = **Human**

これらは固定採用ではなく、実測に基づき交換可能とする。

---

# 1. Project OWATAとは何か

OWATAは、

> **未完成のプロジェクトを、Humanの認知コストを増やさず、完成可能な状態まで継続的に収束させる自律型開発基盤**

である。

名前は皮肉を含む。

一般的な「オワタ」は「もう終わった」という失敗側のニュアンスを持つが、Project OWATAでは逆に、

> **終わらない仕事を、本当に終わらせる**

ことを意味する。

OWATAはコード生成ツールではない。

OWATAが解決したい主要問題は、AIのコード生成能力不足ではなく次である。

1. HumanがAgent間の情報をコピー＆ペーストしている
2. Humanが工程管理・現在地把握・再開判断を担っている
3. 設計・実装・レビューの責任境界が曖昧になる
4. セッション中断後に現在地と判断理由を復元しにくい
5. Agent障害、利用上限、端末停止、外部認証待ちで仕事が孤立する
6. 高能力モデルを単純作業へ浪費し、逆に高リスク判断を弱いモデルへ渡すことがある
7. 「コードができた」と「実環境で使える」が混同される
8. 新しいAI・モデル・サブスクが増えるほどHumanの選定認知コストが増える

---

# 2. 最上位ゴール

OWATAの成功条件は、次の一文に集約する。

> **未完成の仕事が、誰にも認識されないまま止まる状態を構造的に禁止し、Humanの認知コストを増やさず完成へ収束させる。**

Humanは最終的に、

- 何を得たいか
- 何を完成とするか
- 費用・安全・期限などの制約
- 外部サービスの認証・権限
- 不可逆な最終判断

だけを担う。

下流の、

- 作業分解
- Agent選定
- モデル選定
- 実装順序
- 再試行
- レビュー
- 修正
- 状態復旧
- 証拠化

はOWATA側へ移す。

---

# 3. Before / After

## Before — Human-operated prototype

現在、TFOでは以下の分業が実際に成立している。

```text
Human
  ↓
ChatGPT
  ↓
Cursor
  ↓
Human live test
  ↓
ChatGPT judgment
  ↓
Cursor fix / evidence
  ↓
Codex independent review
  ↓
REWORK → Cursor fix → Codex re-review
  ↓
PASS
  ↓
Human merge
  ↓
ChatGPT completion decision
```

これは品質面では強い。

しかしHumanが、

- Agentを選ぶ
- プロンプトを作る
- 結果をコピーする
- 次Agentへ渡す
- 状態を覚える
- 次工程を判断する

という **Message Bus / Orchestrator** を担っている。

ここが現在の主要ボトルネックである。

## After — OWATA

```text
Human
  ↓ Goal / Constraints / Approval
OWATA Control Plane
  ↓
Work Package
  ↓
Agent Router
  ├─ Builder
  ├─ Independent Reviewer
  └─ Human Action Request
  ↓
Evidence Gate
  ↓
State / Artifact / Git
  ↓
Next Action
```

Humanの役割を、

> **Message Bus + Operator + Decision Maker**

から、

> **Goal Setter + Approver + Exception Handler**

へ変える。

---

# 4. 実績から確認された4つの役割

## 4.1 ChatGPT — Program Control

一言:

> **次を決める**

TFOで実際に行ったこと:

- 現在地の整理
- 次に行う作業の決定
- 1タスクの境界設定
- Cursor / Codex / Humanへの仕事配分
- Work Package生成
- 目的・制約・禁止事項・完了条件の定義
- HumanやCursorから返った結果の解釈
- 成功 / 未完了 / 再作業の判定
- 障害発生時の方針決定
- Reviewer指摘の裁定
- スコープ管理
- 完了条件管理
- 次Milestoneへの遷移判断

弱点:

- 広く見えるためスコープを広げすぎる可能性
- 自ら設計した案に対する完全な独立性はない
- 大量の局所実装を専任させる必要はない

---

## 4.2 Cursor — Builder

一言:

> **作る**

TFOで実際に行ったこと:

- Repository調査
- 既存構造・依存・テスト・規約への適応
- 実装
- Unit / regression test
- CLI / config / API integration
- エラー処理
- 実測結果を受けた修正
- Reviewer findingへの限定修正
- 証拠・Decision・文書化
- branch / rebase / commit / push / PR
- Human向け実環境操作手順作成

強み:

- 既存repoへの適応
- 局所変更
- 実装量
- テスト
- Git作業
- 指示された境界内での具体化

弱点:

- 自己レビューには構造的バイアスがある
- 上流の意味論そのものを疑う役には向かない
- 設計・ルールを過剰に詰めると処理が重くなりやすい

---

## 4.3 Codex — Independent Reviewer

一言:

> **本当に正しいか疑う**

TFOで実際に行ったこと:

- Builder実装を前提として信用しない独立レビュー
- 仕様・契約・意味論の矛盾検出
- Evidence / provenance確認
- Security review
- Least privilege review
- Overclaim検出
- Focused re-review
- PASS / REWORK / BLOCK判定
- Merge readiness判定

実績上、特に価値が高かった例:

- success / missing の意味破壊
- unknown cost = 0.0
- Retry-Afterの不正短縮
- source total / denominatorの意味違い
- run provenance不足
- failure pathでの情報漏えい

弱点:

- 深掘りによって隣接問題へ発散する場合がある
- 大量の実装を主担当させる必要はない
- Reviewerとして使う場合はBuilderの会話履歴を与えない

---

## 4.4 Human — Reality / Approval Boundary

一言:

> **現実世界で成立させる**

実際に行ったこと:

- 外部サービスの認証・権限設定
- 管理画面操作
- 実アカウントでのlive test
- 現実環境固有エラーの取得
- UI・外部サービス状態の確認
- 最終成功確認
- 高リスクmerge
- 不可逆判断

Humanへ戻す条件を限定する。

- 得られる成果そのものが変わる
- 費用上限を超える
- 外部公開・削除・課金・法務に関係する
- 不可逆操作
- 研究・業務上の意味が異なる選択
- 上流要求の矛盾
- Agent自身では取得できない認証・権限

---

# 5. OWATAの中核思想

## 5.1 Role-based

製品名ではなく役割で設計する。

```text
Program Control
Builder
Independent Reviewer
Human Boundary
```

## 5.2 Provider / Model Agnostic

ChatGPT、Codex、Cursor、Claude、Gemini等は交換可能なProviderとする。

中核状態機械へ製品名を直接埋め込まない。

## 5.3 Independent Verification

BuilderとReviewerを分離する。

Reviewer不可用時にBuilder自己承認へ縮退しない。

## 5.4 Evidence-driven

AIの「完了しました」は完了証拠にしない。

判定根拠:

- diff
- test
- build
- CLI result
- provenance
- security scan
- independent review
- real-world validation

## 5.5 Git-centered

コードと主要な成果物の正式な受け渡しはGitを中心に行う。

チャット履歴を正式な証拠にしない。

## 5.6 Durable State

正本をチャット外へ置く。

中断、quota切れ、PC再起動、Provider停止後も再開可能とする。

## 5.7 Failure is State, not Terminal

回復可能な失敗を単純なFAILEDで放置しない。

- retry
- stronger model
- another provider
- work split
- redesign
- waiting external
- human escalation

のいずれかへ遷移させる。

## 5.8 Human Cognitive Cost is a First-class Metric

内部の複雑性をHumanへ常時処理させない。

Humanが通常知るべきものは、

- 目的
- 現在利用可能なもの
- 自動作業中の内容
- 残作業
- Human対応要否
- 再開条件
- 最終進展

程度に限定する。

---

# 6. 「AIを理解する活動」もOWATA開発の一部

Project OWATAには2本のR&D軸がある。

## Axis A — 思考 / AI Engineering Knowledge

各Agentへの解像度を上げる。

目的:

- 得意なTask Type
- 苦手なTask Type
- Failure mode
- Human intervention量
- 推論特性
- コスト
- 速度
- quota耐久性

を経験として蓄積する。

これは単なるAI比較ではない。

将来の **Capability Map / Routing Policy** を作るための教師データである。

## Axis B — 実働 / Platform Automation

現在Humanが担当している、

- handoff
- routing
- state management
- retry
- evidence transfer
- review loop

をPlatformへ実装する。

両者は次の循環を形成する。

```text
Use Agents
  ↓
Learn
  ↓
Capability Map
  ↓
Encode Policy
  ↓
Automate
  ↓
Observe Telemetry
  ↓
Learn Again
```

---

# 7. Agent選定の基本ルール

現在の暫定Champion:

| Logical Role | Champion |
|---|---|
| Program Control | ChatGPT |
| Builder | Cursor |
| Independent Reviewer | Codex |

ただし固定しない。

新しいAgentは常駐追加せず、**Champion / Challenger方式**で評価する。

例:

```text
Builder:
Cursor (Champion)
vs
Claude Code (Challenger)
```

または、

```text
Reviewer:
Codex (Champion)
vs
Claude (Challenger)
```

同時に多数のAgent・Modelを比較しない。

## 評価順序

1. Roleを固定
2. 現Championを計測
3. Challengerを1つだけ投入
4. 実案件で比較
5. 明確に勝った場合のみ交代
6. 最後にSubscription / API / On-demandを最適化

---

# 8. モデル・サブスク設計思想

高額プランを先に固定しない。

次の順で判断する。

```text
Role
  ↓
Best Agent / Provider
  ↓
Normal Monthly Demand
  ↓
Subscription vs On-demand
```

2026年8月の特殊利用量は平常需要とはみなさない。

翌月以降の通常生活・通常開発量から改めて測定する。

測るべきものはToken総量だけではない。

- work package完遂率
- Human介入量
- Reviewer重大Finding数
- retry回数
- latency
- quota停止回数
- 完成案件あたり費用
- Human作業時間

を重視する。

---

# 9. OWATA論理アーキテクチャ

```text
┌─────────────────────────────────┐
│ HUMAN / EXTERNAL WORLD          │
│ Goal / Approval / Credentials   │
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│ CONTROL PLANE                   │
│ Program Controller              │
│ Work Package Generator          │
│ Agent Router                    │
│ Policy Store                    │
└────────────────┬────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌───────────────┐  ┌──────────────────┐
│ BUILDER       │  │ INDEPENDENT      │
│ EXECUTION     │  │ REVIEWER         │
└───────┬───────┘  └─────────┬────────┘
        │                    │
        └─────────┬──────────┘
                  ▼
┌─────────────────────────────────┐
│ VERIFICATION PLANE              │
│ Tests / Security / Evidence     │
│ PASS / REWORK / BLOCK           │
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│ STATE / ARTIFACT PLANE          │
│ Git / Durable State / Artifacts │
│ Telemetry / Capability Map      │
└─────────────────────────────────┘
```

主要コンポーネント:

1. Human Interface
2. Intent / Work Package Generator
3. Platform Orchestrator
4. Durable Queue / State
5. Agent / Model Router
6. Provider Adapters
7. Builder
8. Independent Reviewer
9. Git Evidence Broker
10. Verification / Evidence Gate
11. External Integration Broker
12. Telemetry / Capability Map
13. Policy Store

---

# 10. 正式handoffの考え方

Agent間の正式な受け渡しではHumanのコピペをなくす。

## Builder → Reviewer

正式に渡すもの:

- Repository
- Commit SHA
- PR
- Work Package
- Acceptance Criteria
- Diff
- Tests
- Evidence
- Known Risks

渡さないもの:

- Builderとの会話履歴
- Builderの自己評価
- 説得的な説明文

Reviewerは成果物を独立して検証する。

## Reviewer → Builder

Reviewerはコードを直接修正しない。

出力:

```text
PASS
REWORK
BLOCK
```

＋

- Finding
- Severity
- Evidence
- Required correction boundary

ChatGPT / Program ControllerがFindingを裁定し、修正Work Packageへ変換する。

---

# 11. 最初の自動化対象

最初にAIを賢くする必要はない。

最初に消すべきものは、

> **Human Clipboard**

である。

現状:

```text
ChatGPT
↓
Human copy/paste
↓
Cursor
↓
Human copy/paste
↓
Codex
↓
Human copy/paste
↓
ChatGPT
```

最初の目標:

```text
Agent Result
↓
Structured Handoff
↓
Persistent State
↓
Next Agent
```

OWATA v0.1は、全自動開発を完成させるものではなく、

> **HumanがAgent間handoffを担当しなくても1つのWork PackageがBuild → Review → Rework/Passまで循環する**

ことを狙う。

---

# 12. 初期技術方針

初期版は複雑にしない。

- Control application: TypeScript / Node.js
- State: SQLite WAL
- Event log: append-only JSONL + SQLite
- Source of Truth: Git / GitHub
- Queue: SQLite transaction + lease
- Human UI: local Web UI
- Provider integration: Adapter
- External SaaS: Official API first
- Initial control node: local machine
- Secret: Git / chatへ保存しない

初期版では導入しない:

- Kubernetes
- 外部message broker
- 複雑なmicroservices
- cloud mandatory architecture
- モデル名ベタ書きrouting
- Human向け詳細工程管理UI

---

# 13. 最初の構築順序

## Phase 1 — Control Core

- project state
- work state
- SQLite
- event log
- queue
- state transition
- orphan detection

成功条件:

> プロセスを強制終了しても同じ地点から再開できる。

## Phase 2 — Single Worker Completion Loop

- work execution
- result capture
- test
- automatic repair
- completion decision

成功条件:

> 小規模サンプルをHuman途中介入なしで完成候補まで運ぶ。

## Phase 3 — Role / Provider Separation

- Program Control Adapter
- Builder Adapter
- Reviewer Adapter
- Git Evidence Broker
- normalized Work Package
- normalized Review Result

成功条件:

> BuilderとReviewerが正式成果物のみで分離され、REWORKが自動でBuilderへ戻る。

## Phase 4 — Router

- provider registry
- capability profile
- availability
- quota
- cost
- automatic escalation
- failover

## Phase 5 — Reliability

- watchdog
- lease recovery
- backup / restore
- fault injection

## Phase 6 — External Integration

- credentials
- mocks
- contract test
- human action request
- resume after authentication

## Phase 7 — TFO Canary

TFOはOWATAとは別プロジェクト。

OWATAの最初の実証案件として使用する。

---

# 14. 最初のアクション — Genesis Work Package

## WP-000 — OWATA Namespace & Bootstrap

### Goal

Project OWATAの入口を実体化し、SEAという仮称から正式な開発対象へ移行する。

### Scope

1. Project nameを `OWATA` に固定
2. CLI commandを `owata` とする
3. GitHub repository名候補を確認し確保
4. npm package namespace `owata` の利用可否を正確に確認
5. 最小CLIを作る
6. READMEに目的を1文で固定
7. Genesis tagを作る

### Initial CLI

```bash
owata --version
owata doctor
owata status
```

例:

```text
$ owata --version
owata 0.0.1-genesis

$ owata doctor
[PASS] Runtime
[PASS] Git
[PASS] State directory
OWATA is ready.

$ owata status
Project: OWATA
State: Genesis
Next: Bootstrap control core
```

### README first sentence

> **OWATA is an autonomous development platform that gets unfinished projects to done.**

### Non-goals

WP-000では以下を作らない。

- Model Router
- Codex integration
- Cursor integration
- Claude integration
- Autonomous review loop
- Web dashboard
- Cloud infrastructure

まず名前・repo・CLI・最低限の起動面だけを固定する。

### Definition of Done

- `owata --version` が実行できる
- `owata doctor` が実行できる
- `owata status` がGenesis状態を返す
- repositoryが存在する
- READMEが存在する
- Genesis commit / tagが存在する
- 次のWork PackageがControl Core構築として明示されている

---

# 15. Genesis Agent Protocol

Project OWATAの初期手動運用では、以下だけ覚える。

## ChatGPT

依頼:

> **次のWork Packageを定義して。**

ChatGPTは実装者ではなく、現在地・依存・リスクを見て次の仕事を切り出す。

## Cursor

依頼:

> **このWork Packageを実装して。**

Cursorはrepo調査、実装、test、Git成果物まで閉じる。

上流要求を勝手に変更しない。

## Codex

依頼:

> **この成果物を独立審査して。**

CodexはBuilderの会話を信用せず、Git Evidence Packageだけを基礎に、

```text
PASS / REWORK / BLOCK
```

を返す。

コードは変更しない。

## Human

Humanは、

- Goal
- external credentials
- live environment
- irreversible operation
- approval

だけを担当する方向へ縮退させる。

---

# 16. Project OWATA Genesisへの指示

このプロジェクトを引き継ぐAIは以下を守ること。

1. **この文書とRepositoryの正本を優先し、古い会話履歴を正本にしない**
2. Humanへ内部工程の管理を要求しない
3. 次の作業は原則1つのWork Packageとして提示する
4. 実装はBuilderへ渡す
5. 独立審査はBuilderとは別主体へ渡す
6. ReviewerのFindingはProgram Controlが裁定する
7. Failureを孤立状態にしない
8. 高額モデル・サブスクを先回りで固定しない
9. Agentの実測結果をCapability Mapへ蓄積する
10. AgentやModelの比較自体を目的化しない
11. 新AgentはChampion / Challenger方式で1つずつ評価する
12. Humanの認知コスト削減を品質・速度と同等の設計指標として扱う
13. OWATA自身の実装を過剰設計しない
14. 最初の課題はHuman Clipboardの削減である
15. 「コードが存在する」ではなく「完成条件を満たす」で完了判定する

---

# 17. 最終ビジョン

Project OWATAの最終形は、

> ChatGPT + Cursor + Codexを固定的に連携するツール

ではない。

目指すものは、

> **Role-based, Provider-agnostic, Evidence-driven Autonomous Development Platform**

である。

将来、

```text
Program Control = Provider A
Builder = Provider B
Reviewer = Provider C
```

が変わってもOWATA本体は変わらない。

OWATA自身が、

- Task type
- Risk
- Capability
- Cost
- Availability
- Quota
- Historical success
- Independent review requirement

を見て、適切なAgent / Model / Transportを選択する。

Humanは、

> **何を完成させたいか**

を決める。

OWATAは、

> **どう終わらせるか**

を引き受ける。

---

# 18. Genesis Statement

> **OWATA exists to finish what AI starts.**

現在はHuman-operated prototypeである。

最初の仕事は、Humanが担っているhandoffを1つずつ消すこと。

その実測からAgent理解を深め、その知識をRouting Policyへ変換し、
最終的にHumanの認知負荷を増やさず、複数Agentが自律的にプロジェクトを完遂する基盤へ進化させる。
