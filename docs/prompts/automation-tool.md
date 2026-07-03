# 業務自動化ツール量産テンプレ(OSS工場用)

【目的】毎週＿＿時間かかっている「＿＿＿」という手作業を自動化し、OSSとして公開したい
【工程】
1. researcherに対象サービス(＿＿＿)のAPI仕様・認証方式・利用規約を調査させ docs/research.md に保存
2. 調査結果をもとにcoderがCLIツールを実装(npx一発実行 / .env設定 / --dry-run必須)
3. reviewerが「READMEの手順どおりに導入して動くか」の観点で検証
4. writerがREADME(日本語+英語サマリ)を作成
【完了条件】dry-runでの動作確認まで完了し、公開前チェックリスト(docs/OSS_STRATEGY.md §4)との照合結果を報告
【制約】LLMを使う処理はBYOK設計(利用者のANTHROPIC_API_KEY)にする。公開判断は私がやるのでpublishはしない
