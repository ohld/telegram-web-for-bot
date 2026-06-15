export default function buildStatoscopeComment(data) {
  return [
    '## Statoscope report',
    '',
    `[Open report](${data.reportUrl})`,
  ].join('\n');
}
