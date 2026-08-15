# delivery-status-api

ヤマト運輸・佐川急便・日本郵便の配送停止／制限情報を定期取得し、正規化してAPIで提供するCloudflare Workersプロジェクトです。

初期構成では Cloudflare Workers + Cron Triggers + D1 + Browser Rendering + OpenAI API を前提にしています。
