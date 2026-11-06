import { object } from "./common.mjs";
import { repository_projects } from "./directory_context.mjs";
import { read_edt_launch, match_edt_projects } from "./edt_launch_adapter.mjs";
import { connection_failure, safe_error_message, sanitize_diagnostics } from "./diagnostics.mjs";

/**
 * @typedef {object} YaxunitCheck
 * @property {'yaxunit'} id
 * @property {'ready'|'disabled'|'missing_config'|'not_verified'|'error'|'check_stale'} state
 * @property {string} reasonCode Stable machine reason; prose is never a state identifier.
 * @property {string} title Safe status shown in the card and dialog.
 * @property {string} detail Safe explanation; technical errors live in diagnostic.
 * @property {{code:string, detail:string, includedInDetail:boolean}} nextStep
 * @property {Array<{name:string, projectName:string}>} choices Discovered client configurations only.
 * @property {{kind:'configuration'|'application', projectName:string, applicationId:string, launchConfigurationName?:string}} [target]
 * @property {object} [diagnostic] Redacted technical evidence, never the primary user explanation.
 * @property {string} [checkedAt]
 * @property {string} [expiresAt]
 */
const messages = {
  disabled: ["disabled", "Отключён", "Возможность отключена в профиле.", "enable", "Включите YaXUnit в профиле, если планируете запускать модульные тесты."],
  profile_missing: ["missing_config", "Профиль не настроен", "Не заданы настройки YaXUnit или связанные проекты EDT.", "configure_profile", "Заполните testing.yaxunit_config и назначения проектов EDT в профиле."],
  not_checked: ["not_verified", "Настройки запуска не проверены", "Проверьте настройки запуска YaXUnit через назначенное подключение EDT.", "retry", "Нажмите «Проверить настройки запуска»."],
  launch_required: ["not_verified", "Требуется настройка запуска", "В EDT не найдены конфигурации запуска и приложения для связанных проектов. Подключите тестовую информационную базу и настройте запуск в EDT, затем повторите проверку", "configure_edt", "Подключите тестовую информационную базу и настройте запуск в EDT, затем повторите проверку."],
  configuration_missing: ["not_verified", "Конфигурация запуска не найдена", "Указанная в профиле конфигурация запуска не найдена в EDT.", "select_configuration", "Выберите обнаруженную клиентскую конфигурацию в launch_configuration или восстановите указанную в EDT, сохраните профиль и повторите проверку."],
  configuration_project: ["not_verified", "Конфигурация другого проекта", "Конфигурация запуска относится к проекту, не связанному с YaXUnit в профиле.", "select_configuration", "Выберите клиентскую конфигурацию связанного проекта, сохраните профиль и повторите проверку."],
  configuration_type: ["not_verified", "Неподходящий тип конфигурации", "Для YaXUnit требуется клиентская конфигурация запуска EDT.", "select_configuration", "Выберите клиентскую конфигурацию запуска, сохраните профиль и повторите проверку."],
  target_unconfirmed: ["not_verified", "Требуется настройка запуска", "Связь клиентской конфигурации с доступным приложением EDT не подтверждена.", "configure_edt", "Проверьте проект и приложение в клиентской конфигурации запуска EDT, затем повторите проверку."],
  ambiguous: ["not_verified", "Выберите конфигурацию запуска", "В EDT найдено несколько вариантов запуска YaXUnit.", "select_configuration", "Выберите обнаруженную конфигурацию в поле launch_configuration, сохраните профиль и повторите проверку."],
  project_mismatch: ["not_verified", "Не совпадают проекты EDT", "Имена и точные пути связанных проектов не сопоставлены с EDT.", "check_projects", "Сверьте пути и назначения EDT в профиле и откройте нужные проекты в назначенной рабочей области EDT."],
  project_not_ready: ["not_verified", "Проекты EDT не готовы", "Связанные проекты закрыты, собираются или их готовность не подтверждена.", "check_projects", "Откройте связанные проекты в EDT, дождитесь завершения сборки и повторите проверку."],
  edt_unavailable: ["error", "EDT недоступен", "Не удалось подключиться к назначенному серверу EDT.", "check_connection", "Проверьте подключение EDT в настройках, доступность сервера и повторите проверку."],
  request_failed: ["error", "Ошибка запроса EDT", "EDT не смог вернуть сведения о настройках запуска.", "retry", "Проверьте доступность EDT и права подключения, затем повторите проверку. Сведения об ошибке находятся в диагностике."],
  timeout: ["error", "EDT не ответил вовремя", "Проверка настроек запуска превысила время ожидания.", "retry", "Дождитесь готовности EDT и повторите проверку."],
  api_unsupported: ["not_verified", "API не подтверждает настройки", "API назначенного EDT не позволяет подтвердить настройки запуска YaXUnit.", "check_api", "Проверьте доступность инструментов проектов, конфигураций, приложений и запуска YaXUnit в EDT MCP и повторите проверку."],
  unsupported_response: ["not_verified", "API не подтверждает настройки", "EDT вернул неподдерживаемую или неполную структуру сведений о запуске.", "check_api", "Проверьте совместимость версии EDT MCP с плагином, затем повторите проверку. Подробности находятся в диагностике."],
  api_limit: ["not_verified", "API не подтверждает настройки", "Число связанных проектов превышает лимит одной проверки.", "configure_profile", "Уточните связанные репозитории YaXUnit в профиле и повторите проверку."],
  check_stale: ["check_stale", "Проверка устарела", "Настройки, проект или подключение изменились либо срок проверки истёк.", "retry", "Повторите «Проверить настройки запуска» для текущего проекта и экземпляра."],
  launch_verified: ["ready", "Готово", "Настройки запуска YaXUnit проверены. Тесты этой проверкой не запускались", "none", ""],
};
/** @returns {YaxunitCheck} */
export function yaxunit_result(reasonCode, extra = {}) {
  const [state, title, detail, code, action] = messages[reasonCode];
  return { id: "yaxunit", state, reasonCode, title, detail, nextStep: { code, detail: action, includedInDetail: reasonCode === "launch_required" }, choices: [], ...extra };
}
export function yaxunit_unchecked(profile) {
  return yaxunit_result(profile.testing?.yaxunit !== true ? "disabled" : !object(profile.testing.yaxunit_config) ? "profile_missing" : "not_checked");
}

// Pure decision over validated adapter data. An explicit name never falls back.
export function evaluate_yaxunit_launch(settings, projects, evidence) {
  const { configurations, applications } = evidence, names = new Set(projects);
  const choices = configurations.filter(item => item.client && names.has(item.project)).map(item => ({ name: item.name, projectName: item.project }));
  const result = (code, extra) => yaxunit_result(code, { choices, ...extra });
  const targetFor = (configuration, allowDefault = false) => {
    const apps = applications.find(item => item.projectName === configuration.project);
    if (!apps || !names.has(apps.owner)) return null;
    const id = configuration.applicationId && !/^(?:launch|attach):/.test(configuration.applicationId)
      ? configuration.applicationId : allowDefault ? apps.defaultId : null;
    return id && apps.applications.some(item => item.id === id) ? { projectName: configuration.project, applicationId: id, launchConfigurationName: configuration.name } : null;
  };
  if (settings.launch_configuration) {
    const selected = configurations.find(item => item.name === settings.launch_configuration);
    if (!selected) return result("configuration_missing");
    if (!selected.client) return result("configuration_type");
    if (!selected.project) return result("target_unconfirmed");
    if (!names.has(selected.project)) return result("configuration_project");
    const target = targetFor(selected, true);
    if (!target) return result("target_unconfirmed");
    evidence.supports({ launchConfigurationName: selected.name });
    return result("launch_verified", { target: { ...target, kind: "configuration" } });
  }
  if (applications.some(item => !names.has(item.owner))) return result("target_unconfirmed");
  const candidates = choices.map(choice => targetFor(configurations.find(item => item.name === choice.name))).filter(Boolean);
  if (choices.length > 1 || applications.some(item => item.applications.length > 1) && !candidates.length) return result("ambiguous");
  if (configurations.some(item => item.client && !item.project)) return result("target_unconfirmed");
  if (candidates.length === 1) {
    const { projectName, applicationId } = candidates[0];
    evidence.supports({ projectName, applicationId });
    return result("launch_verified", { target: { kind: "application", projectName, applicationId } });
  }
  if (!choices.length && applications.every(item => !item.applications.length) && !configurations.some(item => names.has(item.project))) return result("launch_required");
  return result("target_unconfirmed");
}

export async function probe_yaxunit(config, root, profile, session = null) {
  const initial = yaxunit_unchecked(profile);
  if (initial.reasonCode !== "not_checked") return initial;
  const settings = profile.testing.yaxunit_config;
  const ids = new Set([settings.repository_id, settings.framework_repository_id, ...(settings.product_repository_ids || [])].filter(Boolean));
  const repositories = profile.repositories.filter(item => ids.has(item.id));
  if (repositories.length !== ids.size || !repositories.length || repositories.some(item => !item.edt_project || profile.policy?.unbound_edt_repositories?.includes(item.id))) return yaxunit_result("profile_missing");
  const options = config.mcp.required.edt;
  if (!options?.url || options.enabled === false) return yaxunit_result("edt_unavailable");
  try {
    const local = repository_projects(root, repositories), names = [...new Set(repositories.map(item => item.edt_project))];
    const evidence = await read_edt_launch(options, names, projects => {
      const matches = match_edt_projects(local, projects);
      if (matches.some(item => !item.matched)) return "project_mismatch";
      if (matches.some(item => !item.ready)) return "project_not_ready";
      return null;
    }, session);
    return evidence.projectIssue ? yaxunit_result(evidence.projectIssue) : evaluate_yaxunit_launch(settings, names, evidence);
  } catch (error) {
    return yaxunit_result(Object.hasOwn(messages, error.code) ? error.code : "request_failed", {
      diagnostic: sanitize_diagnostics({ tool: error.tool, failure: connection_failure(error.cause || error), detail: safe_error_message(error.cause || error) }),
    });
  }
}
