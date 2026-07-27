# IONQ Watchdesk

IonQ、量子業界、米国株に影響する重要経済ニュースを収集し、日本語表示とDiscord通知を行う個人用Watchdeskです。

## 運用

- Netlify Scheduled Function: 1時間ごと (`0 * * * *`)
- 速報: 今日見落とすと困るIonQ材料、重大な量子業界の変化、市場ショック（即時通知）
- 投稿候補: 具体的な事実・明確な投稿角度・今投稿する理由がそろう直近24時間の上位5件（朝夜まとめ）
- 保管: 既報、プレビュー、解説、株価予想、薄い言及、候補上位5件外（通知なし）
- Discordは5件単位の複数便で全件送信

## 主な収集元

- IonQ公式ニュースページ（Google Newsで補完）
- SEC EDGAR、Nasdaq銘柄RSS
- Federal Reserve、BLS、BEA公式RSS
- Google News、量子専門媒体RSS

## 環境変数

- `DISCORD_WEBHOOK_URL`: Discord通知先
- `SEC_USER_AGENT`: SEC向け連絡先入りUser-Agent
- `OPENAI_API_KEY`: 記事レポートおよび任意の重要度補正
- `REPORT_SECRET`: レポートAPI認証
- `REPORT_MODEL`: レポート生成モデル
- `PRIORITY_AI_MODEL`: 重要度補正モデル（未設定時は`REPORT_MODEL`を利用）
- `AI_PRIORITY_ENABLED=false`: AI重要度補正を明示的に無効化
- `WATCH_LOOKBACK_MINUTES`: 新着通知の対象時間（既定360分）

AI重要度補正はAPIキーがある場合のみ、新着記事を最大8件まとめて「投稿枠を使う価値」で評価します。AIはルール判定による速報候補も格下げできます。結果はBlobへ保存し、同じ記事を再評価しません。失敗時はルール判定へ自動的に戻ります。

## 確認

```bash
npm run check
npm test
```
