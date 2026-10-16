const labels = { success: '成功', warning: '警告あり', failure: '失敗' };

function assessRun(mode, results) {
  const accounts = results.map(result => ({
    ...result,
    status: result.ok ? 'success'
      : mode === 'run' && (result.posted > 0 || (!result.error && result.stage === 'partial')) ? 'warning'
        : 'failure',
  }));
  const posted = accounts.reduce((count, result) => count + result.posted, 0);
  const hasIssues = accounts.some(result => result.status !== 'success');
  // Keep per-account failures visible even when another account posted.
  // Diagnostics must still fail if any requested check was unsuccessful.
  const status = !accounts.length ? 'failure' : !hasIssues ? 'success'
    : mode === 'run' && (posted > 0 || accounts.every(result => result.status !== 'failure')) ? 'warning'
      : 'failure';
  return { status, exitCode: status === 'failure' ? 1 : 0, posted, results: accounts };
}

function renderSummary(summary) {
  const rows = summary.results.map(r => `| ${r.account} | ${labels[r.status]} | ${r.stage} | ${r.posted} | ${r.skipped} | ${r.itemErrors || 0} | ${r.historySkipped || 0} | ${r.rankingPages || 0} | ${r.deferred || 0} | ${r.followAttempts} / ${r.followConfirmed ?? "—"} (${r.followStop || "legacy"}) | ${r.likeAttempts} / ${r.likeConfirmed ?? "—"} (${r.likeStop || "legacy"}) | ${[r.operation, r.error, ...r.warnings].filter(Boolean).join(' / ')} |`);
  return `\nモード: ${summary.mode} / 所要時間: ${summary.elapsedSeconds}秒\n\n全体: ${labels[summary.status]}（ジョブ${summary.exitCode ? '失敗' : '成功'}） / 投稿確認合計: ${summary.posted}件\n\n| Account | 結果 | 段階 | 投稿確認 | コレ済み | 商品エラー除外 | 履歴除外 | API取得ページ | 履歴競合 | フォロー 操作/確認(終了理由) | いいね 操作/確認(終了理由) | エラー・警告 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

module.exports = { assessRun, renderSummary };
