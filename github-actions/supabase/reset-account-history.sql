-- 手動実行用。schema.sqlの初期セットアップ時には実行不要。
-- 1. cron-job.orgを停止し、Actionsの実行中・待機中ジョブがなくなるまで待つ。
-- 2. 対象アカウントのROOM投稿を削除し、削除完了を確認する。
-- 3. 下のtarget_accountをaccount1 / account2 / account3のどれかに変更し、
--    Supabase SQL Editorでこのファイル全体を実行する。その後cronを再開する。
-- このSQLはROOMの投稿を削除しない。DB内の指定アカウントの履歴のみを初期化する。
-- posted / duplicate / pending、未使用候補、次ページ・ジャンルの巡回位置を削除。
-- 他アカウント、GitHub Variablesのジャンル設定、ログインセッションは変更しない。
-- 片方の削除に失敗した場合はDO文全体がロールバックされる。
DO $reset$
DECLARE
  target_account text := 'account1'; -- 変更箇所はここだけ
  history_count bigint;
  candidate_count bigint;
BEGIN
  IF target_account IS NULL OR target_account NOT IN ('account1', 'account2', 'account3') THEN
    RAISE EXCEPTION 'target_account must be account1, account2 or account3';
  END IF;

  DELETE FROM public.room_post_history WHERE account = target_account;
  GET DIAGNOSTICS history_count = ROW_COUNT;
  DELETE FROM public.room_candidate_state WHERE account = target_account;
  GET DIAGNOSTICS candidate_count = ROW_COUNT;

  RAISE NOTICE 'Reset %: history rows=%, candidate state rows=%', target_account, history_count, candidate_count;
END
$reset$;
