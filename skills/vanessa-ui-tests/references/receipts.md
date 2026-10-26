# Receipt and result correlation

A receipt contains `schemaVersion: 1`, `featurePath`, `featureSha256`, `scenario`,
`startedAt`, `finishedAt`, `runtime` with actually observed platform/Vanessa/MCP
versions (unknown values are null), `syntaxStatus`, `fromBeginning`, `status`
and this run's `resultsFile`. Exclude credentials and connection strings.

The bundled CLI saves reports and receipts on completed chains and transport/tool
errors after dispatch in unique files under `results`. Its status is deliberately
`unverified`: successful tools/call does not imply business pass.
Timeouts retain the submitted tool and unknown outcome; explicit `isError` remains
`tool_error/responded` with the original response. For pre-dispatch refusals and
other blocks retain latest reports/job/state separately; absent receipts or
unfinished runs do not create passing outcomes.

Before `passed`, match actual results to exact scenario/file, current run time
and executable hash; check terminal completion, no errors, skips or mid-scenario
execution. The full runtime response supplies outcome, not receipt self-description.
If runtime provides insufficient correlation, retain unverified status and state
the missing fact. Save verified outcome/evidence beside the receipt;
post-run feature fixes require a new run/hash.
