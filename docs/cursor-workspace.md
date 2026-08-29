# Cursor Workspace — OWATA 識別設定

OWATA は **紫** で固定する（TFO=青 と見た瞬間に区別）。

テンプレの正本は `C:\apps\cursor-workspace`。色定義・適用手順の詳細はそちらの README を見る。

## このリポジトリの識別

| 項目 | 値 |
| --- | --- |
| Profile | `OWATA` |
| Workspace ファイル | `OWATA.code-workspace` |
| タイトル | `OWATA — ${rootName}` |
| Active | `#5B2A86` |
| Inactive | `#3B1C57` |
| Activity Bar | `#432064` |

## 再適用

```powershell
cd C:\apps\cursor-workspace
.\apply.ps1 -Profile OWATA -Target "C:\Users\seq\apps\Owata"
```

色は `OWATA.code-workspace` と `.vscode/settings.json` の二重書き。どちらか一方だけだと、開き方や Cursor の書き換えで色が消える。

## 開き方（要点）

1. **File → Open Workspace from File…** で `OWATA.code-workspace`
2. User Settings に一度だけ `"window.titleBarStyle": "custom"`
3. Explorer は `Ctrl+B` で閉じた状態を推奨

## 4色規約（キット側）

| Profile | 色 |
| --- | --- |
| TFO | 青 |
| OWATA | 紫 |
| WORK | 緑 |
| DEV | 琥珀 |
