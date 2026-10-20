# Receipt и корреляция результата

Receipt содержит `schemaVersion: 1`, `featurePath`, `featureSha256`, `scenario`,
`startedAt`, `finishedAt`, `runtime` с реально наблюдёнными platform/Vanessa/MCP
версиями (неизвестные — null), `syntaxStatus`, `fromBeginning`, `status` и
`resultsFile` этого запуска. Не включай credentials и строки подключения.

Bundled CLI сохраняет reports и receipt при completed chain, а также при
transport/tool error после dispatch, в уникальные файлы под `results`. Его status
намеренно `unverified`: он не выводит business pass из успешного tools/call.
При timeout сохраняются отправленный tool и неопределённый outcome; явный
`isError` остаётся `tool_error/responded` с исходным ответом. Для отказов до
dispatch и прочих блокировок сохрани последние reports/job/state отдельно;
отсутствие receipt или незавершённый run не создаёт passing outcome.

Перед `passed` сопоставь фактические results с точным scenario/file, временем
текущего запуска и исполняемым hash, проверь terminal completion, отсутствие
ошибок, пропуска и сценариев с середины. Источником outcome служит полный ответ
runtime, не самоописание receipt. Если runtime не даёт достаточной корреляции,
оставь unverified и укажи недостающий факт. Сохрани проверенное outcome/evidence
рядом с receipt; исправления feature после run требуют нового запуска/хеша.
